const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'DCDV.html'), 'utf8');
function sourceFunction(name) {
  const source = html.match(new RegExp(`^        function ${name}\\([^]*?^        }`, 'm'));
  assert.ok(source, `Missing function ${name}`);
  return source[0];
}

function fixture(type = 'AND', count = 3) {
  const inputs = Array.from({ length: count }, (_, i) => ({ id: i + 1, type: 'IN', label: `I${i}` }));
  const gate = { id: 20, type, label: type, params: { inputCount: count } };
  const output = { id: 21, type: 'OUT', label: 'Y' };
  const schState = {
    components: [...inputs, gate, output],
    wires: inputs.map((input, i) => ({
      id: i + 1, from: { compId: input.id, pinId: 'Y' }, to: { compId: gate.id, pinId: String.fromCharCode(65 + i) },
    })).concat({ id: 20, from: { compId: gate.id, pinId: 'Y' }, to: { compId: output.id, pinId: 'A' } }),
    selectedWire: null, pendingPin: null,
  };
  const effects = { invalidated: 0, persisted: 0, synced: 0, previewCleared: 0, rendered: 0 };
  const context = vm.createContext({
    schState,
    currentConfigComp: gate,
    document: { getElementById: () => ({ value: '3', focus() {}, classList: { add() {}, remove() {} } }) },
    clearSchematicPreview: () => effects.previewCleared++,
    invalidateCompiledDesign: () => effects.invalidated++,
    persistChallengeSchematicDraft: () => effects.persisted++,
    autoSyncHdlMode: () => effects.synced++,
    renderSch: () => effects.rendered++,
    showToast() {},
    syncWaveData() {},
    useCompiledVerilogWaveModel: () => false,
    renderWaveformUI() {},
    activeDefineModeName: '电路原理图',
    waveData: { steps: 0, signals: [] },
  });
  const baseStart = html.indexOf('        const baseGateSpecs =');
  const baseEnd = html.indexOf('        function getGateSpec', baseStart);
  vm.runInContext(html.slice(baseStart, baseEnd), context);
  const names = ['getGateSpec', 'isVariableInputGate', 'isConfigurableComponent', 'getGateInputCount',
    'evaluateVariableInputGate', 'setGateInputCount', 'solveSchematic', 'getCounterBitWidth',
    'buildSchNetMap', 'resolveSchExpr', 'generateSchStructuralVerilog', 'generateSchDataflowVerilog',
    'generateSchBehavioralVerilog', 'evaluateSimulation', 'cloneSchematicDraft', 'restoreSchematicDraft',
    'saveParamModal', 'closeParamModal'];
  vm.runInContext(names.map(sourceFunction).join('\n'), context);
  return { context, gate, schState, effects };
}

test('legacy two-input gates keep their pin IDs and geometry; new pins are evenly spaced', () => {
  const { context } = fixture();
  for (const type of ['AND', 'OR']) {
    const spec = context.getGateSpec({ type });
    assert.equal(spec.w, 60);
    assert.equal(spec.h, 40);
    assert.equal(JSON.stringify(spec.pins.map(p => [p.id, p.y])), JSON.stringify([['A', .25], ['B', .75], ['Y', .5]]));
    const expanded = context.getGateSpec({ type, params: { inputCount: 8 } });
    assert.equal(expanded.pins.length, 9);
    assert.equal(expanded.h, 160);
    assert.equal(expanded.pins[7].id, 'H');
    assert.equal(context.isConfigurableComponent({ type }), true);
  }
  assert.equal(context.isConfigurableComponent({ type: 'XOR' }), false);
});

test('every input affects truth tables and waveform previews for 2, 3 and 8 input gates', () => {
  for (const type of ['AND', 'OR']) for (const count of [2, 3, 8]) {
    const { context } = fixture(type, count);
    const values = Array.from({ length: 1 << count }, (_, value) => value);
    context.waveData = {
      steps: values.length,
      signals: Array.from({ length: count }, (_, i) => ({
        name: `I${i}`, kind: 'in', values: values.map(value => (value >> i) & 1),
      })).concat({ name: 'Y', kind: 'out', values: [] }),
    };
    context.evaluateSimulation();
    for (const value of values) {
      const env = Object.fromEntries(Array.from({ length: count }, (_, i) => [`I${i}`, (value >> i) & 1]));
      const expected = type === 'AND' ? Number(value === (1 << count) - 1) : Number(value !== 0);
      assert.equal(context.solveSchematic(env).outVals.Y, expected, `${type}/${count}/${value}`);
      assert.equal(context.waveData.signals[count].values[value], expected);
    }
  }
});

test('all HDL styles include every configured input', () => {
  for (const type of ['AND', 'OR']) {
    const { context } = fixture(type, 3);
    const operator = type === 'AND' ? '&' : '|';
    const expression = `(I0 ${operator} I1 ${operator} I2)`;
    assert.ok(context.generateSchStructuralVerilog().includes(`${type.toLowerCase()} U20 (w_20_Y, I0, I1, I2);`));
    assert.ok(context.generateSchDataflowVerilog().includes(`assign Y = ${expression};`));
    assert.ok(context.generateSchBehavioralVerilog().includes(`Y = ${expression};`));
  }
});

test('expanding preserves wires and shrinking removes only deleted pins in either wire direction', () => {
  const { context, gate, schState, effects } = fixture('OR', 3);
  const third = schState.wires[2];
  [third.from, third.to] = [third.to, third.from];
  const original = JSON.stringify(schState.wires);
  context.setGateInputCount(gate, 8);
  assert.equal(JSON.stringify(schState.wires), original);
  schState.pendingPin = { compId: gate.id, pinId: 'H' };
  schState.selectedWire = third.id;
  context.setGateInputCount(gate, 2);
  assert.equal(JSON.stringify(schState.wires.map(w => w.id)), '[1,2,20]');
  assert.equal(schState.pendingPin, null);
  assert.equal(schState.selectedWire, null);
  assert.equal(effects.previewCleared, 1);
  assert.equal(effects.invalidated, 2);
  assert.equal(effects.persisted, 2);
  assert.equal(effects.synced, 2);
  assert.equal(context.solveSchematic({ I0: 0, I1: 0, I2: 1 }).outVals.Y, 0);
});

test('invalid counts and unchanged saves do not mutate the circuit', () => {
  const { context, gate, schState, effects } = fixture();
  const original = JSON.stringify(schState);
  for (const value of ['', '1', '9', '2.5', 'abc']) {
    context.document.getElementById = () => ({ value, focus() {} });
    context.saveParamModal();
    assert.equal(context.currentConfigComp, gate);
    assert.equal(JSON.stringify(schState), original);
  }
  assert.equal(context.setGateInputCount(gate, 3), false);
  assert.equal(effects.invalidated, 0);
});

test('gate input counts and wires survive challenge draft save and restore', () => {
  const { context, gate, schState } = fixture();
  context.setGateInputCount(gate, 5);
  const draft = context.cloneSchematicDraft();
  schState.components = [];
  schState.wires = [];
  context.restoreSchematicDraft(draft);
  assert.equal(context.getGateSpec(schState.components.find(c => c.type === 'AND')).pins.length, 6);
  assert.equal(schState.wires.length, 4);
});

test('all inline app scripts remain syntactically valid', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
