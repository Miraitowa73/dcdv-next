const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { resolvePublicStaticPath } = require('../server');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'cloud-test/index.html'), 'utf8');

test('independent test entry selects the cloud service and fails closed, while original stays local', () => {
  const original = fs.readFileSync(path.join(root, 'DCDV.html'), 'utf8');
  assert.doesNotMatch(original, /auth-cloud\.js|DCDV_ACCOUNT_API_BASE/);
  assert.match(html, /云端账号.*测试版/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(html, /<base\b/); // Preserve SVG fragment references.
  const context = { window: { DcdvLocalAuth: {}, sessionStorage: {}, fetch() {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloud-test/account-config.js'), 'utf8'), context);
  let options;
  context.window.DcdvCloudAuth = { createClient(input) { options = input; return { isCloud: true }; } };
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  const authInit = scripts.find(script => script.includes('window.DcdvAuth ='));
  vm.runInNewContext(authInit, context);
  assert.equal(options.baseUrl, 'https://dcdv-ne-account-mswdnmdfrd.cn-hangzhou.fcapp.run');
  assert.equal(context.window.DcdvAuth.isCloud, true);
  delete context.window.DcdvCloudAuth;
  assert.throws(() => vm.runInNewContext(authInit, context));
  for (const script of scripts) new vm.Script(script);
});

test('migration is explicit, defaults to keeping original data, and local static routes stay limited', () => {
  const checkbox = html.match(/<input\b[^>]*id="auth-remove-local"[^>]*>/)[0];
  assert.doesNotMatch(checkbox, /\bchecked\b/);
  assert.match(html, /href="\.\.\/DCDV\.html"/);
  assert.equal(resolvePublicStaticPath(root, '/cloud-test/'), path.join(root, 'cloud-test/index.html'));
  for (const file of ['auth-local.js', 'account-config.js']) {
    assert.equal(resolvePublicStaticPath(root, `/cloud-test/${file}`), path.join(root, 'cloud-test', file));
  }
  assert.equal(resolvePublicStaticPath(root, '/cloud-test/private.json'), null);
  for (const match of html.matchAll(/(?:src|href)="((?:\.\/|\.\.\/)[^"]+)"/g)) {
    assert.ok(fs.existsSync(path.resolve(root, 'cloud-test', match[1])), `Missing asset: ${match[1]}`);
  }
});
