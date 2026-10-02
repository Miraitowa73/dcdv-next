const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { getToolchainStatus, resolveExecutable } = require('../backend/verilog-backend');

const html = fs.readFileSync(path.join(__dirname, '..', 'DCDV.html'), 'utf8');
const sourceFunction = name => {
  const match = html.match(new RegExp(`^        function ${name}\\([^]*?^        }`, 'm'));
  assert.ok(match, name);
  return match[0];
};
function fixture() {
  const fpga = { type: 'FPGA', params: { presetKey: 'dds-signal-generator' }, state: {} };
  const opamp = { type: 'OPAMP', params: { presetNode: 'DDS_OUT' }, state: {} };
  const cap = { type: 'CAP', params: { presetNode: 'PWM_RC_OUT', simTau: .00045 }, state: {} };
  const mixedState = { components: [fpga, opamp, cap], sim: { presetState: {}, logic: {} } };
  const context = vm.createContext({ mixedState, pauseMixedSimulation() {}, showToast() {} });
  vm.runInContext(['generateDdsSignalGeneratorPresetHdl', 'stripDdsComments', 'parseDdsHdlConfig',
    'isLegacyDdsHdl', 'getDdsRuntimeConfig', 'getDdsSampleCode', 'stepDdsSignalGeneratorPreset']
    .map(sourceFunction).join('\n'), context);
  const original = context.generateDdsSignalGeneratorPresetHdl();
  fpga.params.hdl = original;
  const withParams = params => Object.entries(params).reduce((code, [key, value]) =>
    code.replace(new RegExp(`(parameter integer ${key} = )\\d+`), (_, prefix) => prefix + value), original);
  return { context, original, withParams, fpga, opamp, cap, mixedState };
}

test('DDS reads all four HDL parameters including Verilog literals and ignores commented copies', () => {
  const f = fixture();
  const code = f.withParams({ WAVE_TYPE: "2'd2", FREQUENCY_HZ: "16'h00f0", AMPLITUDE_MV: '1_000', OFFSET_MV: '2000' });
  const config = f.context.parseDdsHdlConfig('// parameter integer WAVE_TYPE = 3\n' + code);
  assert.deepEqual(JSON.parse(JSON.stringify(config)), { WAVE_TYPE: 2, FREQUENCY_HZ: 240, AMPLITUDE_MV: 1000, OFFSET_MV: 2000 });
});

test('invalid, ambiguous or unsupported HDL edits cannot silently drive a different simulation', () => {
  const f = fixture();
  for (const values of [
    { WAVE_TYPE: 4 }, { FREQUENCY_HZ: 0 }, { FREQUENCY_HZ: 1001 },
    { AMPLITUDE_MV: 2501 }, { OFFSET_MV: 100 }, { WAVE_TYPE: "1'd2" },
    { WAVE_TYPE: "2'b12" }, { WAVE_TYPE: '1 + 1' }, { FREQUENCY_HZ: '1.5' },
  ]) assert.throws(() => f.context.parseDdsHdlConfig(f.withParams(values)), JSON.stringify(values));
  assert.throws(() => f.context.parseDdsHdlConfig(f.original.replace('assign DA = dac_code[9:0]', "assign DA = 10'd0")));
  assert.throws(() => f.context.parseDdsHdlConfig(f.original.replace('parameter integer WAVE_TYPE = 0,', '')));
  assert.throws(() => f.context.parseDdsHdlConfig(f.original.replace('parameter integer WAVE_TYPE = 0,', 'parameter integer WAVE_TYPE = 0, parameter integer WAVE_TYPE = 2,')));
});

test('waveforms have distinct shapes and requested voltage range including zero amplitude', () => {
  const f = fixture();
  const waves = [0, 1, 2, 3].map(WAVE_TYPE => {
    const c = f.context.parseDdsHdlConfig(f.withParams({ WAVE_TYPE, AMPLITUDE_MV: 1000, OFFSET_MV: 2000 }));
    return Array.from({ length: 256 }, (_, i) => f.context.getDdsSampleCode(c, i * 65536));
  });
  assert.equal(new Set(waves.map(JSON.stringify)).size, 4);
  for (const wave of waves) {
    assert.ok(Math.min(...wave) >= 204 && Math.min(...wave) <= 206);
    assert.ok(Math.max(...wave) >= 608 && Math.max(...wave) <= 615);
  }
  assert.ok(waves[0][64] > waves[0][0] && waves[0][192] < waves[0][0]);
  assert.ok(waves[2][0] < waves[2][64] && waves[2][64] < waves[2][127]);
  assert.equal(new Set(waves[3]).size, 2);
  const dc = f.context.parseDdsHdlConfig(f.withParams({ AMPLITUDE_MV: 0, OFFSET_MV: 1000 }));
  assert.equal(new Set(Array.from({ length: 256 }, (_, i) => f.context.getDdsSampleCode(dc, i * 65536))).size, 1);
});

test('runtime uses saved code after reset and produces matching DA bits, analog and PWM outputs', () => {
  const f = fixture();
  f.fpga.params.hdl = f.withParams({ WAVE_TYPE: 2, FREQUENCY_HZ: 600 });
  const pins = Array.from({ length: 10 }, (_, i) => ({ id: `DA${i}` })).concat({ id: 'PWM_Out' });
  f.context.stepDdsSignalGeneratorPreset(pins, 100 / 2457600, f.fpga);
  const code = f.context.getDdsSampleCode(f.context.getDdsRuntimeConfig(f.fpga), 4096 * 100);
  const reconstructed = pins.slice(0, 10).reduce((n, p, i) => n | (f.mixedState.sim.logic[`FPGA:${p.id}`] << i), 0);
  assert.equal(reconstructed, code);
  assert.equal(f.opamp.state.analog, code * 5 / 1023);
  assert.equal(f.mixedState.sim.logic['FPGA:PWM_Out'], Number(100 < code));
  assert.ok(Number.isFinite(f.cap.state.analog));
  f.fpga.params.hdl = f.withParams({ WAVE_TYPE: 3, FREQUENCY_HZ: 300 });
  f.mixedState.sim.presetState = {};
  f.context.stepDdsSignalGeneratorPreset(pins, 100 / 2457600, f.fpga);
  assert.equal(f.mixedState.sim.presetState.waveType, 3);
  assert.equal(f.mixedState.sim.presetState.outputHz, 300);
  assert.equal(f.mixedState.sim.presetState.phaseAcc, 2048 * 100);
});

test('editor rejects invalid saves atomically and applies valid HDL before restarting simulation', () => {
  const f = fixture();
  const inputs = { 'fpga-hdl-source': { value: f.withParams({ WAVE_TYPE: 9 }) }, 'mixed-dt': {}, 'mixed-duration': {} };
  const calls = [];
  Object.assign(f.context, {
    fpgaEditorComp: f.fpga, document: { getElementById: id => inputs[id] },
    updateFpgaEditorStatus: () => calls.push('invalid'), resetMixedSimulation: () => calls.push('reset'),
    closeFpgaHdlEditor: () => calls.push('close'), startMixedSimulation: () => calls.push('start'), mixedLog() {},
  });
  vm.runInContext(sourceFunction('saveFpgaHdlEditor'), f.context);
  f.context.saveFpgaHdlEditor();
  assert.equal(f.fpga.params.hdl, f.original);
  assert.deepEqual(calls, ['invalid']);
  inputs['fpga-hdl-source'].value = f.withParams({ WAVE_TYPE: 2, FREQUENCY_HZ: 200 });
  f.context.saveFpgaHdlEditor();
  assert.equal(f.context.parseDdsHdlConfig(f.fpga.params.hdl).WAVE_TYPE, 2);
  assert.deepEqual(calls, ['invalid', 'reset', 'close', 'start']);
  assert.equal(Number(inputs['mixed-dt'].value), .00005);
  assert.equal(Number(inputs['mixed-duration'].value), .015);
});

test('Icarus output matches model samples over full cycles for four waves and custom amplitude/frequency', async t => {
  if (!(await getToolchainStatus()).ok) return t.skip('Icarus toolchain unavailable');
  const f = fixture();
  const configurations = [0, 1, 2, 3].map(WAVE_TYPE => ({ WAVE_TYPE, FREQUENCY_HZ: 600, AMPLITUDE_MV: 2300, OFFSET_MV: 2500 }));
  configurations.push({ WAVE_TYPE: 2, FREQUENCY_HZ: 300, AMPLITUDE_MV: 1000, OFFSET_MV: 2000 });
  const instances = configurations.map((c, i) => `wire [9:0] da${i}; wire pwm${i};
    dds_signal_generator_top #(${Object.entries(c).map(([key, value]) => `.${key}(${value})`).join(',')}) u${i}
    (.clk_in(clk), .sys_rst_n(rst), .DA(da${i}), .PWM_Out(pwm${i}), .dac_clk());`).join('\n');
  const args = configurations.flatMap((_, i) => [`da${i}`, `pwm${i}`]).join(',');
  const code = `${f.original}\nmodule tb;
    reg clk=0; reg rst=1; integer i;
    ${instances}
    initial begin
      #1 rst=0; #1 rst=1;
      for(i=1;i<=8192;i=i+1) begin
        #1 clk=1; #1;
        if(i % 16 == 0) $display("S %d ${configurations.map(() => '%d %d').join(' ')}", i, ${args});
        clk=0;
      end
      $finish;
    end
  endmodule`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dcdv-dds-test-'));
  const source = path.join(directory, 'dds.v');
  const compiled = path.join(directory, 'dds.vvp');
  try {
    fs.writeFileSync(source, code);
    const compile = spawnSync(resolveExecutable('iverilog'), ['-g2012', '-s', 'tb', '-o', compiled, source], { encoding: 'utf8', timeout: 20000 });
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(resolveExecutable('vvp'), [compiled], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 0, run.stderr);
    const rows = run.stdout.split(/\r?\n/).filter(line => line.startsWith('S '));
    assert.equal(rows.length, 512);
    for (const row of rows) {
      const [tick, ...values] = row.slice(2).trim().split(/\s+/).map(Number);
      configurations.forEach((config, i) => {
        const step = Math.round(config.FREQUENCY_HZ * 16777216 / 2457600);
        const expected = f.context.getDdsSampleCode(config, (tick * step) % 16777216);
        assert.equal(values[i * 2], expected, `wave ${config.WAVE_TYPE}, tick ${tick}`);
        assert.equal(values[i * 2 + 1], Number(tick % 1024 < expected), `PWM ${i}, tick ${tick}`);
      });
    }
  } finally {
    fs.unlinkSync(source);
    if (fs.existsSync(compiled)) fs.unlinkSync(compiled);
    fs.rmdirSync(directory);
  }
});
