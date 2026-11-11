'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { fail, ApiError, keyFor, studentNumber, displayName, roleOf, publicUser, newUser } = require('./identity');
const { summarize } = require('./progress-summary');
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
async function mapLimited(items, mapper, concurrency = 6) {
  const output = new Array(items.length); let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) { const i = index++; if (i >= items.length) break; output[i] = await mapper(items[i], i); }
  }));
  return output;
}
function createClassroom({ store, now = Date.now, rateLimit }) {
  const time = () => new Date(now()).toISOString();
  async function upsert(table, key, update) {
    for (let i = 0; i < 5; i++) {
      const row = await store.get(table, key);
      const value = update(row?.value);
      if (await store.put(table, key, value, row?.version ?? null)) return value;
    }
    fail(409, 'CONFLICT', '数据已改变，请刷新重试。');
  }
  async function audited(actor, action, target, operation) {
    const key = `audit:${time()}:${randomUUID()}`;
    const base = { actorId: actor.id, action, target, at: time(), status: 'started' };
    await upsert('classes', key, () => base);
    try {
      const result = await operation();
      await upsert('classes', key, () => ({ ...base, status: 'completed' }));
      return result;
    } catch (error) {
      try { await upsert('classes', key, () => ({ ...base, status: 'failed', code: error instanceof ApiError ? error.code : 'SERVICE_UNAVAILABLE' })); } catch { /* The durable intent remains available for investigation. */ }
      throw error;
    }
  }
  function role(user, required) {
    if (roleOf(user) !== required) fail(403, 'FORBIDDEN', '当前账号没有此操作权限。');
  }
  async function ownedClass(user, id, writing = false) {
    role(user, 'teacher');
    if (!uuid(id)) fail(404, 'CLASS_NOT_FOUND', '班级不存在。');
    const row = await store.get('classes', `c:${id}`);
    if (!row || row.value.ownerId !== user.id) fail(404, 'CLASS_NOT_FOUND', '班级不存在或无权访问。');
    if (writing && row.value.archived) fail(409, 'CLASS_ARCHIVED', '班级已归档，请先恢复班级。');
    return row;
  }
  async function memberOf(classId, userId) {
    const record = await store.get('class_members', `c:${classId}:${userId}`);
    if (!record?.value.active) fail(404, 'STUDENT_NOT_FOUND', '学生不在此班级中。');
    return record;
  }
  async function summaryFor(member) {
    let summary = await store.summary(member.userId);
    if (summary?.version !== 2) {
      const progress = await store.get('progress', member.userId);
      const user = progress ? null : await store.get('users', member.usernameKey);
      summary = summarize(progress?.value.state || user?.value.initialProgress, progress?.value.updatedAt || null);
    }
    return summary;
  }
  function cleanRoster(input) {
    if (!Array.isArray(input) || !input.length || input.length > 500) fail(400, 'INVALID_ROSTER', '每次请选择 1–500 行名单。');
    const seen = new Set();
    return input.map((item, index) => {
      try {
        const number = studentNumber(item?.studentNumber);
        const name = displayName(item?.name);
        const usernameKey = keyFor(number);
        if (seen.has(usernameKey)) fail(400, 'DUPLICATE_ROW', '文件中学号重复。');
        seen.add(usernameKey);
        return { index, studentNumber: number, usernameKey, name };
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        return { index, studentNumber: String(item?.studentNumber || '').slice(0, 24), name: String(item?.name || '').slice(0, 40), status: 'error', error: error.message };
      }
    });
  }
  async function inspectRow(classId, row) {
    if (row.status === 'error') return row;
    const account = await store.get('users', row.usernameKey);
    if (account && roleOf(account.value) !== 'student') return { ...row, status: 'error', error: '此账号是老师或管理员，不能导入为学生。' };
    const member = account ? await store.get('class_members', `c:${classId}:${account.value.id}`) : null;
    const priorName = member?.value.active ? member.value.name : (account?.value.displayName || '');
    return { ...row, status: account ? (member?.value.active ? 'member' : 'existing') : 'new', nameConflict: !!priorName && priorName !== row.name, priorName };
  }
  return async function route({ path, method, data, user, query }) {
    if (method === 'POST' && ['/api/account/profile', '/api/account/admin/teachers/profile'].includes(path)) {
      const adminEdit = path.endsWith('/teachers/profile');
      if (adminEdit) role(user, 'admin');
      else if (!['teacher', 'admin'].includes(roleOf(user))) fail(403, 'FORBIDDEN', '当前账号不能修改老师姓名。');
      const allowed = adminEdit ? ['username', 'displayName'] : ['displayName'];
      if (Object.keys(data).some(key => !allowed.includes(key))) fail(400, 'INVALID_PROFILE', '此入口仅支持修改显示姓名。');
      const name = displayName(data.displayName);
      const key = adminEdit ? keyFor(data.username) : user.usernameKey;
      await rateLimit('profile-change', user.id, 20, 60000);
      return audited(user, adminEdit ? 'teacher.rename' : 'profile.rename', key, async () => {
        const value = await upsert('users', key, current => {
          if (!current || (adminEdit ? roleOf(current) !== 'teacher' : current.id !== user.id || !['teacher', 'admin'].includes(roleOf(current)))) fail(404, 'TEACHER_NOT_FOUND', '老师账号不存在或权限已改变。');
          return { ...current, displayName: name };
        });
        return { user: publicUser(value) };
      });
    }
    if (path === '/api/account/admin/teachers') {
      role(user, 'admin');
      if (method === 'GET') {
        const page = await store.scan('classes', 'teacher:', query.get('cursor'), 50);
        const teachers = await mapLimited(page.rows, async row => {
          const account = await store.get('users', row.value.usernameKey);
          return account && account.value.id === row.value.userId ? publicUser(account.value) : null;
        });
        return { teachers: teachers.filter(Boolean), cursor: page.cursor };
      }
      if (method === 'POST') {
        await rateLimit('teacher-management', user.id, 60, 60000);
        const usernameKey = keyFor(data.username);
        if (usernameKey === 'miraitowa') fail(409, 'RESERVED_USERNAME', '管理员账号不能更改为老师。');
        const name = displayName(data.displayName);
        const existing = await store.get('users', usernameKey);
        if (existing && data.useExisting !== true) fail(409, 'ACCOUNT_EXISTS', '此账号已存在，请选择给已有账号授予权限。');
        if (!existing && data.useExisting === true) fail(404, 'ACCOUNT_NOT_FOUND', '没有找到此账号。');
        if (existing && roleOf(existing.value) === 'admin') fail(403, 'FORBIDDEN', '不能修改管理员身份。');
        return audited(user, 'teacher.grant', usernameKey, async () => {
          let account; let temporaryPassword;
          if (existing) {
            account = { ...existing.value, role: 'teacher' };
          } else {
            temporaryPassword = randomBytes(12).toString('base64url');
            account = await newUser(data.username, temporaryPassword, { role: 'teacher', displayName: name, mustChangePassword: true }, now);
          }
          await upsert('classes', `teacher:${usernameKey}`, () => ({ userId: account.id, usernameKey }));
          if (!await store.put('users', usernameKey, account, existing?.version ?? null)) fail(409, 'CONFLICT', '账号已改变，请刷新重试。');
          return { user: publicUser(account), ...(temporaryPassword ? { temporaryPassword } : {}) };
        });
      }
    }
    if (path === '/api/account/admin/teachers/reset-password' && method === 'POST') {
      role(user, 'admin');
      const key = keyFor(data.username);
      const account = await store.get('users', key);
      if (!account || roleOf(account.value) !== 'teacher') fail(404, 'TEACHER_NOT_FOUND', '老师账号不存在。');
      return audited(user, 'teacher.password-reset', key, async () => {
        const temporaryPassword = randomBytes(12).toString('base64url');
        const { passwordFields } = require('./identity');
        const value = { ...account.value, ...await passwordFields(temporaryPassword), mustChangePassword: true, authVersion: (account.value.authVersion || 0) + 1 };
        if (!await store.put('users', key, value, account.version)) fail(409, 'CONFLICT', '账号已改变，请重试。');
        return { user: publicUser(value), temporaryPassword };
      });
    }
    if (path === '/api/account/admin/teachers/revoke' && method === 'POST') {
      role(user, 'admin');
      const key = keyFor(data.username);
      return audited(user, 'teacher.revoke', key, async () => {
        await upsert('users', key, value => {
          if (!value || roleOf(value) === 'admin') fail(403, 'FORBIDDEN', '不能撤销此账号的身份。');
          return { ...value, role: 'student' };
        });
        return { ok: true };
      });
    }
    if (path === '/api/account/my-classes' && method === 'GET') {
      const page = await store.scan('class_members', `s:${user.id}:`, query.get('cursor'), 50);
      const classes = await mapLimited(page.rows, async row => {
        const membership = await store.get('class_members', `c:${row.value.classId}:${user.id}`);
        if (!membership?.value.active) return null;
        const group = await store.get('classes', `c:${row.value.classId}`);
        if (!group) return null;
        const teacher = await store.get('users', group.value.ownerKey);
        if (!teacher || roleOf(teacher.value) !== 'teacher') return null;
        return { id: group.value.id, name: group.value.name, archived: group.value.archived, teacher: teacher.value.displayName || teacher.value.username };
      });
      return { classes: classes.filter(Boolean), cursor: page.cursor };
    }
    if (path === '/api/account/classes') {
      role(user, 'teacher');
      if (method === 'GET') {
        const page = await store.scan('classes', `owner:${user.id}:`, query.get('cursor'), 50);
        const classes = await mapLimited(page.rows, async row => {
          const record = await store.get('classes', `c:${row.value.classId}`);
          return record?.value.ownerId === user.id ? record.value : null;
        });
        return { classes: classes.filter(Boolean), cursor: page.cursor };
      }
      if (method === 'POST') {
        const name = displayName(data.name);
        if (!uuid(data.id)) fail(400, 'INVALID_CLASS_ID', '请重新打开创建班级窗口。');
        await rateLimit('class-create', user.id, 30, 3600000);
        return audited(user, 'class.create', data.id, async () => {
          await upsert('classes', `owner:${user.id}:${data.id}`, () => ({ classId: data.id }));
          const group = await upsert('classes', `c:${data.id}`, value => {
            if (value && value.ownerId !== user.id) fail(409, 'CONFLICT', '班级编号已占用。');
            return value || { id: data.id, name, ownerId: user.id, ownerKey: user.usernameKey, archived: false, createdAt: time() };
          });
          return { class: group };
        });
      }
    }
    const match = /^\/api\/account\/classes\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(path);
    if (!match) return null;
    const [, classId, action = ''] = match;
    const group = await ownedClass(user, classId, method === 'POST' && action.startsWith('import'));
    if (!action && method === 'PUT') {
      return audited(user, 'class.update', classId, async () => {
        const value = { ...group.value, ...(data.name === undefined ? {} : { name: displayName(data.name) }) };
        if (data.archived !== undefined) {
          if (typeof data.archived !== 'boolean') fail(400, 'INVALID_ARCHIVED', '归档状态无效。');
          value.archived = data.archived;
        }
        if (!await store.put('classes', `c:${classId}`, value, group.version)) fail(409, 'CONFLICT', '班级已改变，请刷新重试。');
        return { class: value };
      });
    }
    if (action === 'students' && method === 'GET') {
      const page = await store.scan('class_members', `c:${classId}:`, query.get('cursor'), 50);
      const students = await mapLimited(page.rows.filter(row => row.value.active), async row => {
        const { levels, ...stats } = await summaryFor(row.value);
        return { userId: row.value.userId, studentNumber: row.value.studentNumber, name: row.value.name, ...stats };
      });
      return { students, cursor: page.cursor };
    }
    const student = /^students\/([a-f0-9-]{36})\/(progress|remove)$/.exec(action);
    if (student) {
      const member = await memberOf(classId, student[1]);
      if (student[2] === 'progress' && method === 'GET') return { studentNumber: member.value.studentNumber, name: member.value.name, ...await summaryFor(member.value) };
      if (student[2] === 'remove' && method === 'POST') return audited(user, 'member.remove', `${classId}:${student[1]}`, async () => {
        if (!await store.put('class_members', `c:${classId}:${student[1]}`, { ...member.value, active: false }, member.version)) fail(409, 'CONFLICT', '名单已改变，请刷新重试。');
        // Reverse entries are discoverability indexes only. All reads check the authoritative membership.
        return { ok: true };
      });
    }
    if (action === 'import/preview' && method === 'POST') {
      await rateLimit('import-preview', user.id, 20, 60000);
      const rows = await mapLimited(cleanRoster(data.rows), row => inspectRow(classId, row));
      const previewId = randomUUID();
      if (!await store.put('ephemeral', `preview:${previewId}`, { actorId: user.id, classId, rows, expiresAt: now() + 3600000 }, null)) fail(503, 'BUSY', '请重试。');
      return { previewId, rows };
    }
    if (action === 'import' && method === 'POST') {
      await rateLimit('import-batch', user.id, 120, 60000);
      if (!uuid(data.previewId) || !Array.isArray(data.indices) || !data.indices.length || data.indices.length > 5 || new Set(data.indices).size !== data.indices.length) fail(400, 'INVALID_BATCH', '每批最多导入 5 人。');
      const preview = await store.get('ephemeral', `preview:${data.previewId}`);
      if (!preview || preview.value.actorId !== user.id || preview.value.classId !== classId || preview.value.expiresAt <= now()) fail(409, 'PREVIEW_EXPIRED', '预览已过期，请重新预览名单。');
      const rows = data.indices.map(index => {
        if (!Number.isInteger(index) || index < 0 || index >= preview.value.rows.length) fail(400, 'INVALID_BATCH', '名单行号无效。');
        return preview.value.rows[index];
      });
      const results = [];
      for (const source of rows) {
        try {
          const row = await inspectRow(classId, source);
          if (row.status === 'error') fail(400, 'INVALID_ROW', row.error);
          if (row.nameConflict && !data.confirmedNames?.includes(row.index)) fail(409, 'NAME_CONFIRMATION_REQUIRED', '姓名与已有记录不一致，请先确认。');
          const result = await audited(user, 'member.import', `${classId}:${row.usernameKey}`, async () => {
            const completedKey = `import:${data.previewId}:${row.index}`;
            const completed = await store.get('ephemeral', completedKey);
            if (completed) {
              await memberOf(classId, completed.value.userId);
              return { index: row.index, status: 'success', created: false };
            }
            let account = await store.get('users', row.usernameKey);
            let created = false;
            if (!account) {
              const value = await newUser(row.studentNumber, row.studentNumber.slice(-6), { studentNumber: row.studentNumber, displayName: row.name, mustChangePassword: true }, now);
              created = await store.put('users', row.usernameKey, value, null);
              account = created ? { value } : await store.get('users', row.usernameKey);
            }
            if (!account || roleOf(account.value) !== 'student') fail(409, 'ACCOUNT_ROLE_CONFLICT', '此账号不能作为学生导入。');
            if (row.status === 'new' && account.value.displayName && account.value.displayName !== row.name && !data.confirmedNames?.includes(row.index)) fail(409, 'NAME_CONFIRMATION_REQUIRED', '姓名已发生变化，请重新预览并确认。');
            const memberKey = `c:${classId}:${account.value.id}`;
            await upsert('class_members', `s:${account.value.id}:${classId}`, () => ({ classId }));
            // Do not reactivate a deliberately removed member on retry of the same import.
            await upsert('class_members', memberKey, value => {
              if (value?.importId === data.previewId) {
                if (!value.active) fail(409, 'REMOVED_AFTER_IMPORT', '学生已被移出班级；如需重新加入，请重新预览名单。');
                return value;
              }
              if (value?.active && value.name !== row.name && !data.confirmedNames?.includes(row.index)) fail(409, 'NAME_CONFIRMATION_REQUIRED', '班级姓名已改变，请重新预览并确认。');
              return { classId, userId: account.value.id, usernameKey: row.usernameKey, studentNumber: row.studentNumber, name: row.name, active: true, importId: data.previewId, joinedAt: value?.joinedAt || time() };
            });
            await upsert('ephemeral', completedKey, () => ({ userId: account.value.id }));
            return { index: row.index, status: 'success', created };
          });
          results.push(result);
        } catch (error) {
          results.push({ index: source.index, status: 'error', message: error instanceof ApiError ? error.message : '暂时未能完成此行，请重试；已创建账号不会重置密码。' });
        }
      }
      return { results };
    }
    return null;
  };
}
module.exports = { createClassroom, mapLimited };
