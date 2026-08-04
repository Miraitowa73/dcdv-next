const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSimulationTestbench,
  detectModuleInfo,
  parseModulePorts,
  parseSimulationRuntime,
  resolveTopModule,
  toVerilogLiteral,
} = require('../backend/verilog-backend');
const {
  buildDeepSeekPayload,
  extractVerilogCode,
  generateVerilogWithDeepSeek,
  loadDeepSeekConfig,
  parseChatCompletionContent,
} = require('../backend/deepseek-ai');

const DEEPSEEK_ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_THINKING'];

function stashDeepSeekEnv() {
  const previous = {};
  for (const key of DEEPSEEK_ENV_KEYS) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('detectModuleInfo finds unique top module from multi-module source', () => {
  const code = `
module child(input wire a, output wire y);
  assign y = a;
endmodule

module top(input wire clk, input wire rst, output wire y);
  child u_child(.a(clk), .y(y));
endmodule
`;

  const info = detectModuleInfo(code);
  assert.deepEqual(info.moduleNames, ['child', 'top']);
  assert.deepEqual(info.moduleCandidates, ['top']);
});

test('resolveTopModule parses ANSI bus ports', () => {
  const code = `
module top(
  input wire clk,
  input wire [7:0] a,
  output reg [3:0] y
);
always @(*) y = a[3:0];
endmodule
`;

  const resolved = resolveTopModule(code);
  assert.equal(resolved.selectedTop, 'top');
  assert.deepEqual(
    resolved.ports.map((port) => ({ name: port.name, direction: port.direction, width: port.width })),
    [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'a', direction: 'input', width: 8 },
      { name: 'y', direction: 'output', width: 4 },
    ]
  );
});

test('resolveTopModule ignores inline comments in ANSI port lists', () => {
  const code = `
module custom_logic (
    input  wire [3:0] bcd, // 4-bit BCD input
    output reg  [6:0] seg  // format: g f e d c b a
);
always @(*) seg = 7'b0000000;
endmodule
`;

  const resolved = resolveTopModule(code, 'custom_logic');
  assert.equal(resolved.selectedTop, 'custom_logic');
  assert.deepEqual(
    resolved.ports.map((port) => ({ name: port.name, direction: port.direction, width: port.width })),
    [
      { name: 'bcd', direction: 'input', width: 4 },
      { name: 'seg', direction: 'output', width: 7 },
    ]
  );
});

test('parseModulePorts supports non-ANSI declarations', () => {
  const code = `
module top(a, b, y);
  input [3:0] a, b;
  output [4:0] y;
  assign y = a + b;
endmodule
`;

  const resolved = resolveTopModule(code);
  assert.equal(resolved.selectedTop, 'top');
  assert.deepEqual(
    resolved.ports.map((port) => ({ name: port.name, direction: port.direction, width: port.width })),
    [
      { name: 'a', direction: 'input', width: 4 },
      { name: 'b', direction: 'input', width: 4 },
      { name: 'y', direction: 'output', width: 5 },
    ]
  );
});

test('buildSimulationTestbench uses selected top module and explicit step markers', () => {
  const ports = [
    { name: 'clk', direction: 'input', width: 1, msb: 0, lsb: 0 },
    { name: 'rst', direction: 'input', width: 1, msb: 0, lsb: 0 },
    { name: 'count', direction: 'output', width: 4, msb: 3, lsb: 0 },
  ];
  const signals = [
    { name: 'clk', kind: 'in', width: 1, radix: 'bin', values: [0, 1, 0] },
    { name: 'rst', kind: 'in', width: 1, radix: 'bin', values: [1, 0, 0] },
  ];

  const tb = buildSimulationTestbench({
    topModule: 'counter_top',
    ports,
    signals,
    stepNs: 10,
  });

  assert.match(tb, /counter_top uut/);
  assert.match(tb, /__DCDV_STEP__ 0/);
  assert.match(tb, /\$write\("%b", count\)/);
});

test('parseSimulationRuntime converts runtime lines into output signals', () => {
  const ports = [
    { name: 'y', direction: 'output', width: 1 },
    { name: 'bus', direction: 'output', width: 4 },
  ];
  const runtime = `
__DCDV_STEP__ 0 |y=0 |bus=0011
__DCDV_STEP__ 1 |y=1 |bus=1010
`;
  const outputs = parseSimulationRuntime(runtime, ports);
  assert.deepEqual(outputs, [
    { name: 'y', kind: 'out', width: 1, radix: 'bin', values: [0, 1] },
    { name: 'bus', kind: 'out', width: 4, radix: 'hex', values: ['0011', '1010'] },
  ]);
});

test('toVerilogLiteral normalizes bus inputs as fixed-width binary', () => {
  assert.equal(toVerilogLiteral('0x0f', 8, 'hex'), "8'b00001111");
  assert.equal(toVerilogLiteral(3, 4, 'dec'), "4'b0011");
});

test('loadDeepSeekConfig reports missing key and normalizes configured values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-ai-config-'));
  const restoreEnv = stashDeepSeekEnv();
  try {
    const missing = await loadDeepSeekConfig(root);
    assert.equal(missing.configured, false);
    assert.match(missing.errors[0], /DeepSeek API Key/);
    assert.equal(missing.model, 'deepseek-v4-flash');
    assert.equal(missing.thinking.type, 'disabled');

    fs.writeFileSync(
      path.join(root, 'deepseek.config.json'),
      JSON.stringify({
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/',
        model: 'deepseek-v4-flash',
        thinking: 'enabled',
      })
    );

    const configured = await loadDeepSeekConfig(root);
    assert.equal(configured.configured, true);
    assert.equal(configured.apiKey, 'sk-test');
    assert.equal(configured.baseUrl, 'https://api.deepseek.com');
    assert.equal(configured.model, 'deepseek-v4-flash');
    assert.equal(configured.thinking.type, 'enabled');
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadDeepSeekConfig prefers environment variables over local config file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-ai-env-config-'));
  const restoreEnv = stashDeepSeekEnv();

  try {
    fs.writeFileSync(
      path.join(root, 'deepseek.config.json'),
      JSON.stringify({
        apiKey: 'sk-file',
        baseUrl: 'https://file.example.com/',
        model: 'file-model',
        thinking: 'disabled',
      })
    );

    process.env.DEEPSEEK_API_KEY = 'sk-env';
    process.env.DEEPSEEK_BASE_URL = 'https://env.example.com/';
    process.env.DEEPSEEK_MODEL = 'env-model';
    process.env.DEEPSEEK_THINKING = 'enabled';

    const configured = await loadDeepSeekConfig(root);
    assert.equal(configured.configured, true);
    assert.equal(configured.apiKey, 'sk-env');
    assert.equal(configured.baseUrl, 'https://env.example.com');
    assert.equal(configured.model, 'env-model');
    assert.equal(configured.thinking.type, 'enabled');
    assert.equal(configured.source, 'environment');
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildDeepSeekPayload uses flash model with disabled thinking by default', () => {
  const payload = buildDeepSeekPayload({
    config: {
      model: 'deepseek-v4-flash',
      thinking: { type: 'disabled' },
    },
    messages: [{ role: 'user', content: 'hello' }],
    temperature: 0.15,
    maxTokens: 128,
  });

  assert.deepEqual(payload, {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    temperature: 0.15,
    max_tokens: 128,
    thinking: { type: 'disabled' },
  });
});

test('extractVerilogCode prefers fenced Verilog and removes explanations', () => {
  const generated = `
这里是代码：
\`\`\`verilog
module custom_logic(input wire a, output wire y);
  assign y = a;
endmodule
\`\`\`
可以直接编译。
`;

  assert.equal(
    extractVerilogCode(generated),
    'module custom_logic(input wire a, output wire y);\n  assign y = a;\nendmodule'
  );
});

test('parseChatCompletionContent reads OpenAI-compatible response content', () => {
  const content = parseChatCompletionContent({
    choices: [
      {
        message: {
          content: 'module custom_logic; endmodule',
        },
      },
    ],
  });

  assert.equal(content, 'module custom_logic; endmodule');
});

test('generateVerilogWithDeepSeek builds request and parses mocked response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-ai-generate-'));
  const restoreEnv = stashDeepSeekEnv();
  try {
    fs.writeFileSync(
      path.join(root, 'deepseek.config.json'),
      JSON.stringify({ apiKey: 'sk-secret', model: 'deepseek-v4-flash', thinking: 'disabled' })
    );

    const calls = [];
    const fetchImpl = async (requestUrl, options) => {
      calls.push({ requestUrl, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model: 'deepseek-v4-flash',
            choices: [
              {
                message: {
                  content: '```verilog\nmodule custom_logic;\nendmodule\n```',
                },
              },
            ],
            usage: { total_tokens: 42 },
          }),
      };
    };

    const result = await generateVerilogWithDeepSeek({
      projectRoot: root,
      description: '设计一个简单模块',
      fetchImpl,
    });

    assert.equal(result.ok, true);
    assert.equal(result.code, 'module custom_logic;\nendmodule');
    assert.equal(result.model, 'deepseek-v4-flash');
    assert.equal(result.usage.total_tokens, 42);
    assert.equal(calls[0].requestUrl, 'https://api.deepseek.com/chat/completions');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-secret');
    assert.equal(calls[0].body.model, 'deepseek-v4-flash');
    assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generateVerilogWithDeepSeek redacts api key from API errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-ai-error-'));
  const restoreEnv = stashDeepSeekEnv();
  try {
    fs.writeFileSync(path.join(root, 'deepseek.config.json'), JSON.stringify({ apiKey: 'sk-secret' }));

    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'invalid key sk-secret' } }),
    });

    await assert.rejects(
      () =>
        generateVerilogWithDeepSeek({
          projectRoot: root,
          description: '生成计数器',
          fetchImpl,
        }),
      (error) => {
        assert.equal(error.statusCode, 401);
        assert.match(error.message, /\[redacted\]/);
        assert.doesNotMatch(error.message, /sk-secret/);
        return true;
      }
    );
  } finally {
    restoreEnv();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
