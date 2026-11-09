// Local-only UI verification. No data survives process exit; never deploy this file.
'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createAccountService } = require('../cloud-account/service');
const { memoryStore } = require('../tests/helpers/account-store');
const { resolvePublicStaticPath } = require('../server');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.DCDV_ACCOUNT_PREVIEW_PORT || 8975);
const origin = `http://127.0.0.1:${port}`;
const store = memoryStore();
const ready = process.env.DCDV_CLASSROOM_PREVIEW === '1'
  ? require('../cloud-account/identity').newUser('preview-admin', 'Preview-only-password', { role: 'admin', displayName: '本地测试管理员' }).then(user => store.put('users', user.usernameKey, user, null))
  : Promise.resolve();
const handle = createAccountService({ store, allowedOrigins: [origin] });
http.createServer(async (req, res) => {
  try {
    await ready;
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/api/account/')) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1100000) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      const result = await handle({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), sourceIp: req.socket.remoteAddress });
      res.writeHead(result.statusCode, result.headers); res.end(result.body); return;
    }
    if (['/account-config.js', '/cloud-test/account-config.js', '/legacy-config.js'].includes(pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      res.end(`window.DCDV_ACCOUNT_API_BASE = ${JSON.stringify(pathname === '/legacy-config.js' ? '' : origin)};`); return;
    }
    const file = resolvePublicStaticPath(root, pathname === '/legacy.html' ? '/DCDV.html' : pathname);
    if (!file) { res.writeHead(404); res.end(); return; }
    let content = await fs.readFile(file);
    if (file.endsWith('.html')) {
      content = content.toString().replace('<title>DCDV - Digital Circuit Design Visualizer</title>', '<title>DCDV 云端账号本地测试</title>');
      if (pathname === '/legacy.html') content = content.replace('./account-config.js', './legacy-config.js');
      content = content.replace('<body ', '<body data-preview="local-test-only" ');
    }
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(content);
  } catch { res.writeHead(500); res.end('Local preview error'); }
}).listen(port, '127.0.0.1', () => console.log(`Local account preview: ${origin}/cloud-test/ (memory store, test only)`));
