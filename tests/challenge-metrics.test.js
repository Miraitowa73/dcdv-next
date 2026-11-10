'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createTracker } = require('../cloud-test/challenge-metrics');
const { summarize } = require('../cloud-account/progress-summary');
function fixture(state = { completed: {}, metrics: {} }) {
  let clock = 0;
  return { state, advance(ms) { clock += ms; }, tracker: createTracker({ getState: () => state, now: () => clock, wallNow: () => 1794268800000 }) };
}
test('study time pauses outside the level, survives device reload, and freezes at first pass', () => {
  const f = fixture(); const key = 'stairs:truth';
  f.tracker.sync(key, true); f.advance(12000); f.tracker.sync(key, false);
  f.advance(300000); f.tracker.sync(key, true); f.advance(8000); f.tracker.record(key, false); f.tracker.pause();
  assert.equal(f.state.metrics[key].elapsedMs, 20000); assert.equal(f.state.metrics[key].errors, 1);
  const second = fixture(JSON.parse(JSON.stringify(f.state)));
  second.tracker.sync(key, true); second.advance(10000); second.tracker.record(key, true); second.state.completed[key] = true;
  second.advance(30000); second.tracker.sync(key, true); second.tracker.record(key, false);
  assert.equal(second.state.metrics[key].elapsedMs, 30000); assert.equal(second.state.metrics[key].errors, 1);
  assert.ok(second.state.metrics[key].completedAt);
});
test('switches allocate time to the right level and sleep gaps are not study time', () => {
  const f = fixture(); f.tracker.sync('stairs:truth', true); f.advance(2000); f.tracker.sync('stairs:expr', true);
  f.advance(3000); f.tracker.checkpoint(); f.advance(3600000); f.tracker.checkpoint();
  assert.equal(f.state.metrics['stairs:truth'].elapsedMs, 2000); assert.equal(f.state.metrics['stairs:expr'].elapsedMs, 3000);
  f.tracker.reset(); f.advance(10000); f.tracker.sync('stairs:truth', true);
  assert.equal(f.state.metrics['stairs:truth'].elapsedMs, 2000);
});
test('legacy progress stays unknown or partial; zero is reserved for measured attempts', () => {
  const f = fixture({ completed: { 'stairs:truth': true }, practice: { 'stairs:expr': { expression: 'A' } } });
  f.tracker.sync('stairs:truth', true); f.tracker.record('stairs:truth', false);
  f.tracker.sync('stairs:expr', true);
  assert.equal(f.state.metrics['stairs:truth'], undefined); assert.equal(f.state.metrics['stairs:expr'].partial, true);
  const summary = summarize(f.state);
  assert.equal(summary.levels[0].errorCount, null); assert.equal(summary.completionTimeMs, null);
  assert.equal(summary.errorCount, 0); assert.equal(summary.errorsPartial, true);
});
test('new page scaffolding does not turn a newly started level into legacy partial data', () => {
  const f = fixture();
  f.state.practice = { 'stairs:truth': {} };
  f.tracker.sync('stairs:truth', true);
  assert.equal(f.state.metrics['stairs:truth'].partial, false);
});
test('summary totals only catalog metrics, preserves missing coverage, and never exposes extra data', () => {
  const metric = { version: 1, elapsedMs: 123000, errors: 2, partial: false, completedAt: '2026-11-10T01:00:00.000Z', secret: 'PRIVATE' };
  const summary = summarize({ completed: { 'stairs:truth': true, 'stairs:expr': true }, metrics: { 'stairs:truth': metric, fabricated: metric, 'stairs:build': { ...metric, elapsedMs: -1 } } });
  assert.equal(summary.completionTimeMs, 123000); assert.equal(summary.completionTimeRecorded, 1);
  assert.equal(summary.completionTimePartial, true); assert.equal(summary.errorCount, 2); assert.equal(summary.errorsPartial, true);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|secret|fabricated/);
});
const html = fs.readFileSync(require('node:path').join(__dirname, '../cloud-test/index.html'), 'utf8');
function gradeFixture() {
  const f = fixture(); const key = 'stairs:hdl'; f.tracker.sync(key, true);
  const context = vm.createContext({ currentDcdvUser: { id: 'fake' }, progressOperationBusy: false, challengeGradeInFlight: false,
    challengeState: { ...f.state, results: {} }, challengeMetrics: f.tracker,
    getActiveChallenge: () => ({ group: { id: 'stairs' }, level: { id: 'hdl', buildMode: 'hdl' } }),
    getChallengeLevelKey: (group, level) => `${group}:${level}`, getChallengeSourceCode: () => 'module custom_logic; endmodule',
    compiledDesign: { backend: { toolchain: { ok: true } } }, refreshBackendHealth: async () => {},
    compileChallengeHdl: async () => ({ ok: true }), getChallengeSimulationTopModule: () => 'custom_logic',
    callLocalApi: async () => ({ ok: true, outputs: [] }), buildChallengeSignals: () => [], compareChallengeOutputs: () => ['wrong'],
    saveChallengeProgress() {}, renderChallengeTab() {}, renderChallengeStrip() {}, showToast() {}, getBackendConnectionMessage: () => 'offline'
  });
  vm.runInContext(html.slice(html.indexOf('        async function gradeCurrentChallenge()'), html.indexOf('        function readUiBool(')), context);
  return { ...f, context, key };
}
test('each failed submission counts once; compile checks and service failures do not create extra errors', async () => {
  const f = gradeFixture(); await f.context.gradeCurrentChallenge(); assert.equal(f.state.metrics[f.key].errors, 1);
  f.context.compileChallengeHdl = async () => ({ ok: false, message: 'syntax error' });
  await f.context.gradeCurrentChallenge(); assert.equal(f.state.metrics[f.key].errors, 2);
  f.context.compileChallengeHdl = async () => ({ ok: false, serviceError: true });
  await f.context.gradeCurrentChallenge(); assert.equal(f.state.metrics[f.key].errors, 2);
  f.context.compileChallengeHdl = async () => ({ ok: true });
  f.context.callLocalApi = async () => ({ ok: false, serviceError: true });
  await f.context.gradeCurrentChallenge(); assert.equal(f.state.metrics[f.key].errors, 2);
  f.context.callLocalApi = async () => { throw new Error('network'); };
  await f.context.gradeCurrentChallenge(); assert.equal(f.state.metrics[f.key].errors, 2);
});
test('duplicate clicks during grading produce one result and first-pass stats remain fixed', async () => {
  const f = gradeFixture(); let resolve;
  f.context.callLocalApi = () => new Promise(done => { resolve = done; });
  const pending = f.context.gradeCurrentChallenge();
  await new Promise(done => setImmediate(done)); await f.context.gradeCurrentChallenge();
  resolve({ ok: true, outputs: [] }); await pending;
  assert.equal(f.state.metrics[f.key].errors, 1);
  f.context.callLocalApi = async () => ({ ok: true, outputs: [] }); f.context.compareChallengeOutputs = () => [];
  f.advance(3000); await f.context.gradeCurrentChallenge();
  assert.equal(f.state.metrics[f.key].elapsedMs, 3000); assert.ok(f.state.metrics[f.key].completedAt);
  f.context.compareChallengeOutputs = () => ['wrong']; f.advance(4000); await f.context.gradeCurrentChallenge();
  assert.equal(f.state.metrics[f.key].errors, 1); assert.equal(f.state.metrics[f.key].elapsedMs, 3000);
});
