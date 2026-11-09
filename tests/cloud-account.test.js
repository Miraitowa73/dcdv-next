const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountService, SESSION_MS, MAX_PROGRESS_BYTES } = require('../cloud-account/service');
const { createHandler } = require('../cloud-account/index');
const { memoryStore } = require('./helpers/account-store');

function fixture(options = {}) {
  const store = options.store || memoryStore();
  const service = createAccountService({ store, ...options });
  const call = async (path, data, token, extra = {}) => {
    const response = await service({ method: data === undefined ? 'GET' : 'POST', path: `/api/account/${path}`, body: data === undefined ? '' : JSON.stringify(data), headers: { 'Content-Type': 'application/json', Origin: 'https://miraitowa73.github.io', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra.headers }, sourceIp: 'test-ip', ...extra });
    return { ...response, data: response.body ? JSON.parse(response.body) : null };
  };
  const register = (username = 'Student') => call('register', { username, password: 'student-test-password' });
  return { store, service, call, register };
}

test('cloud registration salts hashes, stores only token digests, and exposes only public identity', async () => {
  const { store, register, call } = fixture();
  const a = await register();
  const b = await register('Student2');
  assert.equal(a.statusCode, 201);
  const ua = (await store.get('users', 'student')).value;
  const ub = (await store.get('users', 'student2')).value;
  assert.equal(ua.passwordAlgorithm, 'scrypt-N32768-r8-p1');
  assert.notEqual(ua.passwordHash, ub.passwordHash);
  assert.notEqual(ua.salt, ub.salt);
  const stored = JSON.stringify([...store.rows]);
  assert.ok(!stored.includes('student-test-password'));
  assert.ok(!stored.includes(a.data.token));
  assert.deepEqual(Object.keys(a.data.user).sort(), ['createdAt', 'displayName', 'id', 'mustChangePassword', 'role', 'studentNumber', 'username']);
  const me = await call('me', undefined, a.data.token);
  assert.equal(me.data.user.id, ua.id);
  assert.ok(!me.body.includes('password'));
});

test('normalized names are unique even for simultaneous registrations', async () => {
  const { register, call } = fixture();
  const results = await Promise.all([register('Ａlice01'), register('alice01')]);
  assert.deepEqual(results.map(r => r.statusCode).sort(), [201, 409]);
  const login = await call('login', { username: 'ALICE01', password: 'student-test-password' });
  assert.equal(login.statusCode, 200);
});

test('wrong or missing users return the same authentication error', async () => {
  const { register, call } = fixture();
  await register();
  const wrong = await call('login', { username: 'Student', password: 'wrong-password' });
  const absent = await call('login', { username: 'Missing', password: 'wrong-password' });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.data, absent.data);
});

test('sessions expire on the server and logout revokes one device only', async () => {
  let time = Date.now();
  const { call, register } = fixture({ now: () => time });
  const one = (await register()).data;
  const two = (await call('login', { username: 'Student', password: 'student-test-password' })).data;
  assert.equal((await call('logout', {}, one.token)).statusCode, 200);
  assert.equal((await call('me', undefined, one.token)).statusCode, 401);
  assert.equal((await call('me', undefined, two.token)).statusCode, 200);
  time += SESSION_MS + 1;
  assert.equal((await call('me', undefined, two.token)).statusCode, 401);
  assert.equal((await call('progress')).statusCode, 401);
});

test('progress follows the authenticated account, never a caller-provided user id', async () => {
  const { call, register } = fixture();
  const a = (await register()).data;
  const b = (await register('Another')).data;
  const saved = await call('progress', { userId: b.user.id, state: { completed: { gate: true } }, revision: null }, a.token, { method: 'PUT' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual((await call('progress', undefined, a.token)).data.state.completed, { gate: true });
  assert.equal((await call('progress', undefined, b.token)).data.state, null);
});

test('two writers cannot overwrite each other and stale revisions remain rejected', async () => {
  const { call, register } = fixture();
  const { token } = (await register()).data;
  const update = completed => call('progress', { state: { completed }, revision: null }, token, { method: 'PUT' });
  const [a, b] = await Promise.all([update({ first: true }), update({ second: true })]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
  assert.equal((await update({ stale: true })).data.error.code, 'PROGRESS_CONFLICT');
  const current = (await call('progress', undefined, token)).data;
  assert.equal((await call('progress', { revision: current.revision, state: { completed: { newer: true } } }, token, { method: 'PUT' })).statusCode, 200);
});

test('legacy progress is committed atomically with registration, no hashes accepted from clients', async () => {
  const { call, store } = fixture();
  const state = { completed: { migrated: true }, practice: { gate: { code: 'assign y=a&b;' } } };
  const created = await call('register', { username: 'Migrated', password: 'migration-password', passwordHash: 'untrusted-client-hash', progress: state });
  assert.equal(created.statusCode, 201);
  assert.deepEqual((await call('progress', undefined, created.data.token)).data.state, state);
  assert.notEqual((await store.get('users', 'migrated')).value.passwordHash, 'untrusted-client-hash');
  const updated = { completed: { migrated: true, next: true } };
  assert.equal((await call('progress', { state: updated, revision: null }, created.data.token, { method: 'PUT' })).statusCode, 200);
  assert.equal((await store.get('users', 'migrated')).value.initialProgress, null);
  const login = await call('login', { username: 'Migrated', password: 'migration-password' });
  assert.deepEqual((await call('progress', undefined, login.data.token)).data.state, updated);
});

test('optional migration-copy cleanup cannot lose progress or report a committed save as failed', async () => {
  const { call, store } = fixture();
  const initial = { completed: { migrated: true } };
  const { token } = (await call('register', { username: 'Cleanup', password: 'migration-password', progress: initial })).data;
  const realPut = store.put;
  store.put = async (table, ...args) => {
    if (table === 'progress') return false;
    return realPut(table, ...args);
  };
  const update = { completed: { next: true } };
  assert.equal((await call('progress', { state: update, revision: null }, token, { method: 'PUT' })).statusCode, 409);
  assert.deepEqual((await call('progress', undefined, token)).data.state, initial);
  store.put = async (table, ...args) => {
    if (table === 'users') throw new Error('cleanup temporarily unavailable');
    return realPut(table, ...args);
  };
  const saved = await call('progress', { state: update, revision: null }, token, { method: 'PUT' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual((await call('progress', undefined, token)).data.state, update);
  store.put = realPut;
  assert.equal((await call('progress', { state: update, revision: saved.data.revision }, token, { method: 'PUT' })).statusCode, 200);
  assert.equal((await store.get('users', 'cleanup')).value.initialProgress, null);
});

test('limits are durable across different service instances', async () => {
  const store = memoryStore();
  const first = fixture({ store, limits: { 'auth-ip': 1 } });
  const second = fixture({ store, limits: { 'auth-ip': 1 } });
  assert.equal((await first.register()).statusCode, 201);
  const denied = await second.register('Another');
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.headers['Retry-After'], '60');
});

test('strict CORS and JSON input handling reject untrusted or malformed requests', async () => {
  const { call, register } = fixture();
  assert.equal((await call('health', undefined, undefined, { headers: { Origin: 'https://untrusted.example' } })).statusCode, 403);
  const preflight = await call('login', undefined, undefined, { method: 'OPTIONS' });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://miraitowa73.github.io');
  assert.equal((await call('login', {}, undefined, { body: '{' })).statusCode, 400);
  assert.equal((await call('login', {}, undefined, { headers: { 'Content-Type': 'text/plain' } })).statusCode, 415);
  const { token } = (await register()).data;
  const badState = JSON.parse('{"completed":{"__proto__":{"polluted":true}}}');
  assert.equal((await call('progress', { state: badState, revision: null }, token, { method: 'PUT' })).statusCode, 400);
  assert.equal((await call('progress', { state: { completed: {} } }, token, { method: 'PUT' })).statusCode, 400);
  assert.equal((await call('progress', { state: { practice: { text: 'x'.repeat(MAX_PROGRESS_BYTES + 5000) } }, revision: null }, token, { method: 'PUT' })).statusCode, 413);
});

test('database failures are redacted and never fall back to local storage', async () => {
  const { call } = fixture({ store: { get() { throw new Error('secret-access-key-example'); } } });
  const result = await call('health');
  assert.equal(result.statusCode, 503);
  assert.ok(!result.body.includes('secret-access-key'));
});

test('real FC event envelope handles mixed-case headers, base64 and per-request role credentials', async () => {
  const store = memoryStore();
  const seenCredentials = [];
  const handler = createHandler({ storeFactory(options) { seenCredentials.push(options.credentials); return store; } });
  const request = { rawPath: '/api/account/register', body: Buffer.from(JSON.stringify({ username: 'FCUser', password: 'fc-test-password' })).toString('base64'), isBase64Encoded: true, headers: { 'Content-Type': 'application/json', Origin: 'https://miraitowa73.github.io' }, requestContext: { http: { method: 'POST', sourceIp: 'fc-ip' } } };
  const created = await handler(Buffer.from(JSON.stringify(request)), { credentials: { securityToken: 'rotating-1' } });
  assert.equal(created.statusCode, 201);
  await handler(JSON.stringify({ ...request, rawPath: '/api/account/health', body: '', requestContext: { http: { method: 'GET' } } }), { credentials: { securityToken: 'rotating-2' } });
  assert.deepEqual(seenCredentials.map(c => c.securityToken), ['rotating-1', 'rotating-2']);
  assert.equal((await handler('{}', {})).statusCode, 400);
});
