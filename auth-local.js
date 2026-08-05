(function attachDcdvLocalAuth(root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DcdvLocalAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDcdvLocalAuth(root) {
  'use strict';

  const DB_NAME = 'dcdvNextLocalAccountsV1';
  const DB_VERSION = 1;
  const SESSION_KEY = 'dcdvNextSessionV1';
  const PROGRESS_SCHEMA_VERSION = 1;
  const EXPORT_KIND = 'dcdv-next-progress';
  const EXPORT_VERSION = 1;
  const PBKDF2_ITERATIONS = 310000;
  const PASSWORD_HASH_BYTES = 32;
  const USERNAME_MIN = 2;
  const USERNAME_MAX = 24;
  const PASSWORD_MIN = 8;
  const PASSWORD_MAX = 72;

  let databasePromise = null;

  function getCrypto() {
    const cryptoApi = root.crypto;
    if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
      throw new Error('当前浏览器不支持安全的本机账户功能。');
    }
    return cryptoApi;
  }

  function normalizeUsername(username) {
    return String(username || '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN');
  }

  function validateUsername(username) {
    const display = String(username || '').trim().normalize('NFKC');
    const length = Array.from(display).length;
    if (length < USERNAME_MIN || length > USERNAME_MAX) {
      return { ok: false, message: `用户名长度需为 ${USERNAME_MIN}-${USERNAME_MAX} 个字符。` };
    }
    if (!/^[\p{L}\p{N}_-]+$/u.test(display)) {
      return { ok: false, message: '用户名只能包含文字、字母、数字、下划线和中划线。' };
    }
    return { ok: true, value: display, key: normalizeUsername(display) };
  }

  function validatePassword(password) {
    const value = String(password || '');
    const length = Array.from(value).length;
    if (length < PASSWORD_MIN || length > PASSWORD_MAX) {
      return { ok: false, message: `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符。` };
    }
    return { ok: true, value };
  }

  function bytesToBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof btoa === 'function') {
      let binary = '';
      for (const byte of data) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(data).toString('base64');
    throw new Error('无法编码账户数据。');
  }

  function base64ToBytes(value) {
    if (typeof atob === 'function') {
      const binary = atob(String(value || ''));
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    }
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(value || ''), 'base64'));
    throw new Error('无法读取账户数据。');
  }

  async function derivePasswordHash(password, saltBytes, iterations = PBKDF2_ITERATIONS) {
    const cryptoApi = getCrypto();
    const keyMaterial = await cryptoApi.subtle.importKey(
      'raw',
      new TextEncoder().encode(String(password || '')),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = await cryptoApi.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes),
        iterations,
      },
      keyMaterial,
      PASSWORD_HASH_BYTES * 8
    );
    return new Uint8Array(bits);
  }

  function constantTimeEqual(left, right) {
    const a = left instanceof Uint8Array ? left : new Uint8Array(left || []);
    const b = right instanceof Uint8Array ? right : new Uint8Array(right || []);
    let mismatch = a.length ^ b.length;
    const maxLength = Math.max(a.length, b.length);
    for (let index = 0; index < maxLength; index += 1) {
      mismatch |= (a[index] || 0) ^ (b[index] || 0);
    }
    return mismatch === 0;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('本机账户数据库操作失败。'));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('本机账户数据库写入失败。'));
      transaction.onabort = () => reject(transaction.error || new Error('本机账户数据库写入已取消。'));
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!root.indexedDB) return Promise.reject(new Error('当前浏览器不支持 IndexedDB。'));
    databasePromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('users')) {
          const users = database.createObjectStore('users', { keyPath: 'id' });
          users.createIndex('usernameKey', 'usernameKey', { unique: true });
        }
        if (!database.objectStoreNames.contains('progress')) {
          database.createObjectStore('progress', { keyPath: 'userId' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('无法打开本机账户数据库。'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('本机账户数据库正在被其他页面占用，请关闭旧页面后重试。'));
      };
    });
    return databasePromise;
  }

  async function getUserById(userId) {
    if (!userId) return null;
    const database = await openDatabase();
    const transaction = database.transaction('users', 'readonly');
    return (await requestResult(transaction.objectStore('users').get(userId))) || null;
  }

  async function getUserByUsername(username) {
    const usernameKey = normalizeUsername(username);
    if (!usernameKey) return null;
    const database = await openDatabase();
    const transaction = database.transaction('users', 'readonly');
    return (await requestResult(transaction.objectStore('users').index('usernameKey').get(usernameKey))) || null;
  }

  function publicUser(record) {
    if (!record) return null;
    return {
      id: record.id,
      username: record.username,
      createdAt: record.createdAt,
      lastLoginAt: record.lastLoginAt,
    };
  }

  function createUserId() {
    const cryptoApi = getCrypto();
    if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `local-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function writeSession(userId) {
    if (!root.sessionStorage) return;
    root.sessionStorage.setItem(SESSION_KEY, JSON.stringify({ userId, version: 1 }));
  }

  function clearSession() {
    root.sessionStorage?.removeItem(SESSION_KEY);
  }

  async function createUser(username, password) {
    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) throw new Error(usernameCheck.message);
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) throw new Error(passwordCheck.message);
    if (await getUserByUsername(usernameCheck.value)) throw new Error('该用户名已存在，请直接登录。');

    const cryptoApi = getCrypto();
    const salt = cryptoApi.getRandomValues(new Uint8Array(16));
    const passwordHash = await derivePasswordHash(passwordCheck.value, salt);
    const now = new Date().toISOString();
    const record = {
      id: createUserId(),
      username: usernameCheck.value,
      usernameKey: usernameCheck.key,
      salt: bytesToBase64(salt),
      passwordHash: bytesToBase64(passwordHash),
      passwordAlgorithm: 'PBKDF2-SHA256',
      passwordIterations: PBKDF2_ITERATIONS,
      createdAt: now,
      lastLoginAt: now,
      schemaVersion: 1,
    };

    const database = await openDatabase();
    const transaction = database.transaction('users', 'readwrite');
    transaction.objectStore('users').add(record);
    try {
      await transactionComplete(transaction);
    } catch (error) {
      if (error?.name === 'ConstraintError') throw new Error('该用户名已存在，请直接登录。');
      throw error;
    }
    writeSession(record.id);
    return publicUser(record);
  }

  async function authenticate(username, password) {
    const record = await getUserByUsername(username);
    const genericError = new Error('用户名或密码错误。');
    if (!record) {
      const cryptoApi = getCrypto();
      const dummySalt = cryptoApi.getRandomValues(new Uint8Array(16));
      await derivePasswordHash(String(password || ''), dummySalt);
      throw genericError;
    }
    const candidate = await derivePasswordHash(
      String(password || ''),
      base64ToBytes(record.salt),
      Number(record.passwordIterations) || PBKDF2_ITERATIONS
    );
    if (!constantTimeEqual(candidate, base64ToBytes(record.passwordHash))) throw genericError;

    record.lastLoginAt = new Date().toISOString();
    const database = await openDatabase();
    const transaction = database.transaction('users', 'readwrite');
    transaction.objectStore('users').put(record);
    await transactionComplete(transaction);
    writeSession(record.id);
    return publicUser(record);
  }

  async function restoreSession() {
    try {
      const raw = root.sessionStorage?.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const record = await getUserById(parsed.userId);
      if (!record) clearSession();
      return publicUser(record);
    } catch (error) {
      clearSession();
      return null;
    }
  }

  function cloneSerializable(value) {
    return JSON.parse(JSON.stringify(value ?? null));
  }

  async function saveProgress(userId, state) {
    if (!userId) throw new Error('请先登录后再保存进度。');
    const database = await openDatabase();
    const transaction = database.transaction('progress', 'readwrite');
    transaction.objectStore('progress').put({
      userId,
      schemaVersion: PROGRESS_SCHEMA_VERSION,
      state: cloneSerializable(state),
      updatedAt: new Date().toISOString(),
    });
    await transactionComplete(transaction);
  }

  async function loadProgress(userId) {
    if (!userId) return null;
    const database = await openDatabase();
    const transaction = database.transaction('progress', 'readonly');
    const record = await requestResult(transaction.objectStore('progress').get(userId));
    if (!record || record.schemaVersion !== PROGRESS_SCHEMA_VERSION) return null;
    return cloneSerializable(record.state);
  }

  function createProgressExport(user, progress) {
    return {
      kind: EXPORT_KIND,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      user: { username: String(user?.username || '') },
      progress: cloneSerializable(progress),
    };
  }

  function validateProgressExport(payload) {
    if (!payload || payload.kind !== EXPORT_KIND) throw new Error('文件不是 DCDV NEXT 进度备份。');
    if (payload.version !== EXPORT_VERSION) throw new Error(`暂不支持进度文件版本 ${payload.version}。`);
    if (!payload.progress || typeof payload.progress !== 'object' || Array.isArray(payload.progress)) {
      throw new Error('进度文件内容无效。');
    }
    return cloneSerializable(payload.progress);
  }

  return {
    DB_NAME,
    EXPORT_KIND,
    EXPORT_VERSION,
    PBKDF2_ITERATIONS,
    SESSION_KEY,
    authenticate,
    base64ToBytes,
    bytesToBase64,
    clearSession,
    constantTimeEqual,
    createProgressExport,
    createUser,
    derivePasswordHash,
    loadProgress,
    normalizeUsername,
    restoreSession,
    saveProgress,
    validatePassword,
    validateProgressExport,
    validateUsername,
  };
});
