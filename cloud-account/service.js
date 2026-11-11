'use strict';

const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { ApiError, fail, username, password, studentNumber, publicUser, newUser, passwordFields, verifyPassword } = require('./identity');
const { summarize } = require('./progress-summary');
const { createClassroom } = require('./classroom');
const MAX_PROGRESS_BYTES = 1024 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

function validateProgress(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail(400, 'INVALID_PROGRESS', '进度内容无效。');
  const allowed = new Set(['activeGroupId', 'activeLevelId', 'completed', 'hints', 'practice', 'results', 'compileResults', 'schematicDrafts', 'fsmDrafts', 'metrics']);
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

// The store must provide durable, atomic compare-and-set. There is no file/memory fallback in production.
function createAccountService({ store, allowedOrigins = ['https://miraitowa73.github.io'], now = Date.now, sessionMs = SESSION_MS, limits = {} }) {
  if (!store) throw new Error('A durable account store is required');
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
    if (!await store.put('ephemeral', `session:${digest(token)}`, { userId: user.id, usernameKey: user.usernameKey, authVersion: user.authVersion || 0, expiresAt }, null)) {
      fail(503, 'BUSY', '登录服务繁忙，请重试。');
    }
    return { user: publicUser(user), token, expiresAt };
  }
  const classroom = createClassroom({ store, now, rateLimit });
  return async function handle({ method, path, headers = {}, body = '', sourceIp = 'unknown' }) {
    const parsedUrl = new URL(path, 'https://account.invalid');
    path = parsedUrl.pathname;
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
        return result(200, { ok: true, service: 'dcdv-cloud-account', storage: 'tablestore', version: 4, features: ['classrooms', 'learning-metrics-v1', 'teacher-display-name-v1'] });
      }
      if (Buffer.byteLength(body) > MAX_PROGRESS_BYTES + 4096) fail(413, 'BODY_TOO_LARGE', '请求内容过大。');
      let data = {};
      if (['POST', 'PUT'].includes(method)) {
        if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', '请使用 JSON 请求。');
        try { data = JSON.parse(body || '{}'); } catch { fail(400, 'INVALID_JSON', '请求格式无效。'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'INVALID_JSON', '请求格式无效。');
      }
      if (method === 'POST' && ['/api/account/register', '/api/account/login'].includes(path)) {
        const name = username(data.username);
        const usernameKey = name.toLocaleLowerCase('zh-CN');
        const secret = password(data.password, path.endsWith('/login') ? 6 : 8);
        await rateLimit('auth-ip', sourceIp, 120, 10 * 60 * 1000);
        await rateLimit('auth-name', usernameKey, 20, 10 * 60 * 1000);
        if (path.endsWith('/register')) {
          await rateLimit('register-ip', sourceIp, 30, 60 * 60 * 1000);
          await rateLimit('register-global', 'all', 1000, 24 * 60 * 60 * 1000);
          const initialProgress = data.progress === undefined ? null : validateProgress(data.progress);
          const number = studentNumber(name);
          const user = await newUser(name, secret, { initialProgress, studentNumber: number }, now);
          // Initial migrated progress lives atomically with the new user until the first save.
          if (!await store.put('users', usernameKey, user, null)) fail(409, 'USERNAME_TAKEN', '云端已有同名账号，请直接登录，或换一个云端用户名后迁移。');
          return result(201, await issueSession(user));
        }
        const record = await store.get('users', usernameKey);
        const valid = await verifyPassword(record?.value, secret);
        if (!valid || (!record.value.mustChangePassword && Array.from(secret).length < 8)) fail(401, 'BAD_CREDENTIALS', '用户名或密码错误。');
        return result(200, await issueSession(record.value));
      }
      const session = await sessionFor(headers);
      if (method === 'POST' && path === '/api/account/logout') {
        await store.delete('ephemeral', session.key);
        return result(200, { ok: true });
      }
      const account = await store.get('users', session.usernameKey);
      if (!account || account.value.id !== session.userId) fail(401, 'UNAUTHORIZED', '账号已失效，请重新登录。');
      if ((account.value.authVersion || 0) !== (session.authVersion || 0)) fail(401, 'UNAUTHORIZED', '密码已更改，请重新登录。');
      if (method === 'GET' && path === '/api/account/me') return result(200, { user: publicUser(account.value), expiresAt: session.expiresAt });
      if (method === 'POST' && path === '/api/account/change-password') {
        await rateLimit('password-change', session.userId, 10, 600000);
        const nextPassword = password(data.newPassword);
        // A restricted first-login session already proves the temporary password.
        // Only the persisted server flag allows initial setup without re-entering it.
        if (!account.value.mustChangePassword) {
          const oldPassword = password(data.currentPassword, 6);
          if (!await verifyPassword(account.value, oldPassword)) fail(400, 'BAD_CREDENTIALS', '当前密码不正确。');
        }
        if (await verifyPassword(account.value, nextPassword)) fail(400, 'PASSWORD_UNCHANGED', '请设置不同的新密码。');
        const value = { ...account.value, ...await passwordFields(nextPassword), mustChangePassword: false, authVersion: (account.value.authVersion || 0) + 1 };
        if (!await store.put('users', session.usernameKey, value, account.version)) fail(409, 'CONFLICT', '账号已改变，请重试。');
        return result(200, await issueSession(value));
      }
      if (account.value.mustChangePassword) fail(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录请先修改临时密码。');
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
        if (!await store.put('progress', session.userId, { state, updatedAt, summary: summarize(state, updatedAt) }, data.revision, revision)) fail(409, 'PROGRESS_CONFLICT', '另一台设备已更新进度。本页内容尚未覆盖云端，请先导出本页备份，再载入云端进度。');
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
      const classResult = await classroom({ path, method, data, user: account.value, query: parsedUrl.searchParams });
      if (classResult !== null) return result(200, classResult);
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
