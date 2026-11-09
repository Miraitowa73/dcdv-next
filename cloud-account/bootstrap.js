'use strict';
const { randomBytes } = require('node:crypto');
const { newUser, publicUser } = require('./identity');
// Only called for a direct RAM-signed InvokeFunction event, never an HTTP envelope.
// Enable DCDV_BOOTSTRAP_ADMIN=1 only for setup, then remove that environment variable.
async function bootstrapAdmin(store) {
  if (await store.get('users', 'miraitowa')) return { ok: false, code: 'ADMIN_NAME_EXISTS', message: '账号已存在，初始化已停止，未覆盖或提权。' };
  const temporaryPassword = randomBytes(18).toString('base64url');
  const user = await newUser('miraitowa', temporaryPassword, { role: 'admin', displayName: '管理员', mustChangePassword: true });
  if (!await store.put('users', 'miraitowa', user, null)) return { ok: false, code: 'ADMIN_NAME_EXISTS' };
  return { ok: true, user: publicUser(user), temporaryPassword, message: '临时密码仅显示本次，请首次登录后修改，并关闭初始化开关。' };
}
module.exports = { bootstrapAdmin };
