'use strict';
(() => {
  const auth = window.DcdvCloudAuth.createClient({ baseUrl: window.DCDV_ACCOUNT_API_BASE, utils: window.DcdvLocalAuth, storage: window.sessionStorage, fetch: window.fetch.bind(window) });
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const api = (path, data, method) => auth.request(path, { method: method || (data === undefined ? 'GET' : 'POST'), data });
  let user, classes = [], selected = null, roster = [], currentPage = 1, preview = null, loadVersion = 0, busy = false;
  const dialog = $('#dialog');
  function notice(message, error = false) {
    const node = $('#notice'); node.hidden = !message; node.classList.toggle('error', error); node.textContent = message;
    $('#dialog-notice')?.remove();
    if (message && dialog.open) { const alert = document.createElement('p'); alert.id = 'dialog-notice'; alert.setAttribute('role', 'alert'); alert.className = error ? 'error-text' : 'help'; alert.textContent = message; $('#dialog-content').prepend(alert); }
  }
  function error(cause) {
    notice(cause.message || '操作失败，请重试。', true);
    if (cause.status === 401) { dialog.close(); renderSignedOut(); }
    if (cause.status === 403) { roster = []; preview = null; selected = null; $('#content').innerHTML = '<div class="empty">权限已改变，请刷新页面重新读取账号。</div>'; dialog.close(); }
  }
  async function run(operation) {
    if (busy) return;
    busy = true; document.body.setAttribute('aria-busy', 'true');
    try { await operation(); } catch (cause) { error(cause); }
    finally { busy = false; document.body.removeAttribute('aria-busy'); }
  }
  function modal(title, content) {
    $('#dialog-content').innerHTML = `<div class="dialog-head"><h2>${esc(title)}</h2><button data-action="close" aria-label="关闭窗口">关闭</button></div><div class="dialog-body">${content}</div>`;
    if (!dialog.open) dialog.showModal();
  }
  function renderSignedOut() {
    user = null; roster = []; classes = []; selected = null; preview = null;
    $('#identity').textContent = ''; $('#class-nav').replaceChildren(); $('#create-class').hidden = true;
    $('#password-action').hidden = $('#logout-action').hidden = true;
    $('#nav-title').textContent = '请先登录';
    $('#content').innerHTML = '<div class="empty"><h2>登录后进入教学空间</h2><p>老师账号由管理员开通，学生可以用学号注册。</p><a href="./">前往登录 →</a></div>';
  }
  function passwordForm(required) {
    return `<form id="password-form" class="form-panel"><p class="eyebrow">账号安全</p><h1>${required ? '首次登录，请修改密码' : '修改登录密码'}</h1><p>${required ? '当前使用的是临时密码。设置自己的密码后，即可进入学习或班级管理。' : '修改后其他电脑的登录凭证将失效，需要重新登录。'}</p>${required ? '' : '<label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" minlength="6" maxlength="72" required></label>'}<label>新密码<input type="password" name="newPassword" autocomplete="new-password" minlength="8" maxlength="72" placeholder="8–72 个字符" required></label><label>确认新密码<input type="password" name="confirmation" autocomplete="new-password" minlength="8" maxlength="72" required></label><button type="submit" class="primary full">保存新密码并继续</button></form>`;
  }
  async function paged(path, field) {
    let cursor = null; const output = [];
    do {
      const response = await api(path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
      output.push(...response[field]); cursor = response.cursor;
    } while (cursor);
    return output;
  }
  async function loadHome() {
    $('#identity').textContent = `${user.displayName || user.username} · ${{ admin: '管理员', teacher: '老师', student: '学生' }[user.role] || '学生'}`;
    $('#logout-action').hidden = false; $('#password-action').hidden = !!user.mustChangePassword;
    if (user.mustChangePassword) { $('#nav-title').textContent = '设置个人密码'; $('#content').innerHTML = passwordForm(true); return; }
    if (user.role === 'admin') { $('#nav-title').textContent = '老师账号管理'; await renderTeachers(); }
    else if (user.role === 'teacher') { $('#nav-title').textContent = '我的班级'; $('#create-class').hidden = false; await loadClasses(); }
    else { $('#nav-title').textContent = '我的班级'; await renderStudentClasses(); }
  }
  async function renderTeachers() {
    const teachers = await paged('admin/teachers', 'teachers');
    $('#content').innerHTML = `<div class="heading-row"><div><p class="eyebrow">账号管理</p><h1>老师账号</h1><p class="subtext">只有管理员可以开通教师权限。撤销权限不会删除账号或学习进度。</p></div><button class="primary" data-action="add-teacher">＋ 开通老师账号</button></div><div class="table-wrap"><table><thead><tr><th>账号</th><th>姓名</th><th>身份</th><th>操作</th></tr></thead><tbody>${teachers.map(item => `<tr><td class="mono">${esc(item.username)}</td><td>${esc(item.displayName || '—')}</td><td>${item.role === 'teacher' ? '老师' : '已撤销教师权限'}</td><td>${item.role === 'teacher' ? `<button data-action="reset-teacher" data-username="${esc(item.username)}">重置临时密码</button> <button class="danger" data-action="revoke-teacher" data-username="${esc(item.username)}">撤销权限</button>` : '可通过“开通老师账号”重新授权'}</td></tr>`).join('') || '<tr><td colspan="4">暂无老师账号，请点击右上角开通。</td></tr>'}</tbody></table></div>`;
  }
  async function loadClasses() {
    classes = await paged('classes', 'classes');
    $('#class-nav').innerHTML = classes.map(group => `<button data-action="select-class" data-id="${esc(group.id)}" class="${selected?.id === group.id ? 'active' : ''}">${esc(group.name)}${group.archived ? '<small>已归档</small>' : ''}</button>`).join('');
    if (selected) selected = classes.find(group => group.id === selected.id) || null;
    if (!selected) selected = classes.find(group => !group.archived) || classes[0] || null;
    if (selected) await selectClass(selected.id);
    else $('#content').innerHTML = '<div class="empty"><h2>从一个班级开始</h2><p>创建班级后，导入学号与姓名，就可以查看学生的学习进度。</p><button class="primary" data-action="create-class">＋ 创建班级</button></div>';
  }
  async function selectClass(id) {
    selected = classes.find(group => group.id === id); if (!selected) return;
    const version = ++loadVersion;
    $('#class-nav').querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.id === id));
    $('#content').innerHTML = '<div class="empty">正在读取班级名单与进度…</div>';
    const loaded = await paged(`classes/${id}/students`, 'students');
    if (version !== loadVersion) return;
    roster = loaded; currentPage = 1; renderClass();
  }
  function renderClass() {
    const started = roster.filter(item => item.completed > 0).length;
    const average = roster.length ? Math.round(roster.reduce((sum, item) => sum + item.rate, 0) / roster.length) : 0;
    $('#content').innerHTML = `<div class="heading-row"><div><p class="eyebrow">数字电路 · 学习进度</p><h1>${esc(selected.name)} ${selected.archived ? '<span class="pill warn">已归档</span>' : ''}</h1><p class="subtext">共用 39 关学习进度，用于教学跟踪。最近同步时间不代表在线状态。</p></div><div class="actions"><button data-action="rename-class">改名</button><button data-action="archive-class">${selected.archived ? '恢复班级' : '归档'}</button><button data-action="refresh">刷新进度</button>${selected.archived ? '' : '<button class="primary" data-action="import">导入学生</button>'}</div></div><div class="stats"><div class="stat"><strong>${roster.length}</strong><span>班级学生</span></div><div class="stat"><strong>${started}</strong><span>已通过至少一关</span></div><div class="stat"><strong>${average}%</strong><span>平均完成率</span></div></div><div class="toolbar"><input id="search" type="search" placeholder="搜索学号或姓名" aria-label="搜索学号或姓名"><select id="sort" aria-label="排序"><option value="number">按学号排序</option><option value="desc">完成率从高到低</option><option value="asc">完成率从低到高</option></select><span class="count" id="count"></span></div><div class="table-wrap"><table><thead><tr><th>学号</th><th>姓名</th><th>完成关数</th><th>完成率</th><th>最近同步时间</th><th>操作</th></tr></thead><tbody id="students"></tbody></table></div><div id="pager" class="pager"></div>`;
    renderStudents();
  }
  function renderStudents() {
    const query = ($('#search')?.value || '').trim().toLowerCase(); const sort = $('#sort')?.value || 'number';
    const filtered = roster.filter(item => `${item.studentNumber} ${item.name}`.toLowerCase().includes(query)).sort((a, b) => (sort === 'desc' ? b.rate - a.rate : sort === 'asc' ? a.rate - b.rate : 0) || a.studentNumber.localeCompare(b.studentNumber));
    const pages = Math.max(1, Math.ceil(filtered.length / 50)); currentPage = Math.min(currentPage, pages);
    $('#count').textContent = `共 ${filtered.length} 人 · 每页 50 人`;
    $('#students').innerHTML = filtered.slice((currentPage - 1) * 50, currentPage * 50).map(item => `<tr><td class="mono">${esc(item.studentNumber)}</td><td>${esc(item.name)}</td><td>${item.completed} / ${item.total}</td><td><div class="progress"><div class="track"><span style="width:${Number(item.rate) || 0}%"></span></div>${item.rate}%</div></td><td class="muted">${item.updatedAt ? esc(new Date(item.updatedAt).toLocaleString('zh-CN', { hour12: false })) : '尚未同步'}</td><td><div class="actions"><button class="link" data-action="detail" data-id="${esc(item.userId)}">查看明细</button><button data-action="remove" data-id="${esc(item.userId)}">移出班级</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">没有符合条件的学生。可导入名单，或调整搜索条件。</td></tr>';
    $('#pager').innerHTML = `<button data-action="previous" ${currentPage === 1 ? 'disabled' : ''}>上一页</button><span>${currentPage} / ${pages}</span><button data-action="next" ${currentPage === pages ? 'disabled' : ''}>下一页</button>`;
  }
  async function renderStudentClasses() {
    const groups = await paged('my-classes', 'classes');
    $('#content').innerHTML = `<p class="eyebrow">学习账号</p><h1>我的班级</h1><p class="subtext">班级由老师导入学号加入。所属班级的老师可以查看你的关卡完成情况、最新判定与提示使用次数。<br>各班共用学习进度，老师看不到你的代码、答案和电路草稿。</p>${groups.map(group => `<section class="student-class"><h3>${esc(group.name)} ${group.archived ? '<span class="pill warn">已归档</span>' : ''}</h3><span class="muted">负责老师：${esc(group.teacher)}</span></section>`).join('') || '<div class="empty">暂未加入班级。请将你的学号告知老师，由老师导入名单。</div>'}<p class="help">账号：${esc(user.username)}${user.studentNumber ? '' : ' · 当前为旧用户名账号；导入名单按学号账号匹配，不会自动合并账号。'}</p><a href="./?learn=1">继续学习 →</a>`;
  }
  function showImport() {
    preview = null;
    modal('导入学生名单', `<p class="subtext">使用“学号、姓名”两列。新账号的临时密码为学号后六位，首次登录必须修改；已有账号保留密码和进度。</p><div class="actions"><button data-action="template-xlsx">下载 Excel 模板</button><button data-action="template-csv">下载 CSV 模板</button></div><div class="upload-panel"><label for="roster-file">选择名单文件</label><input id="roster-file" type="file" accept=".xlsx,.csv"><p class="help">每次最多 500 人，文件不超过 2 MB。请将学号设为文本并核对前导 0。Excel 读取首个工作表；CSV 请使用 UTF-8 编码。</p><button class="primary" data-action="preview">检查并预览名单</button></div><div id="import-result"></div>`);
  }
  function renderPreview() {
    const counts = { new: 0, existing: 0, member: 0, error: 0 }; preview.rows.forEach(row => counts[row.status]++);
    $('#import-result').innerHTML = `<p class="result-line">新增账号 ${counts.new} 人 · 已有账号 ${counts.existing} 人 · 已在班级 ${counts.member} 人 · 错误 ${counts.error} 行</p><p class="help">错误行会跳过。姓名不同的行需逐一确认；导入将仅更新本班名单姓名。</p><div class="table-wrap"><table><thead><tr><th>行</th><th>学号</th><th>姓名</th><th>检查结果</th><th>姓名确认</th></tr></thead><tbody>${preview.rows.map(row => `<tr><td>${row.index + 2}</td><td class="mono">${esc(row.studentNumber)}</td><td>${esc(row.name)}</td><td><span id="row-result-${row.index}" class="${row.status === 'error' ? 'error-text' : ''}">${esc(row.error || ({ new: '将新建学生账号', existing: '将加入本班，保留密码和进度', member: '已在班级，保留密码和进度' }[row.status]))}</span></td><td>${row.nameConflict ? `<label class="check"><input type="checkbox" data-confirm="${row.index}">原姓名“${esc(row.priorName)}”，确认使用“${esc(row.name)}”</label>` : '—'}</td></tr>`).join('')}</tbody></table></div><p id="import-status" class="help"></p><button class="primary" data-action="commit-import">确认导入有效行</button>`;
    preview.succeeded = new Set();
  }
  async function commitImport() {
    if (!preview) return;
    const rows = preview.rows.filter(row => row.status !== 'error' && !preview.succeeded.has(row.index));
    const confirmedNames = [...dialog.querySelectorAll('[data-confirm]:checked')].map(input => Number(input.dataset.confirm));
    if (rows.some(row => row.nameConflict && !confirmedNames.includes(row.index))) throw new Error('请先勾选确认姓名不一致的行。');
    if (!rows.length) throw new Error('没有需要导入的有效行。');
    for (let index = 0; index < rows.length; index += 5) {
      $('#import-status').textContent = `正在导入第 ${index + 1}–${Math.min(index + 5, rows.length)} 行，请保持页面打开…`;
      const result = await api(`classes/${selected.id}/import`, { previewId: preview.previewId, indices: rows.slice(index, index + 5).map(row => row.index), confirmedNames });
      for (const item of result.results) {
        const node = $(`#row-result-${item.index}`); node.classList.toggle('error-text', item.status === 'error');
        node.textContent = item.status === 'success' ? (item.created ? '已创建账号并加入班级' : '已加入班级，密码和进度保留') : item.message;
        if (item.status === 'success') preview.succeeded.add(item.index);
      }
    }
    const remaining = preview.rows.filter(row => row.status !== 'error' && !preview.succeeded.has(row.index)).length;
    $('#import-status').textContent = `已成功导入 ${preview.succeeded.size} 人。${remaining ? `另有 ${remaining} 行未完成，可点击按钮重试。` : '关闭窗口后刷新班级名单即可查看。'}`;
    const button = dialog.querySelector('[data-action="commit-import"]'); button.textContent = remaining ? '重试未完成的行' : '导入完成'; button.disabled = !remaining;
    await selectClass(selected.id);
  }
  function download(content, filename, type) {
    const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled || busy) return;
    run(async () => {
      notice('');
      const action = button.dataset.action;
      if (action === 'close') { dialog.close(); $('#dialog-content').replaceChildren(); preview = null; }
      else if (action === 'logout') { await auth.clearSession(); dialog.close(); $('#dialog-content').replaceChildren(); renderSignedOut(); }
      else if (action === 'password') modal('账号密码', passwordForm(false));
      else if (action === 'select-class') await selectClass(button.dataset.id);
      else if (action === 'refresh') await selectClass(selected.id);
      else if (action === 'previous' || action === 'next') { currentPage += action === 'next' ? 1 : -1; renderStudents(); }
      else if (action === 'create-class' || action === 'rename-class') modal(action === 'create-class' ? '创建班级' : '修改班级名称', `<form id="class-form" data-mode="${action}" data-id="${action === 'create-class' ? crypto.randomUUID() : selected.id}"><label>班级名称<input name="name" maxlength="40" required value="${action === 'rename-class' ? esc(selected.name) : ''}" placeholder="例如：2026 级数字电路 1 班"></label><button class="primary" type="submit">保存班级</button></form>`);
      else if (action === 'archive-class') {
        if (!confirm(selected.archived ? '恢复这个班级，继续导入与管理学生？' : '归档后停止导入，学生账号和进度仍保留。确定归档？')) return;
        await api(`classes/${selected.id}`, { archived: !selected.archived }, 'PUT'); await loadClasses();
      } else if (action === 'remove') {
        const member = roster.find(item => item.userId === button.dataset.id);
        if (!confirm(`将 ${member.name}（${member.studentNumber}）移出本班？账号与学习进度保留。`)) return;
        await api(`classes/${selected.id}/students/${member.userId}/remove`, {}); await selectClass(selected.id);
      } else if (action === 'detail') {
        const item = await api(`classes/${selected.id}/students/${button.dataset.id}/progress`);
        modal(`${item.name} · ${item.studentNumber}`, `<p class="subtext">已完成 ${item.completed} / ${item.total} 关。展示最近一次判定，不包含作答内容。</p><div class="table-wrap"><table><thead><tr><th>项目</th><th>关卡</th><th>已完成</th><th>最新判定</th><th>提示次数</th></tr></thead><tbody>${item.levels.map(level => `<tr><td>${esc(level.group)}</td><td>${esc(level.title)}</td><td>${level.completed ? '<span class="pill">已完成</span>' : '未完成'}</td><td>${{ passed: '通过', failed: '未通过', unattempted: '未作答' }[level.latestResult] || '未作答'}</td><td>${level.hints}</td></tr>`).join('')}</tbody></table></div>`);
      } else if (action === 'import') showImport();
      else if (action === 'template-csv') download('\ufeff学号,姓名\r\n', '学生名单模板.csv', 'text/csv;charset=utf-8');
      else if (action === 'template-xlsx') {
        if (!window.XLSX) throw new Error('Excel 组件未加载，请刷新或使用 CSV。');
        XLSX.writeFile(DcdvRoster.template(XLSX), '学生名单模板.xlsx');
      } else if (action === 'preview') {
        preview = null; $('#import-result').replaceChildren();
        const rows = await DcdvRoster.readFile($('#roster-file').files[0], window.XLSX);
        preview = await api(`classes/${selected.id}/import/preview`, { rows }); renderPreview();
      } else if (action === 'commit-import') await commitImport();
      else if (action === 'add-teacher') modal('开通老师账号', '<form id="teacher-form"><label>开通方式<select name="mode"><option value="new">创建新老师账号</option><option value="existing">给已有账号授予老师权限</option></select></label><label>账号<input name="username" minlength="2" maxlength="24" autocomplete="off" required></label><label>老师姓名（用于新账号）<input name="displayName" maxlength="40" required></label><p class="help">新账号生成随机临时密码，首次登录须修改。已有账号保留密码、资料与进度。</p><button class="primary" type="submit">开通老师权限</button></form>');
      else if (action === 'reset-teacher') {
        if (!confirm(`为 ${button.dataset.username} 生成新的临时密码？此老师的现有登录将失效，首次登录必须改密。`)) return;
        const response = await api('admin/teachers/reset-password', { username: button.dataset.username });
        modal('新的临时密码', `<p>账号：${esc(response.user.username)}</p><p class="subtext">请交给这位老师，关闭后不再显示。</p><div class="secret">${esc(response.temporaryPassword)}</div>`);
      } else if (action === 'revoke-teacher') {
        if (!confirm(`撤销 ${button.dataset.username} 的老师权限？该账号将立即无法管理班级。`)) return;
        await api('admin/teachers/revoke', { username: button.dataset.username }); await renderTeachers();
      }
    });
  });
  document.addEventListener('submit', event => {
    const form = event.target; if (!['password-form', 'class-form', 'teacher-form'].includes(form.id)) return;
    event.preventDefault();
    run(async () => {
      notice(''); const fields = Object.fromEntries(new FormData(form));
      if (form.id === 'password-form') {
        if (fields.newPassword !== fields.confirmation) throw new Error('两次输入的新密码不一致。');
        user = await auth.changePassword(fields.currentPassword, fields.newPassword); form.reset(); dialog.close(); $('#dialog-content').replaceChildren();
        notice('密码已更新，其他设备需要重新登录。');
        if (user.role === 'student') location.assign('./?learn=1'); else await loadHome();
      } else if (form.id === 'class-form') {
        const response = form.dataset.mode === 'create-class' ? await api('classes', { id: form.dataset.id, name: fields.name }) : await api(`classes/${form.dataset.id}`, { name: fields.name }, 'PUT');
        selected = response.class; dialog.close(); await loadClasses();
      } else if (form.id === 'teacher-form') {
        const response = await api('admin/teachers', { username: fields.username, displayName: fields.displayName, useExisting: fields.mode === 'existing' });
        await renderTeachers();
        if (response.temporaryPassword) modal('老师账号已开通', `<p>账号：<strong class="mono">${esc(response.user.username)}</strong></p><p class="subtext">请将临时密码交给这位老师，首次登录必须修改。关闭后不再显示。</p><div class="secret">${esc(response.temporaryPassword)}</div>`);
        else { dialog.close(); notice('已有账号已获得老师权限，密码与进度保留。'); }
      }
    });
  });
  document.addEventListener('input', event => { if (event.target.id === 'search') { currentPage = 1; renderStudents(); } });
  document.addEventListener('change', event => { if (event.target.id === 'sort') { currentPage = 1; renderStudents(); } });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (!busy) { $('#dialog-content').replaceChildren(); preview = null; } });
  window.addEventListener('beforeunload', event => { if (busy && preview) { event.preventDefault(); event.returnValue = ''; } });
  run(async () => { user = await auth.restoreSession(); if (!user) renderSignedOut(); else await loadHome(); });
})();
