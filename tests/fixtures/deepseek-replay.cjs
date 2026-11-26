// Synthetic headless protocol events for offline dispatcher tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { setTimeout: delay } = require('node:timers/promises');

const root = process.env.DSH_TEST_DIR;
const wire = path.join(root, 'wire.jsonl');
const sessionId = 'session-4a020f2b-2e8a-4bd8-977c-175bd7f7a023';

async function replay() {
  const args = process.argv.slice(2);
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const packet = { pid: process.pid, args, input, cwd: process.cwd(), runAsNode: process.env.ELECTRON_RUN_AS_NODE };
  fs.appendFileSync(wire, JSON.stringify(packet) + '\n');
  const send = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  send({ type: 'session', sessionId, cwd: process.cwd() });
  switch (process.env.DSH_TEST_SCENARIO) {
    case 'login':
      send({ type: 'error', message: 'ACCOUNT_SIGN_IN_REQUIRED' });
      process.exitCode = 1;
      return;
    case 'truncated':
      send({ type: 'text', text: '尚未形成最终回复' });
      return;
    case 'stop': {
      // Simulate the OS delivering the recorded termination request to this fake child.
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(path.join(root, 'taskkill.json')) && Date.now() < deadline) await delay(25);
      process.exitCode = 1;
      return;
    }
  }
  const text = process.env.DSH_TEST_SCENARIO === 'question'
    ? '需要你选择：\n1. 红色\n2. 蓝色' : '整理完毕。';
  send({ type: 'text', text });
  send({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } });
  send({ type: 'final', sessionId, text, reason: { kind: 'completed' } });
}

if (require.main === module) {
  replay().catch((err) => { console.error(err); process.exitCode = 1; });
} else {
  // Only the placeholder in this test's directory may reach the replay program.
  const spawn = cp.spawn;
  cp.spawn = (exe, args, options) => {
    assert.equal(exe, path.join(root, '模拟安装', 'DeepSeek Harness.exe'));
    assert.ok(!options.shell);
    return spawn(process.execPath, [__filename, ...args], options);
  };
  cp.execFileSync = (exe, args) => {
    assert.equal(exe, 'taskkill');
    const { pid } = JSON.parse(fs.readFileSync(wire, 'utf8').trim().split('\n').at(-1));
    assert.deepEqual(args, ['/PID', String(pid), '/T', '/F']);
    fs.writeFileSync(path.join(root, 'taskkill.json'), JSON.stringify(args));
  };
  syncBuiltinESMExports();
}
