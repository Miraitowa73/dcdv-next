const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createDcdvServer } = require('../server');

function makeProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-server-'));
  fs.writeFileSync(path.join(root, 'DCDV.html'), '<!doctype html><title>DCDV</title>');
  fs.writeFileSync(path.join(root, 'auth-local.js'), 'window.DcdvLocalAuth = {};');
  fs.writeFileSync(path.join(root, 'server.js'), 'secret');
  fs.writeFileSync(path.join(root, 'deepseek.config.json'), '{"apiKey":"sk-secret"}');
  fs.mkdirSync(path.join(root, 'backend'));
  fs.writeFileSync(path.join(root, 'backend', 'deepseek-ai.js'), 'secret');
  fs.mkdirSync(path.join(root, 'screenshots'));
  fs.writeFileSync(path.join(root, 'screenshots', 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function request(port, { method = 'GET', pathname = '/', body, headers = {} } = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk.toString();
        });
        res.on('end', () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (error) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('DCDV NEXT frontend never targets the protected legacy backend', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'DCDV.html'), 'utf8');
  assert.doesNotMatch(html, /dcdv-online-beydonrfai\.cn-hangzhou\.fcapp\.run/);
  assert.doesNotMatch(html, /dcdvChallengeProgressV1/);
  assert.doesNotMatch(html, /DCDV NEXT · 独立开发版/);
  assert.match(html, /id="auth-overlay"/);
  assert.match(html, /src="\.\/auth-local\.js"/);
  assert.match(html, /数字电路可视化Agent/);
  assert.match(html, /onclick="switchDcdvAccount\(\)"/);
  assert.match(html, />切换账号</);
  assert.match(html, />退出登录</);
  assert.doesNotMatch(html, /登录当前设备上的 DCDV NEXT 用户/);
  assert.equal((html.match(/https:\/\/eec\.scu\.edu\.cn\/images\/logo-dgdz\.png/g) || []).length, 2);
});

test('static server only exposes the app page and public images', async () => {
  const root = makeProjectRoot();
  const server = createDcdvServer({ projectRoot: root });
  const port = await listen(server);

  try {
    const home = await request(port);
    assert.equal(home.statusCode, 200);
    assert.match(home.text, /DCDV/);

    const image = await request(port, { pathname: '/screenshots/preview.png' });
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');

    const authModule = await request(port, { pathname: '/auth-local.js' });
    assert.equal(authModule.statusCode, 200);
    assert.equal(authModule.headers['content-type'], 'application/javascript; charset=utf-8');

    const serverSource = await request(port, { pathname: '/server.js' });
    assert.equal(serverSource.statusCode, 403);

    const config = await request(port, { pathname: '/deepseek.config.json' });
    assert.equal(config.statusCode, 403);

    const backend = await request(port, { pathname: '/backend/deepseek-ai.js' });
    assert.equal(backend.statusCode, 403);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI endpoints are rate limited per client', async () => {
  const root = makeProjectRoot();
  const server = createDcdvServer({
    projectRoot: root,
    rateLimits: {
      ai: { max: 1, windowMs: 60_000 },
      verilog: { max: 0, windowMs: 60_000 },
    },
    handlers: {
      generateVerilogWithDeepSeek: async () => ({ ok: true, code: 'module custom_logic; endmodule' }),
    },
  });
  const port = await listen(server);

  try {
    const first = await request(port, {
      method: 'POST',
      pathname: '/api/ai/verilog/generate',
      body: { description: 'simple gate' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(first.statusCode, 200);

    const second = await request(port, {
      method: 'POST',
      pathname: '/api/ai/verilog/generate',
      body: { description: 'simple gate' },
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json.code, 'rate_limited');
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('API endpoints allow GitHub Pages CORS requests', async () => {
  const root = makeProjectRoot();
  const server = createDcdvServer({
    projectRoot: root,
    handlers: {
      getToolchainStatus: async () => ({ ok: true }),
    },
  });
  const port = await listen(server);

  try {
    const preflight = await request(port, {
      method: 'OPTIONS',
      pathname: '/api/health',
      headers: {
        Origin: 'https://miraitowa73.github.io',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://miraitowa73.github.io');
    assert.match(preflight.headers['access-control-allow-methods'], /GET/);

    const health = await request(port, {
      pathname: '/api/health',
      headers: { Origin: 'https://miraitowa73.github.io' },
    });
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers['access-control-allow-origin'], 'https://miraitowa73.github.io');
    assert.equal(health.json.service, 'dcdv-next-backend');
    assert.equal(health.json.deployment, 'dcdv-next-local');
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Verilog endpoints enforce concurrent job limit', async () => {
  const root = makeProjectRoot();
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  let finishCompile;

  const server = createDcdvServer({
    projectRoot: root,
    maxVerilogJobs: 1,
    rateLimits: {
      ai: { max: 0, windowMs: 60_000 },
      verilog: { max: 0, windowMs: 60_000 },
    },
    handlers: {
      compileDesign: async () => {
        markEntered();
        await new Promise((resolve) => {
          finishCompile = resolve;
        });
        return {
          ok: true,
          errors: [],
          warnings: [],
          moduleCandidates: ['top'],
          selectedTop: 'top',
          ports: [],
          sourceHash: 'hash',
          compilerLog: '',
        };
      },
    },
  });
  const port = await listen(server);

  try {
    const first = request(port, {
      method: 'POST',
      pathname: '/api/verilog/compile',
      body: { code: 'module top; endmodule' },
    });
    await entered;

    const second = await request(port, {
      method: 'POST',
      pathname: '/api/verilog/compile',
      body: { code: 'module top; endmodule' },
    });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json.code, 'rate_limited');

    finishCompile();
    const firstResult = await first;
    assert.equal(firstResult.statusCode, 200);
  } finally {
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
