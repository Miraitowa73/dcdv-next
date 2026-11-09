const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, SESSION_KEY } = require('../auth-cloud');
const utils = require('../auth-local');
const { createAccountService } = require('../cloud-account/service');
const { memoryStore } = require('./helpers/account-store');

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
function setup() {
  const store = memoryStore();
  const service = createAccountService({ store });
  let offline = false;
  let progressFails = false;
  const fetch = async (url, options) => {
    if (offline || (progressFails && url.endsWith('/progress') && options.method === 'GET')) throw new TypeError('network failure');
    const response = await service({ method: options.method, path: new URL(url).pathname, headers: options.headers, body: options.body || '', sourceIp: 'test' });
    return { ok: response.statusCode < 400, status: response.statusCode, json: async () => JSON.parse(response.body) };
  };
  const client = (sessionStorage = storage()) => ({ auth: createClient({ baseUrl: 'https://accounts.example', utils, storage: sessionStorage, fetch }), storage: sessionStorage });
  return { client, store, offline: value => { offline = value; }, failProgress: value => { progressFails = value; } };
}

test('a fresh computer can sign in and load progress, browser stores only the opaque credential', async () => {
  const { client } = setup();
  const a = client();
  const user = await a.auth.createUser('Student', 'cross-device-password');
  assert.equal(await a.auth.loadProgress(user.id), null);
  await a.auth.saveProgress(user.id, { completed: { first: true } });
  const b = client();
  const other = await b.auth.authenticate('student', 'cross-device-password');
  assert.equal(other.id, user.id);
  assert.deepEqual(await b.auth.loadProgress(user.id), { completed: { first: true } });
  assert.deepEqual([...a.storage.values.keys()], [SESSION_KEY]);
  assert.match(a.storage.getItem(SESSION_KEY), /^[A-Za-z0-9_-]{43}$/);
  const refreshed = client(b.storage);
  assert.equal((await refreshed.auth.restoreSession()).id, user.id);
  await b.auth.clearSession();
  assert.equal(b.storage.values.size, 0);
  assert.equal(await refreshed.auth.restoreSession(), null);
});

test('failed cloud reads cannot cause an empty progress overwrite, and outage keeps login credential', async () => {
  const app = setup();
  const { auth, storage } = app.client();
  const user = await auth.createUser('Student', 'cross-device-password');
  app.failProgress(true);
  await assert.rejects(auth.loadProgress(user.id), { code: 'NETWORK_ERROR' });
  await assert.rejects(auth.saveProgress(user.id, { completed: {} }), { code: 'PROGRESS_NOT_LOADED' });
  app.offline(true);
  await assert.rejects(auth.restoreSession(), { code: 'NETWORK_ERROR' });
  assert.equal(storage.values.size, 1);
});

test('conflicts stop queued saves until the user explicitly loads the current cloud revision', async () => {
  const { client } = setup();
  const a = client().auth;
  const b = client().auth;
  const user = await a.createUser('Student', 'cross-device-password');
  await a.loadProgress(user.id);
  await b.authenticate('Student', 'cross-device-password');
  await b.loadProgress(user.id);
  await a.saveProgress(user.id, { completed: { a: true } });
  await assert.rejects(b.saveProgress(user.id, { completed: { b: true } }), { code: 'PROGRESS_CONFLICT' });
  await assert.rejects(b.saveProgress(user.id, { completed: { b2: true } }), { code: 'PROGRESS_CONFLICT' });
  const current = await b.loadProgress(user.id);
  assert.deepEqual(current.completed, { a: true });
  await b.saveProgress(user.id, { completed: { ...current.completed, b: true } });
  assert.deepEqual((await a.loadProgress(user.id)).completed, { a: true, b: true });
});

test('rapid saves serialize and do not create false conflicts', async () => {
  const { auth } = setup().client();
  const user = await auth.createUser('Student', 'cross-device-password');
  await auth.loadProgress(user.id);
  await Promise.all([auth.saveProgress(user.id, { activeLevelId: '1' }), auth.saveProgress(user.id, { activeLevelId: '2' })]);
  assert.equal((await auth.loadProgress(user.id)).activeLevelId, '2');
});

test('account switching blocks queued writes belonging to the previous account', async () => {
  const { auth } = setup().client();
  const old = await auth.createUser('OldStudent', 'cross-device-password');
  await auth.loadProgress(old.id);
  await auth.clearSession();
  const current = await auth.createUser('NewStudent', 'cross-device-password');
  await auth.loadProgress(current.id);
  await assert.rejects(auth.saveProgress(old.id, { completed: { wrong: true } }), { code: 'SESSION_CHANGED' });
  assert.equal(await auth.loadProgress(current.id), null);
});

test('cloud client rejects insecure remote endpoints', () => {
  assert.throws(() => createClient({ baseUrl: 'http://accounts.example', utils }), /HTTPS/);
  assert.throws(() => createClient({ baseUrl: 'https://accounts.example/?token=secret', utils }), /独立域名/);
});
