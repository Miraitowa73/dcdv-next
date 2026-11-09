'use strict';

const { createAccountService, MAX_PROGRESS_BYTES } = require('./service');
const { createTableStore } = require('./store');

function createHandler({ storeFactory = createTableStore, env = process.env } = {}) {
  return async function handler(event, context) {
    try {
      const raw = Buffer.isBuffer(event) ? event.toString('utf8') : event;
      // FC may base64-encode the HTTP body. Bound the envelope before parsing it.
      if (typeof raw === 'string' && Buffer.byteLength(raw) > 2 * MAX_PROGRESS_BYTES) return response(413, 'BODY_TOO_LARGE', '请求内容过大。');
      const request = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (env.DCDV_BOOTSTRAP_ADMIN === '1' && request?.operation === 'bootstrapAdmin' && !request.requestContext && !request.rawPath && context?.credentials) {
        const store = storeFactory({ credentials: context.credentials, endpoint: env.DCDV_TABLESTORE_ENDPOINT, instanceName: env.DCDV_TABLESTORE_INSTANCE, prefix: env.DCDV_TABLE_PREFIX || 'dcdv_' });
        return await require('./bootstrap').bootstrapAdmin(store);
      }
      if (!request?.requestContext?.http?.method || typeof request.rawPath !== 'string') return response(400, 'HTTP_REQUIRED', '请通过 HTTP 触发器访问。');
      if (request.body !== undefined && typeof request.body !== 'string') return response(400, 'INVALID_BODY', '请求格式无效。');
      const store = storeFactory({ credentials: context?.credentials, endpoint: env.DCDV_TABLESTORE_ENDPOINT, instanceName: env.DCDV_TABLESTORE_INSTANCE, prefix: env.DCDV_TABLE_PREFIX || 'dcdv_' });
      const handle = createAccountService({ store, allowedOrigins: (env.DCDV_ACCOUNT_ORIGINS || 'https://miraitowa73.github.io').split(',').map(value => value.trim()).filter(Boolean) });
      const query = request.rawQueryString || new URLSearchParams(request.queryParameters || {}).toString();
      return await handle({ method: request.requestContext.http.method, path: request.rawPath + (query ? '?' + query : ''), headers: request.headers, sourceIp: request.requestContext.http.sourceIp || 'unknown', body: request.isBase64Encoded ? Buffer.from(request.body || '', 'base64').toString('utf8') : (request.body || '') });
    } catch {
      return response(503, 'SERVICE_UNAVAILABLE', '云端账号服务配置尚未就绪，请稍后重试。');
    }
  };
}
function response(statusCode, code, message) {
  return { statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: { code, message } }), isBase64Encoded: false };
}
exports.handler = createHandler();
exports.createHandler = createHandler;
