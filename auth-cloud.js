(function attachCloudAuth(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DcdvCloudAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SESSION_KEY = 'dcdvNextCloudSessionV1';
  function createClient({ baseUrl, utils, storage, fetch: fetchImpl, timeoutMs = 20000 }) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('云端账号服务必须使用 HTTPS。');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('账号服务地址必须为独立域名。');
    const base = url.origin;
    let user = null;
    let token = storage?.getItem(SESSION_KEY) || '';
    let revision;
    let conflict = false;
    let generation = 0;
    let writes = Promise.resolve();
    const error = (message, code, status) => Object.assign(new Error(message), { code, status });
    function forget() {
      generation++;
      token = '';
      user = null;
      revision = undefined;
      conflict = false;
      storage?.removeItem(SESSION_KEY);
    }
    async function request(path, { method = 'GET', data, authenticated = true } = {}) {
      const requestGeneration = generation;
      const authToken = token;
      if (authenticated && !authToken) throw error('请重新登录。', 'UNAUTHORIZED', 401);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = {};
        if (data !== undefined) headers['Content-Type'] = 'application/json';
        if (authenticated) headers.Authorization = `Bearer ${authToken}`;
        const response = await fetchImpl(`${base}/api/account/${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
        let payload;
        try { payload = await response.json(); } catch { throw error('账号服务返回了无效响应，请稍后重试。', 'INVALID_RESPONSE'); }
        if (requestGeneration !== generation) throw error('账号会话已改变，请重试。', 'SESSION_CHANGED');
        if (!response.ok) {
          if (response.status === 401 && authenticated) forget();
          throw error(payload.error?.message || '云端请求失败，请稍后重试。', payload.error?.code || 'REQUEST_FAILED', response.status);
        }
        return payload;
      } catch (cause) {
        if (cause.code) throw cause;
        throw error(cause.name === 'AbortError' ? '云端连接超时，本页未保存的进度仍保留在页面中。' : '无法连接云端账号服务，请检查网络后重试。', 'NETWORK_ERROR');
      } finally { clearTimeout(timer); }
    }
    async function signIn(path, username, password, progress) {
      const payload = await request(path, { method: 'POST', authenticated: false, data: { username, password, ...(progress === undefined ? {} : { progress }) } });
      if (!payload.user?.id || !/^[A-Za-z0-9_-]{43}$/.test(payload.token || '')) throw error('登录响应无效。', 'INVALID_RESPONSE');
      generation++;
      token = payload.token;
      user = payload.user;
      revision = undefined;
      conflict = false;
      storage?.setItem(SESSION_KEY, token);
      return user;
    }
    function assertUser(userId) {
      if (!user || user.id !== userId) throw error('账号会话已改变，请重新登录。', 'SESSION_CHANGED');
    }
    return {
      isCloud: true,
      SESSION_KEY,
      validateUsername: utils.validateUsername,
      validatePassword: utils.validatePassword,
      createProgressExport: utils.createProgressExport,
      validateProgressExport: utils.validateProgressExport,
      authenticate: (username, password) => signIn('login', username, password),
      createUser: (username, password, progress) => signIn('register', username, password, progress),
      async restoreSession() {
        if (!token) return null;
        try {
          const result = await request('me');
          if (!result.user?.id) throw error('登录响应无效。', 'INVALID_RESPONSE');
          user = result.user;
          return user;
        } catch (cause) { if (cause.status === 401) return null; throw cause; }
      },
      async clearSession() {
        if (token) {
          try { await request('logout', { method: 'POST', data: {} }); }
          catch (cause) { if (cause.status !== 401) throw cause; }
        }
        forget();
      },
      async loadProgress(userId) {
        assertUser(userId);
        const result = await request('progress');
        assertUser(userId);
        if (!(result.revision === null || typeof result.revision === 'string') || !Object.hasOwn(result, 'state')) throw error('云端进度响应无效。', 'INVALID_RESPONSE');
        revision = result.revision;
        conflict = false;
        return result.state;
      },
      saveProgress(userId, state) {
        const snapshot = JSON.parse(JSON.stringify(state));
        const saveGeneration = generation;
        writes = writes.catch(() => {}).then(async () => {
          assertUser(userId);
          if (saveGeneration !== generation) throw error('账号会话已改变，请重试。', 'SESSION_CHANGED');
          if (revision === undefined) throw error('尚未成功读取云端进度，暂不能保存。', 'PROGRESS_NOT_LOADED');
          if (conflict) throw error('另一台设备已更新进度，请先导出本页备份，再载入云端进度。', 'PROGRESS_CONFLICT', 409);
          try {
            const result = await request('progress', { method: 'PUT', data: { state: snapshot, revision } });
            if (typeof result.revision !== 'string') throw error('保存响应无效，请导出备份后重新读取云端进度。', 'INVALID_RESPONSE');
            revision = result.revision;
            return result;
          } catch (cause) {
            if (cause.code === 'PROGRESS_CONFLICT') conflict = true;
            throw cause;
          }
        });
        return writes;
      },
    };
  }
  return { createClient, SESSION_KEY };
});
