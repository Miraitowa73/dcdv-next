'use strict';

const { randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(scryptCallback);
const MAX_PROGRESS_BYTES = 1024 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let hashing = 0;
const digest = value => createHash('sha256').update(value).digest('hex');
class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };

function credentials(body) {
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    fail(400, 'INVALID_CREDENTIALS', '请填写用户名和密码。');
  }
  const username = body.username.trim().normalize('NFKC');
  if (Array.from(username).length < 2 || Array.from(username).length > 24 || !/^[\p{L}\p{N}_-]+$/u.test(username)) {
    fail(400, 'INVALID_USERNAME', '用户名需为 2–24 个文字、字母、数字、下划线或中划线。');
  }
  const length = Array.from(body.password).length;
  if (length < 8 || length > 72) fail(400, 'INVALID_PASSWORD', '密码长度需为 8–72 个字符。');
  return { username, usernameKey: username.toLocaleLowerCase('zh-CN'), password: body.password };
}

function validateProgress(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail(400, 'INVALID_PROGRESS', '进度内容无效。');
  const allowed = new Set(['activeGroupId', 'activeLevelId', 'completed', 'hints', 'practice', 'results', 'compileResults', 'schematicDrafts', 'fsmDrafts']);
  if (Object.keys(state).some(key => !allowed.has(key))) fail(400, 'INVALID_PROGRESS', '进度包含不支持的字段。');
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('active')) {
      if (typeof value !== 'string' || value.length > 200) fail(400, 'INVALID_PROGRESS', '关卡标识无效。');
    } else if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_PROGRESS', '进度字段格式无效。');
  }
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 100000 || depth > 40) fail(413, 'PROGRESS_TOO_LARGE', '进度内容过大，请先导出备份。');
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'INVALID_PROGRESS', '进度字段无效。');
        visit(value[key], depth + 1);
      }
    }
  }
  visit(state, 0);
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_PROGRESS_BYTES) fail(413, 'PROGRESS_TOO_LARGE', '进度超过 1 MB，请先导出备份。');
  return state;
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

// The store must provide durable, atomic compare-and-set. There is no file/memory fallback in production.
function createAccountService({ store, allowedOrigins = ['https://miraitowa73.github.io'], now = Date.now, sessionMs = SESSION_MS, limits = {} }) {
  if (!store) throw new Error('A durable account store is required');
  async function hash(password, salt) {
    if (hashing >= 2) fail(503, 'BUSY', '登录服务繁忙，请稍后重试。');
    hashing++;
    try { return await scrypt(password, salt, 32, PASSWORD_OPTIONS); }
    finally { hashing--; }
  }
  async function rateLimit(scope, identity, max, windowMs) {
    max = limits[scope] ?? max;
    const bucket = Math.floor(now() / windowMs);
    const key = `rate:${scope}:${digest(identity)}:${bucket}`;
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await store.get('ephemeral', key);
      const count = record?.value.count || 0;
      if (count >= max) fail(429, 'RATE_LIMIT', '操作过于频繁，请稍后重试。');
      if (await store.put('ephemeral', key, { count: count + 1 }, record?.version ?? null)) return;
    }
    fail(429, 'RATE_LIMIT', '操作过于频繁，请稍后重试。');
  }
  async function sessionFor(headers) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(headers.authorization || '');
    if (!match) fail(401, 'UNAUTHORIZED', '请重新登录。');
    const key = `session:${digest(match[1])}`;
    const record = await store.get('ephemeral', key);
    if (!record || !record.value.userId || record.value.expiresAt <= now()) fail(401, 'UNAUTHORIZED', '登录已过期，请重新登录。');
    return { ...record.value, key };
  }
  async function issueSession(user) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now() + sessionMs;
    if (!await store.put('ephemeral', `session:${digest(token)}`, { userId: user.id, usernameKey: user.usernameKey, expiresAt }, null)) {
      fail(503, 'BUSY', '登录服务繁忙，请重试。');
    }
    return { user: publicUser(user), token, expiresAt };
  }
  return async function handle({ method, path, headers = {}, body = '', sourceIp = 'unknown' }) {
    headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    const origin = headers.origin;
    const responseHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (allowedOrigins.includes(origin)) responseHeaders['Access-Control-Allow-Origin'] = origin;
    const result = (statusCode, payload) => ({ statusCode, headers: responseHeaders, body: payload === null ? '' : JSON.stringify(payload), isBase64Encoded: false });
    try {
      if (origin && !allowedOrigins.includes(origin)) fail(403, 'ORIGIN_NOT_ALLOWED', '此网站未获准访问账号服务。');
      if (method === 'OPTIONS') {
        responseHeaders['Access-Control-Allow-Methods'] = 'GET, POST, PUT, OPTIONS';
        responseHeaders['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
        responseHeaders['Access-Control-Max-Age'] = '600';
        return result(204, null);
      }
      if (method === 'GET' && path === '/api/account/health') {
        await store.get('users', '__health__');
        return result(200, { ok: true, service: 'dcdv-cloud-account', storage: 'tablestore', version: 1 });
      }
      if (Buffer.byteLength(body) > MAX_PROGRESS_BYTES + 4096) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
      let data = {};
      if (['POST', 'PUT'].includes(method)) {
        if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
        try { data = JSON.parse(body || '{}'); } catch { fail(400, 'INVALID_JSON', '请求格式无效。'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'INVALID_JSON', '请求格式无效。');
      }
      if (method === 'POST' && ['/api/account/register', '/api/account/login'].includes(path)) {
        const { username, usernameKey, password } = credentials(data);
        await rateLimit('auth-ip', sourceIp, 120, 10 * 60 * 1000);
        await rateLimit('auth-name', usernameKey, 20, 10 * 60 * 1000);
        if (path.endsWith('/register')) {
          await rateLimit('register-ip', sourceIp, 30, 60 * 60 * 1000);
          await rateLimit('register-global', 'all', 1000, 24 * 60 * 60 * 1000);
          const initialProgress = data.progress === undefined ? null : validateProgress(data.progress);
          const salt = randomBytes(16).toString('base64');
          const passwordHash = (await hash(password, salt)).toString('base64');
          const user = { id: randomUUID(), username, usernameKey, salt, passwordHash, passwordAlgorithm: 'scrypt-N32768-r8-p1', createdAt: new Date(now()).toISOString(), initialProgress };
          // Initial migrated progress lives atomically with the new user until the first save.
          if (!await store.put('users', usernameKey, user, null)) fail(409, 'USERNAME_TAKEN', '云端已有同名账号，请直接登录，或换一个云端用户名后迁移。');
          return result(201, await issueSession(user));
        }
        const record = await store.get('users', usernameKey);
        const salt = record?.value.salt || 'dcdv-dummy-salt-not-a-real-account';
        const candidate = await hash(password, salt);
        const expected = record ? Buffer.from(record.value.passwordHash, 'base64') : Buffer.alloc(32);
        if (!record || expected.length !== candidate.length || !timingSafeEqual(candidate, expected)) fail(401, 'BAD_CREDENTIALS', '用户名或密码错误。');
        return result(200, await issueSession(record.value));
      }
      const session = await sessionFor(headers);
      if (method === 'POST' && path === '/api/account/logout') {
        await store.delete('ephemeral', session.key);
        return result(200, { ok: true });
      }
      const account = await store.get('users', session.usernameKey);
      if (!account || account.value.id !== session.userId) fail(401, 'UNAUTHORIZED', '账号已失效，请重新登录。');
      if (method === 'GET' && path === '/api/account/me') return result(200, { user: publicUser(account.value), expiresAt: session.expiresAt });
      if (method === 'GET' && path === '/api/account/progress') {
        const record = await store.get('progress', session.userId);
        return result(200, { state: record ? record.value.state : account.value.initialProgress, revision: record?.version ?? null, updatedAt: record?.value.updatedAt ?? null });
      }
      if (method === 'PUT' && path === '/api/account/progress') {
        await rateLimit('save', session.userId, 120, 60000);
        if (!(data.revision === null || (typeof data.revision === 'string' && /^[a-f0-9-]{36}$/.test(data.revision)))) fail(400, 'REVISION_REQUIRED', '请先读取云端进度再保存。');
        const state = validateProgress(data.state);
        const revision = randomUUID();
        const updatedAt = new Date(now()).toISOString();
        if (!await store.put('progress', session.userId, { state, updatedAt }, data.revision, revision)) fail(409, 'PROGRESS_CONFLICT', '另一台设备已更新进度。本页内容尚未覆盖云端，请先导出本页备份，再载入云端进度。');
        if (account.value.initialProgress) {
          // The durable progress row now owns the draft. Avoid reading the potentially
          // large migration copy on every future login/save. Cleanup is best-effort:
          // its failure must not turn an already committed save into a false failure.
          try {
            await store.put('users', session.usernameKey, { ...account.value, initialProgress: null }, account.version);
          } catch { /* A later successful save retries this optional cleanup. */ }
        }
        return result(200, { revision, updatedAt });
      }
      fail(404, 'NOT_FOUND', '接口不存在。');
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) responseHeaders['Retry-After'] = '60';
        return result(error.status, { error: { code: error.code, message: error.message } });
      }
      // Do not send/log database errors, request bodies, passwords or STS credentials.
      return result(503, { error: { code: 'SERVICE_UNAVAILABLE', message: '云端账号服务暂时不可用，请稍后重试。' } });
    }
  };
}

module.exports = { createAccountService, validateProgress, MAX_PROGRESS_BYTES, SESSION_MS };
