'use strict';

// Creates one synthetic account. Passwords and session tokens stay in memory.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const base = process.argv[2];
if (!base || !base.startsWith('https://')) throw new Error('Pass the deployed HTTPS account origin.');
const origin = 'https://miraitowa73.github.io';
const username = `smoke_${Date.now()}`;
const password = randomBytes(24).toString('base64url');
const checks = [];
async function request(path, method = 'GET', data, token, extra = {}) {
  const response = await fetch(`${base}/api/account/${path}`, {
    method, headers: { Origin: origin, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(25000)
  });
  const raw = await response.text();
  return { status: response.status, headers: response.headers, data: raw ? JSON.parse(raw) : null };
}
(async () => {
  const health = await request('health');
  assert.equal(health.status, 200); assert.equal(health.data.storage, 'tablestore'); checks.push('durable-store-health');
  const preflight = await request('progress', 'OPTIONS', undefined, undefined, { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type' });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), origin); checks.push('cors-preflight');
  assert.equal((await request('progress')).status, 401); checks.push('unauthenticated-progress-denied');
  assert.equal((await request('health', 'GET', undefined, undefined, { Origin: 'https://untrusted.example' })).status, 403); checks.push('foreign-origin-denied');
  const initial = { completed: { smokeInitial: true } };
  const created = await request('register', 'POST', { username, password, progress: initial });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const tokenA = created.data.token; checks.push('register-with-migrated-progress');
  assert.deepEqual((await request('progress', 'GET', undefined, tokenA)).data.state, initial);
  const login = await request('login', 'POST', { username, password });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const tokenB = login.data.token;
  assert.notEqual(tokenA, tokenB); checks.push('independent-device-login');
  const updated = { completed: { smokeInitial: true, smokeNext: true } };
  const saved = await request('progress', 'PUT', { state: updated, revision: null }, tokenA);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual((await request('progress', 'GET', undefined, tokenB)).data.state, updated); checks.push('cross-device-progress');
  assert.equal((await request('progress', 'PUT', { state: initial, revision: null }, tokenB)).status, 409); checks.push('stale-writer-rejected');
  assert.equal((await request('login', 'POST', { username, password: `${password}wrong` })).status, 401); checks.push('wrong-password-denied');
  assert.equal((await request('logout', 'POST', {}, tokenA)).status, 200);
  assert.equal((await request('me', 'GET', undefined, tokenA)).status, 401);
  assert.equal((await request('me', 'GET', undefined, tokenB)).status, 200); checks.push('device-scoped-logout');
  assert.equal((await request('logout', 'POST', {}, tokenB)).status, 200);
  const restored = await request('login', 'POST', { username, password });
  assert.equal(restored.status, 200);
  assert.deepEqual((await request('progress', 'GET', undefined, restored.data.token)).data.state, updated); checks.push('progress-after-new-login');
  assert.equal((await request('logout', 'POST', {}, restored.data.token)).status, 200);
  console.log(JSON.stringify({ ok: true, base, username, checks, checkedAt: new Date().toISOString() }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
