const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const auth = require('../auth-local');

test('usernames are normalized and validated without losing display form', () => {
  assert.equal(auth.normalizeUsername('  Alice_01  '), 'alice_01');
  assert.equal(auth.normalizeUsername(' 学生甲 '), '学生甲');
  assert.deepEqual(auth.validateUsername('A'), {
    ok: false,
    message: '用户名长度需为 2-24 个字符。',
  });
  assert.equal(auth.validateUsername('测试-01').ok, true);
  assert.equal(auth.validateUsername('bad name').ok, false);
});

test('password validation enforces the local profile policy', () => {
  assert.equal(auth.validatePassword('short').ok, false);
  assert.equal(auth.validatePassword('correct-horse').ok, true);
  assert.equal(auth.validatePassword('x'.repeat(73)).ok, false);
});

test('PBKDF2 hashes are deterministic for one salt and reject other passwords', async () => {
  const salt = new Uint8Array(16).fill(7);
  const first = await auth.derivePasswordHash('correct-horse', salt, 1000);
  const second = await auth.derivePasswordHash('correct-horse', salt, 1000);
  const wrong = await auth.derivePasswordHash('wrong-password', salt, 1000);
  assert.equal(first.length, 32);
  assert.equal(auth.constantTimeEqual(first, second), true);
  assert.equal(auth.constantTimeEqual(first, wrong), false);
  assert.equal(auth.constantTimeEqual(first, new Uint8Array(31)), false);
});

test('binary account fields round-trip through base64', () => {
  const original = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  const encoded = auth.bytesToBase64(original);
  assert.deepEqual(Array.from(auth.base64ToBytes(encoded)), Array.from(original));
});

test('progress exports contain learning state but no credential fields', () => {
  const payload = auth.createProgressExport(
    { username: '学生甲', passwordHash: 'must-not-leak' },
    { completed: { 'stairs:truth': true }, hints: {} }
  );
  assert.equal(payload.kind, 'dcdv-next-progress');
  assert.equal(payload.version, 1);
  assert.equal(payload.user.username, '学生甲');
  assert.equal(JSON.stringify(payload).includes('must-not-leak'), false);
  assert.deepEqual(auth.validateProgressExport(payload), payload.progress);
  assert.throws(() => auth.validateProgressExport({ kind: 'other', version: 1 }), /不是 DCDV NEXT/);
  assert.throws(() => auth.validateProgressExport({ kind: 'dcdv-next-progress', version: 2 }), /暂不支持/);
});
