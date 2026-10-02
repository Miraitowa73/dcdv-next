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

function fixture(challenge = false, loop = false) {
  const createElement = () => ({
    attributes: {}, dataset: {}, children: [], innerHTML: '',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); },
  });
  const surface = {
    clientWidth: 600, clientHeight: 400, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 100, top: 80, width: 1200, height: 800 }),
    classList: { add() {}, remove() {} },
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
  };
  const fsmData = {
    states: [{ id: 1, label: 'S0', x: 180, y: 180 }, { id: 2, label: 'S1', x: 380, y: 180 }],
    transitions: [
      { id: 1, from: 1, to: loop ? 1 : 2, label: '0/0' },
      { id: 2, from: 2, to: 1, label: '0/0' },
    ], selectedState: 1, selectedTrans: null, pendingStart: 1, presetKey: 'demo',
  };
  const challengeFsmData = JSON.parse(JSON.stringify(fsmData));
  const data = challenge ? challengeFsmData : fsmData;
  const elements = {
    'fsm-surface': surface, 'challenge-fsm-surface': surface,
    'fsm-preview': createElement(), 'challenge-fsm-preview': createElement(),
  };
  const effects = { saved: 0, renders: 0 };
  const context = vm.createContext({
    fsmData, challengeFsmData,
    document: { createElementNS: createElement, getElementById: id => elements[id] },
    renderFsm: () => effects.renders++, renderChallengeFsm: () => effects.renders++,
    renderFsmWires() {}, renderChallengeFsmWires() {},
    saveActiveChallengeFsmDraft: () => effects.saved++,
  });
  vm.runInContext('let fsmLabelDrag = null;\n' + [
    'getFsmPath', 'getFsmLabelPosition', 'getFsmSurfacePoint', 'appendFsmTransitionLabel',
    'moveFsmTransitionLabel', 'finishFsmTransitionLabelDrag', 'safeReleasePointerCapture',
    'isPrimaryPointerStillDown', 'cloneChallengeFsmDraft', 'restoreChallengeFsmDraft',
  ].map(sourceFunction).join('\n'), context);
  const trans = data.transitions[0];
  const geometry = () => context.getFsmPath(data.states[0], data.states[loop ? 0 : 1]);
  const eventAt = (x, y, extra = {}) => ({
    clientX: 100 + x * 2, clientY: 80 + y * 2,
    pointerId: 7, button: 0, buttons: 1, preventDefault() {}, stopPropagation() {}, ...extra,
  });
  const begin = (extra = {}) => {
    const layer = createElement();
    context.appendFsmTransitionLabel(layer, trans, geometry(), data);
    const pos = context.getFsmLabelPosition(trans, geometry());
    layer.children[0].onpointerdown(eventAt(pos.x + 5, pos.y + 2, extra));
    return pos;
  };
  return { context, data, trans, geometry, eventAt, begin, surface, effects };
}

test('dragging a label preserves its text and endpoints and only moves that transition', () => {
  for (const challenge of [false, true]) for (const loop of [false, true]) {
    const f = fixture(challenge, loop);
    const before = JSON.stringify(f.data.transitions);
    const p = f.begin();
    assert.equal(f.data.selectedTrans, 1);
    assert.equal(f.data.selectedState, null);
    assert.equal(f.data.pendingStart, null);
    assert.equal(f.surface.captured, 7);
    f.context.moveFsmTransitionLabel(f.eventAt(p.x + 45, p.y - 28), f.data);
    assert.deepEqual(JSON.parse(JSON.stringify(f.trans.labelOffset)), { x: 40, y: -30 });
    assert.equal(JSON.stringify(f.data.transitions.map(({ labelOffset, ...trans }) => trans)), before);
    assert.equal(f.data.presetKey, 'demo');
    f.context.finishFsmTransitionLabelDrag();
    assert.equal(f.surface.captured, null);
    assert.equal(f.effects.saved, challenge ? 1 : 0);
  }
});

test('clicks and other pointers do not move labels or write a draft', () => {
  const f = fixture(true);
  const p = f.begin();
  f.context.moveFsmTransitionLabel(f.eventAt(p.x + 6, p.y + 3), f.data);
  f.context.moveFsmTransitionLabel(f.eventAt(p.x + 80, p.y + 80, { pointerId: 99 }), f.data);
  assert.equal(f.trans.labelOffset, undefined);
  f.context.finishFsmTransitionLabelDrag();
  assert.equal(f.effects.saved, 0);
});

test('labels stay inside the canvas when a captured pointer leaves it', () => {
  const f = fixture();
  f.begin();
  f.context.moveFsmTransitionLabel(f.eventAt(-500, -500), f.data);
  let p = f.context.getFsmLabelPosition(f.trans, f.geometry());
  assert.equal(p.x, 18);
  assert.equal(p.y, 12);
  f.context.moveFsmTransitionLabel(f.eventAt(2000, 2000), f.data);
  p = f.context.getFsmLabelPosition(f.trans, f.geometry());
  assert.equal(p.x, 582);
  assert.equal(p.y, 392);
});

test('release or cancellation finishes the drag once and stops further movement', () => {
  const f = fixture(true);
  const p = f.begin();
  f.context.moveFsmTransitionLabel(f.eventAt(p.x + 45, p.y + 2), f.data);
  const savedOffset = JSON.stringify(f.trans.labelOffset);
  f.context.moveFsmTransitionLabel(f.eventAt(p.x + 80, p.y + 80, { buttons: 0 }), f.data);
  f.context.finishFsmTransitionLabelDrag();
  assert.equal(f.effects.saved, 1);
  assert.equal(f.surface.captured, null);
  assert.equal(f.context.moveFsmTransitionLabel(f.eventAt(500, 300), f.data), false);
  assert.equal(JSON.stringify(f.trans.labelOffset), savedOffset);
});

test('custom offsets follow moving states and survive challenge draft save/restore', () => {
  const f = fixture(true, true);
  const p = f.begin();
  f.context.moveFsmTransitionLabel(f.eventAt(p.x + 45, p.y + 22), f.data);
  f.context.finishFsmTransitionLabelDrag();
  const beforeMove = f.context.getFsmLabelPosition(f.trans, f.geometry());
  f.data.states[0].x += 70;
  f.data.states[0].y += 60;
  const afterMove = f.context.getFsmLabelPosition(f.trans, f.geometry());
  assert.equal(afterMove.x - beforeMove.x, 70);
  assert.equal(afterMove.y - beforeMove.y, 60);
  const draft = f.context.cloneChallengeFsmDraft();
  f.data.transitions = [];
  f.context.restoreChallengeFsmDraft(draft);
  assert.deepEqual(JSON.parse(JSON.stringify(f.data.transitions[0].labelOffset)), { x: 40, y: 20 });
  const geom = f.geometry();
  const legacy = f.context.getFsmLabelPosition({}, geom);
  assert.equal(legacy.x, geom.lx);
  assert.equal(legacy.y, geom.ly);
});
