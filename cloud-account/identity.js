'use strict';
const { randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(scryptCallback);
class ApiError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
function username(value) {
  if (typeof value !== 'string') fail(400, 'INVALID_USERNAME', '请填写账号。');
  const name = value.trim().normalize('NFKC');
  if (Array.from(name).length < 2 || Array.from(name).length > 24 || !/^[\p{L}\p{N}_-]+$/u.test(name)) fail(400, 'INVALID_USERNAME', '账号需为 2–24 个文字、字母、数字、下划线或中划线。');
  return name;
}
const keyFor = value => username(value).toLocaleLowerCase('zh-CN');
function studentNumber(value) {
  const name = username(value);
  if (!/^[A-Za-z0-9]{6,24}$/.test(name)) fail(400, 'INVALID_STUDENT_NUMBER', '学号需为 6–24 位数字或字母，请保留开头的 0。');
  if (name.toLowerCase() === 'miraitowa') fail(409, 'RESERVED_USERNAME', '此账号不可用于学生注册。');
  return name;
}
function password(value, minimum = 8) {
  if (typeof value !== 'string' || Array.from(value).length < minimum || Array.from(value).length > 72) fail(400, 'INVALID_PASSWORD', `密码长度需为 ${minimum}–72 个字符。`);
  return value;
}
function displayName(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 40 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_NAME', '姓名需为 1–40 个字符。');
  return value.trim();
}
const roleOf = user => user.role || 'student';
function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt, role: roleOf(user), studentNumber: user.studentNumber || '', displayName: user.displayName || '', mustChangePassword: !!user.mustChangePassword };
}
let hashing = 0;
async function hash(passwordValue, salt) {
  if (hashing >= 2) fail(503, 'BUSY', '登录服务繁忙，请稍后重试。');
  hashing++;
  try { return await scrypt(passwordValue, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }
  finally { hashing--; }
}
async function passwordFields(value) {
  const salt = randomBytes(16).toString('base64');
  return { salt, passwordHash: (await hash(value, salt)).toString('base64'), passwordAlgorithm: 'scrypt-N32768-r8-p1' };
}
async function verifyPassword(user, value) {
  const candidate = await hash(value, user?.salt || 'dcdv-dummy-salt-not-a-real-account');
  const expected = user ? Buffer.from(user.passwordHash, 'base64') : Buffer.alloc(32);
  return !!user && candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
async function newUser(name, secret, fields = {}, now = Date.now) {
  return { id: randomUUID(), username: username(name), usernameKey: keyFor(name), createdAt: new Date(now()).toISOString(), role: 'student', initialProgress: null, authVersion: 0, ...fields, ...await passwordFields(secret) };
}
module.exports = { ApiError, fail, username, keyFor, studentNumber, password, displayName, roleOf, publicUser, hash, passwordFields, verifyPassword, newUser };
