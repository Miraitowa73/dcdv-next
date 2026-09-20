const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

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
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'assets', 'dcdv-login-cover-v1.webp'), Buffer.from('RIFF'));
  fs.writeFileSync(path.join(root, 'assets', 'scu-eec-logo-v1.webp'), Buffer.from('RIFF'));
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

test('DCDV NEXT uses the approved shared API while keeping local accounts separate', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'DCDV.html'), 'utf8');
  assert.match(html, /const DCDV_FC_API_BASE = 'https:\/\/dcdv-online-beydonrfai\.cn-hangzhou\.fcapp\.run'/);
  assert.doesNotMatch(html, /dcdv-next\.invalid/);
  assert.doesNotMatch(html, /dcdvChallengeProgressV1/);
  assert.doesNotMatch(html, /DCDV NEXT · 独立开发版/);
  assert.match(html, /id="auth-overlay"/);
  assert.match(html, /src="\.\/auth-local\.js"/);
  assert.match(html, /数字电路可视化Agent/);
  assert.match(html, /rel="preload" as="image" href="\.\/assets\/dcdv-login-cover-v1\.webp" type="image\/webp" fetchpriority="high"/);
  assert.match(html, /rel="preload" as="image" href="\.\/assets\/scu-eec-logo-v1\.webp" type="image\/webp" fetchpriority="high"/);
  assert.equal((html.match(/\.\/assets\/dcdv-login-cover-v1\.webp/g) || []).length, 2);
  assert.equal((html.match(/\.\/assets\/scu-eec-logo-v1\.webp/g) || []).length, 3);
  assert.doesNotMatch(html, /eec\.scu\.edu\.cn\/images\/logo-dgdz\.png/);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'assets', 'dcdv-login-cover-v1.webp')).size <= 100 * 1024);
  assert.ok(fs.statSync(path.join(__dirname, '..', 'assets', 'scu-eec-logo-v1.webp')).size <= 15 * 1024);
  assert.doesNotMatch(html, /\.auth-brand::after/);
  assert.match(html, /onclick="switchDcdvAccount\(\)"/);
  assert.match(html, />切换账号</);
  assert.match(html, />退出登录</);
  assert.doesNotMatch(html, /登录当前设备上的 DCDV NEXT 用户/);
});

function frontendApiContext(hostname, fetch, override) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'DCDV.html'), 'utf8');
  const start = html.indexOf('        const DCDV_FC_API_BASE =');
  const end = html.indexOf('        function syncCompiledDesignFromResponse', start);
  assert.ok(start >= 0 && end > start);
  const state = { status: null, summary: null };
  const context = vm.createContext({
    window: { location: { hostname }, DCDV_API_BASE: override },
    fetch,
    compiledDesign: { backend: { toolchain: { ok: true } }, compileOk: false },
    setBackendStatus: (tone, message) => { state.status = { tone, message }; },
    setCompiledSummary: (message) => { state.summary = message; },
    updateWaveBlockingHint: () => {},
  });
  vm.runInContext(html.slice(start, end), context);
  return { context, state };
}

test('Pages routes health, AI, compilation and simulation to the recorded live backend', () => {
  const { context } = frontendApiContext('miraitowa73.github.io');
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployment-record.json'), 'utf8'));
  assert.equal(record.next.backend_url, 'https://dcdv-online-beydonrfai.cn-hangzhou.fcapp.run');
  for (const endpoint of ['/api/health', '/api/ai/verilog/generate', '/api/ai/verilog/review', '/api/verilog/compile', '/api/verilog/simulate']) {
    assert.equal(context.resolveDcdvApiUrl(endpoint), `${record.next.backend_url}${endpoint}`);
  }
});

test('local development uses same-origin API and explicit overrides remain supported', () => {
  const local = frontendApiContext('localhost');
  assert.equal(local.context.resolveDcdvApiUrl('/api/health'), '/api/health');
  assert.match(local.context.getBackendConnectionMessage(), /npm start/);
  const override = frontendApiContext('localhost', undefined, 'https://backend.example.test///');
  assert.equal(override.context.resolveDcdvApiUrl('/api/health'), 'https://backend.example.test/api/health');
  assert.doesNotMatch(override.context.getBackendConnectionMessage(), /npm start/);
});

test('Pages network errors give cloud guidance and clear stale backend status', async () => {
  const { context, state } = frontendApiContext('miraitowa73.github.io', async () => {
    throw new TypeError('Failed to fetch');
  });
  await context.refreshBackendHealth();
  assert.equal(state.status.tone, 'bad');
  assert.match(state.summary, /云端后端/);
  assert.doesNotMatch(state.summary, /npm start|localhost/);
  assert.equal(context.compiledDesign.backend, null);
});

test('HTTP health failures are not reported as missing compilers', async () => {
  const { context, state } = frontendApiContext('miraitowa73.github.io', async () => ({
    ok: false, status: 502, json: async () => { throw new SyntaxError('HTML error page'); },
  }));
  await context.refreshBackendHealth();
  assert.equal(state.status.tone, 'bad');
  assert.match(state.summary, /HTTP 502/);
  assert.equal(context.compiledDesign.backend, null);
});

test('healthy backend is connected and missing compiler is reported separately', async () => {
  for (const ok of [true, false]) {
    const { context, state } = frontendApiContext('miraitowa73.github.io', async () => ({
      ok: true, json: async () => ({ ok: true, toolchain: { ok } }),
    }));
    await context.refreshBackendHealth();
    assert.equal(state.status.tone, ok ? 'good' : 'warn');
  }
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

    const loginCover = await request(port, { pathname: '/assets/dcdv-login-cover-v1.webp' });
    assert.equal(loginCover.statusCode, 200);
    assert.equal(loginCover.headers['content-type'], 'image/webp');

    const institutionLogo = await request(port, { pathname: '/assets/scu-eec-logo-v1.webp' });
    assert.equal(institutionLogo.statusCode, 200);
    assert.equal(institutionLogo.headers['content-type'], 'image/webp');

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
