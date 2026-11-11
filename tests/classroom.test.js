'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createAccountService } = require('../cloud-account/service');
const { createHandler } = require('../cloud-account/index');
const { bootstrapAdmin } = require('../cloud-account/bootstrap');
const { newUser } = require('../cloud-account/identity');
const { memoryStore } = require('./helpers/account-store');
const { catalog } = require('../cloud-account/progress-summary');
const { readCatalog } = require('../scripts/challenge-catalog');
async function fixture() {
  const store = memoryStore(); const service = createAccountService({ store });
  const call = async (path, data, token, method = data === undefined ? 'GET' : 'POST') => {
    const response = await service({ method, path: '/api/account/' + path, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: data === undefined ? '' : JSON.stringify(data), sourceIp: 'class-test' });
    return { status: response.statusCode, ...JSON.parse(response.body) };
  };
  async function actor(name, role = 'student') {
    const user = await newUser(name, 'Test-password-123', { role }); await store.put('users', user.usernameKey, user, null);
    return await call('login', { username: name, password: 'Test-password-123' });
  }
  const teacher = await actor('teacher01', 'teacher');
  const group = (await call('classes', { id: randomUUID(), name: '数电一班' }, teacher.token)).class;
  async function preview(rows, token = teacher.token, id = group.id) { return call(`classes/${id}/import/preview`, { rows }, token); }
  async function importRows(rows, token = teacher.token, id = group.id) {
    const p = await preview(rows, token, id); assert.equal(p.status, 200);
    const result = await call(`classes/${id}/import`, { previewId: p.previewId, indices: rows.map((_, i) => i) }, token);
    return { ...result, previewId: p.previewId };
  }
  return { store, call, actor, teacher, group, preview, importRows };
}
test('teacher progress catalog matches all 39 frontend levels and excludes teaching answers', () => {
  assert.equal(catalog.length, 39); assert.deepEqual(catalog, readCatalog());
  assert.ok(catalog.every(item => Object.keys(item).sort().join() === 'group,key,title'));
});
test('public signup never grants roles, reserves administrator and validates school numbers', async () => {
  const { call } = await fixture();
  const student = await call('register', { username: '00123456', password: 'Test-password-123', role: 'admin', mustChangePassword: false });
  assert.equal(student.user.role, 'student'); assert.equal(student.user.studentNumber, '00123456');
  assert.equal((await call('admin/teachers', undefined, student.token)).status, 403);
  assert.equal((await call('classes', { id: randomUUID(), name: '入侵班级' }, student.token)).status, 403);
  assert.equal((await call('register', { username: 'miraitowa', password: 'Test-password-123' })).status, 409);
  assert.equal((await call('register', { username: '123', password: 'Test-password-123' })).status, 400);
});

test('teacher Chinese display names update without changing login, password, classes or progress', async () => {
  const { call, actor, store, teacher, group, importRows } = await fixture();
  const admin = await actor('admin01', 'admin');
  await call('admin/teachers', { username: 'teacher01', displayName: '原姓名', useExisting: true }, admin.token);
  await importRows([{ studentNumber: '00111111', name: '学生甲' }]);
  const student = await call('login', { username: '00111111', password: '111111' });
  const changed = await call('change-password', { newPassword: 'Student-private-123' }, student.token);
  const state = { completed: { 'stairs:truth': true } };
  await call('progress', { state, revision: null }, teacher.token, 'PUT');
  const before = (await store.get('users', 'teacher01')).value;
  const renamed = await call('admin/teachers/profile', { username: 'teacher01', displayName: '  周老师  ' }, admin.token);
  assert.equal(renamed.status, 200); assert.equal(renamed.user.displayName, '周老师');
  assert.deepEqual((await store.get('users', 'teacher01')).value, { ...before, displayName: '周老师' });
  assert.equal((await call('admin/teachers', undefined, admin.token)).teachers[0].displayName, '周老师');
  assert.equal((await call('my-classes', undefined, changed.token)).classes[0].teacher, '周老师');
  const own = await call('profile', { displayName: '李老师' }, teacher.token);
  assert.equal(own.status, 200); assert.equal(own.user.username, 'teacher01');
  assert.equal((await call('login', { username: 'teacher01', password: 'Test-password-123' })).user.displayName, '李老师');
  assert.equal((await call('classes', undefined, teacher.token)).classes[0].id, group.id);
  assert.deepEqual((await call('progress', undefined, teacher.token)).state, state);
  const audits = await store.scan('classes', 'audit:', null, 100);
  assert.ok(audits.rows.some(row => row.value.action === 'teacher.rename' && row.value.actorId === admin.user.id && row.value.status === 'completed'));
  assert.ok(audits.rows.some(row => row.value.action === 'profile.rename' && row.value.actorId === teacher.user.id && row.value.status === 'completed'));
});

test('display name updates enforce role, target, field whitelist and first-password restrictions', async () => {
  const { call, actor, teacher, store } = await fixture();
  const admin = await actor('admin01', 'admin'); const student = await actor('00111112');
  assert.equal((await call('profile', { displayName: '姓名' })).status, 401);
  assert.equal((await call('profile', { displayName: '姓名' }, student.token)).status, 403);
  assert.equal((await call('admin/teachers/profile', { username: 'teacher01', displayName: '姓名' }, teacher.token)).status, 403);
  assert.equal((await call('admin/teachers/profile', { username: '00111112', displayName: '姓名' }, admin.token)).status, 404);
  assert.equal((await call('admin/teachers/profile', { username: 'admin01', displayName: '姓名' }, admin.token)).status, 404);
  for (const extra of [{ username: 'other' }, { role: 'admin' }, { password: 'forged-password' }, { mustChangePassword: false }]) {
    assert.equal((await call('profile', { displayName: '姓名', ...extra }, teacher.token)).status, 400);
  }
  for (const name of ['', ' ', 'a'.repeat(41), 'bad\nname']) assert.equal((await call('profile', { displayName: name }, teacher.token)).status, 400);
  const created = await call('admin/teachers', { username: 'teacher-new', displayName: '新老师' }, admin.token);
  const first = await call('login', { username: 'teacher-new', password: created.temporaryPassword });
  assert.equal((await call('profile', { displayName: '姓名' }, first.token)).error.code, 'PASSWORD_CHANGE_REQUIRED');
  await call('admin/teachers/revoke', { username: 'teacher01' }, admin.token);
  assert.equal((await call('profile', { displayName: '姓名' }, teacher.token)).status, 403);
  assert.equal((await call('admin/teachers/profile', { username: 'teacher01', displayName: '姓名' }, admin.token)).status, 404);
  assert.equal((await store.get('users', 'teacher01')).value.displayName, undefined);
});
test('import preserves zeros, forces first password change, and invalidates old sessions', async () => {
  const { call, importRows, teacher, group, store } = await fixture();
  const result = await importRows([{ studentNumber: '00123456', name: '张同学' }]);
  assert.equal(result.results[0].status, 'success');
  const user = (await store.get('users', '00123456')).value;
  assert.equal(user.studentNumber, '00123456'); assert.ok(!JSON.stringify([...store.rows]).includes('"123456"'));
  const first = await call('login', { username: '00123456', password: '123456' });
  assert.equal(first.user.mustChangePassword, true);
  assert.equal((await call('progress', undefined, first.token)).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await call('my-classes', undefined, first.token)).status, 403);
  assert.equal((await call('progress', { state: {}, revision: null }, first.token, 'PUT')).status, 403);
  assert.equal((await call('change-password', { currentPassword: '123456', newPassword: 'short' }, first.token)).status, 400);
  assert.equal((await call('change-password', { newPassword: 'Private-new-password' })).status, 401);
  const changed = await call('change-password', { newPassword: 'Private-new-password' }, first.token);
  assert.equal(changed.user.mustChangePassword, false);
  assert.equal((await call('change-password', { newPassword: 'Another-private-password', mustChangePassword: true }, changed.token)).status, 400);
  assert.equal((await call('change-password', { currentPassword: 'Wrong-password', newPassword: 'Another-private-password' }, changed.token)).status, 400);
  assert.equal((await call('change-password', { currentPassword: 'Private-new-password', newPassword: 'Private-new-password' }, changed.token)).error.code, 'PASSWORD_UNCHANGED');
  assert.equal((await call('me', undefined, first.token)).status, 401);
  assert.equal((await call('my-classes', undefined, changed.token)).classes[0].id, group.id);
  const retry = await call(`classes/${group.id}/import`, { previewId: result.previewId, indices: [0] }, teacher.token);
  assert.equal(retry.results[0].status, 'success');
  assert.equal((await call('login', { username: '00123456', password: 'Private-new-password' })).status, 200);
  assert.equal((await call('login', { username: '00123456', password: '123456' })).status, 401);
});
test('existing accounts keep password and progress; teacher only receives whitelisted statistics shared across classes', async () => {
  const { call, actor, importRows, teacher, group } = await fixture();
  const student = await actor('20260001');
  const state = { completed: { 'stairs:truth': true, fabricated: true }, results: { 'stairs:truth': { ok: false, message: 'PRIVATE-ANSWER' } }, hints: { 'stairs:truth': 2 }, practice: { code: 'SECRET-HDL' }, schematicDrafts: { private: 'SECRET-DIAGRAM' } };
  assert.equal((await call('progress', { state, revision: null }, student.token, 'PUT')).status, 200);
  await importRows([{ studentNumber: '20260001', name: '学生甲' }]);
  const detail = await call(`classes/${group.id}/students/${student.user.id}/progress`, undefined, teacher.token);
  assert.equal(detail.completed, 1); assert.equal(detail.total, 39); assert.equal(detail.levels[0].latestResult, 'failed'); assert.equal(detail.levels[0].hints, 2);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|SECRET|practice|schematicDrafts/);
  const other = (await call('classes', { id: randomUUID(), name: '数电二班' }, teacher.token)).class;
  await importRows([{ studentNumber: '20260001', name: '学生甲' }], teacher.token, other.id);
  const second = await call(`classes/${other.id}/students/${student.user.id}/progress`, undefined, teacher.token);
  assert.deepEqual(second.levels, detail.levels);
  assert.equal((await call('my-classes', undefined, student.token)).classes.length, 2);
  assert.deepEqual((await call('progress', undefined, student.token)).state, state);
  assert.equal((await call('login', { username: '20260001', password: 'Test-password-123' })).status, 200);
});
test('metrics sync atomically with progress and old summaries are upgraded without exposing drafts', async () => {
  const { store, call, actor, importRows, teacher, group } = await fixture();
  const student = await actor('2026111001');
  const state = { completed: { 'stairs:truth': true }, metrics: { 'stairs:truth': { version: 1, elapsedMs: 90000, errors: 3, partial: false, completedAt: '2026-11-10T01:00:00.000Z' } }, practice: { private: 'SECRET-HDL' } };
  const saved = await call('progress', { state, revision: null }, student.token, 'PUT'); assert.equal(saved.status, 200);
  await importRows([{ studentNumber: '2026111001', name: '统计测试学生' }]);
  const list = await call(`classes/${group.id}/students`, undefined, teacher.token);
  assert.equal(list.students[0].completionTimeMs, 90000); assert.equal(list.students[0].errorCount, 3);
  assert.equal(list.students[0].completionTimePartial, false);
  assert.doesNotMatch(JSON.stringify(list), /SECRET|practice|levels/);
  const old = await store.get('progress', student.user.id);
  await store.put('progress', student.user.id, { ...old.value, summary: { completed: 1, total: 39, levels: [] } }, old.version);
  const detail = await call(`classes/${group.id}/students/${student.user.id}/progress`, undefined, teacher.token);
  assert.equal(detail.version, 2); assert.equal(detail.levels[0].errorCount, 3); assert.equal(detail.levels[0].completionTimeMs, 90000);
  assert.doesNotMatch(JSON.stringify(detail), /SECRET|practice/);
  assert.deepEqual((await call('progress', undefined, student.token)).state, state);
});

test('teachers cannot access another class, remove is immediate, and stale import retries cannot re-enroll', async () => {
  const { call, actor, importRows, teacher, group, store } = await fixture();
  const other = await actor('teacher02', 'teacher');
  const result = await importRows([{ studentNumber: '20260002', name: '学生乙' }]);
  const id = (await store.get('users', '20260002')).value.id;
  for (const suffix of ['students', `students/${id}/progress`]) assert.equal((await call(`classes/${group.id}/${suffix}`, undefined, other.token)).status, 404);
  assert.equal((await call(`classes/${group.id}/students/${id}/remove`, {}, other.token)).status, 404);
  assert.equal((await call(`classes/${group.id}/students/${id}/remove`, {}, teacher.token)).status, 200);
  assert.equal((await call(`classes/${group.id}/students/${id}/progress`, undefined, teacher.token)).status, 404);
  const retry = await call(`classes/${group.id}/import`, { previewId: result.previewId, indices: [0] }, teacher.token);
  assert.equal(retry.results[0].status, 'error');
  assert.ok(await store.get('users', '20260002'));
});
test('duplicate rows, teacher accounts, name conflicts and forged preview identities are rejected', async () => {
  const { call, preview, importRows, teacher, group, actor } = await fixture();
  await importRows([{ studentNumber: '20260003', name: '原姓名' }]);
  const p = await preview([{ studentNumber: '20260003', name: '新姓名' }, { studentNumber: '20260003', name: '重复' }, { studentNumber: 'teacher01', name: '老师' }, { studentNumber: '123', name: '错误' }]);
  assert.equal(p.rows[0].nameConflict, true); assert.ok(p.rows.slice(1).every(row => row.status === 'error'));
  let batch = await call(`classes/${group.id}/import`, { previewId: p.previewId, indices: [0] }, teacher.token);
  assert.equal(batch.results[0].status, 'error');
  batch = await call(`classes/${group.id}/import`, { previewId: p.previewId, indices: [0], confirmedNames: [0] }, teacher.token);
  assert.equal(batch.results[0].status, 'success');
  const other = await actor('teacher02', 'teacher');
  const group2 = (await call('classes', { id: randomUUID(), name: '另一个班' }, other.token)).class;
  assert.equal((await call(`classes/${group2.id}/import`, { previewId: p.previewId, indices: [0] }, other.token)).status, 409);
  assert.equal((await call(`classes/${group.id}/import`, { previewId: p.previewId, indices: [999] }, teacher.token)).status, 400);
});
test('failed membership indexing can be retried without duplicate users or password reset', async () => {
  const { call, preview, teacher, group, store } = await fixture();
  const p = await preview([{ studentNumber: '20260004', name: '学生丙' }]);
  const put = store.put; let fail = true;
  store.put = async (table, key, ...args) => { if (fail && table === 'class_members' && key.startsWith('s:')) throw new Error('storage outage'); return put(table, key, ...args); };
  const args = { previewId: p.previewId, indices: [0] };
  assert.equal((await call(`classes/${group.id}/import`, args, teacher.token)).results[0].status, 'error');
  const before = await store.get('users', '20260004'); fail = false;
  assert.equal((await call(`classes/${group.id}/import`, args, teacher.token)).results[0].status, 'success');
  assert.deepEqual(await store.get('users', '20260004'), before);
  assert.equal((await call(`classes/${group.id}/students`, undefined, teacher.token)).students.length, 1);
});
test('admin grant/revoke and temporary teacher password reset use live roles and leave classes intact', async () => {
  const { call, actor, teacher, group, store } = await fixture(); const admin = await actor('adminTest', 'admin');
  const created = await call('admin/teachers', { username: 'teacher03', displayName: '李老师' }, admin.token);
  assert.equal(created.user.mustChangePassword, true); assert.ok(created.temporaryPassword.length >= 12);
  assert.ok(!JSON.stringify([...store.rows]).includes(created.temporaryPassword));
  await call('admin/teachers/revoke', { username: 'teacher01' }, admin.token);
  assert.equal((await call(`classes/${group.id}/students`, undefined, teacher.token)).status, 403);
  const granted = await call('admin/teachers', { username: 'teacher01', displayName: '原老师', useExisting: true }, admin.token);
  assert.equal(granted.user.role, 'teacher'); assert.equal(granted.temporaryPassword, undefined);
  assert.equal((await call(`classes/${group.id}/students`, undefined, teacher.token)).status, 200);
  const reset = await call('admin/teachers/reset-password', { username: 'teacher01' }, admin.token);
  assert.equal((await call('me', undefined, teacher.token)).status, 401);
  assert.equal((await call('login', { username: 'teacher01', password: reset.temporaryPassword })).user.mustChangePassword, true);
  await call(`classes/${group.id}`, { archived: true }, (await call('login', { username: 'adminTest', password: 'Test-password-123' })).token, 'PUT');
  assert.ok(await store.get('classes', `c:${group.id}`));
});
test('bootstrap is disabled by default, impossible through HTTP, and never overwrites an existing name', async () => {
  const store = memoryStore(); const context = { credentials: { securityToken: 'test-sts' } };
  const off = createHandler({ storeFactory: () => store, env: {} });
  assert.equal((await off({ operation: 'bootstrapAdmin' }, context)).statusCode, 400);
  const on = createHandler({ storeFactory: () => store, env: { DCDV_BOOTSTRAP_ADMIN: '1' } });
  const denied = await on({ rawPath: '/api/account/bootstrapAdmin', requestContext: { http: { method: 'POST' } }, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'bootstrapAdmin' }) }, context);
  assert.equal(denied.statusCode, 401); assert.equal(await store.get('users', 'miraitowa'), null);
  const result = await on({ operation: 'bootstrapAdmin' }, context); assert.equal(result.user.role, 'admin'); assert.ok(result.temporaryPassword);
  const before = await store.get('users', 'miraitowa'); assert.equal((await bootstrapAdmin(store)).code, 'ADMIN_NAME_EXISTS'); assert.deepEqual(await store.get('users', 'miraitowa'), before);
});
test('legacy users and migrated progress remain readable; archived classes reject imports', async () => {
  const { call, actor, teacher, group, store } = await fixture();
  const legacy = await newUser('旧账号', 'Test-password-123', { initialProgress: { completed: { 'stairs:truth': true } } }); delete legacy.role;
  await store.put('users', legacy.usernameKey, legacy, null);
  assert.equal((await call('login', { username: '旧账号', password: 'Test-password-123' })).user.role, 'student');
  const student = await actor('20260005');
  const record = await store.get('users', '20260005'); await store.put('users', '20260005', { ...record.value, initialProgress: { completed: { 'stairs:truth': true } } }, record.version);
  const p = await call(`classes/${group.id}/import/preview`, { rows: [{ studentNumber: '20260005', name: '迁移学生' }] }, teacher.token);
  await call(`classes/${group.id}/import`, { previewId: p.previewId, indices: [0] }, teacher.token);
  assert.equal((await call(`classes/${group.id}/students/${student.user.id}/progress`, undefined, teacher.token)).completed, 1);
  assert.equal((await call(`classes/${group.id}`, { archived: true }, teacher.token, 'PUT')).status, 200);
  assert.equal((await call(`classes/${group.id}/import`, { previewId: p.previewId, indices: [0] }, teacher.token)).status, 409);
  assert.ok(await store.get('users', '20260005'));
});
