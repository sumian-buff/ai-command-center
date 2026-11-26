import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const replay = fileURLToPath(new URL('./fixtures/deepseek-replay.cjs', import.meta.url));
const prompt = '只测试「中文 路径」和 "双引号"。\n第二行 & % !';
const sessionId = 'session-4a020f2b-2e8a-4bd8-977c-175bd7f7a023';

function packets(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc dsh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  for (const file of fs.readdirSync(repo).filter((f) => /\.[cm]js$/.test(f))) {
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  const install = path.join(root, '模拟安装');
  const resources = path.join(install, 'resources');
  const command = path.join(resources, 'runtime', 'cli', 'bin', 'dsh.cmd');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  for (const placeholder of [command, path.join(install, 'DeepSeek Harness.exe'), path.join(resources, 'app.asar')]) {
    fs.writeFileSync(placeholder, '');
  }
  const defaults = JSON.parse(fs.readFileSync(path.join(repo, 'agents.default.json'), 'utf8'));
  const entry = defaults.find((a) => a.id === 'deepseek');
  fs.writeFileSync(path.join(root, 'agents.default.json'), JSON.stringify([{ ...entry, command }]));
  const promptFile = path.join(root, '测试文字.txt');
  fs.writeFileSync(promptFile, prompt);
  const card = path.join(root, 'runs', 'one', 'agents', '资料助手');

  function dispatch(scenario, cmd, args = []) {
    const argv = ['--require', replay, path.join(root, 'dispatch.mjs'), cmd, '--run', 'one', '--name', '资料助手', ...args];
    return new Promise((resolve, reject) => {
      const env = { ...process.env, DSH_TEST_DIR: root, DSH_TEST_SCENARIO: scenario };
      execFile(process.execPath, argv, { cwd: root, env, windowsHide: true, timeout: 15_000 }, (err, out, stderr) => {
        if (err && !Number.isInteger(err.code)) return reject(err);
        resolve({ code: err?.code || 0, output: out + stderr });
      });
    });
  }
  return {
    root, resources, card,
    launch: (scenario) => dispatch(scenario, 'run', ['--agent', 'deepseek', '--cwd', root, '--readonly', '--prompt-file', promptFile]),
    dispatch,
    meta: () => JSON.parse(fs.readFileSync(path.join(card, 'meta.json'), 'utf8')),
    events: () => packets(path.join(card, 'events.jsonl')),
    wire: () => packets(path.join(root, 'wire.jsonl')),
  };
}

test('DeepSeek 离线调度：按只读权限从标准输入接收任务，接着同一会话累计用量', async (t) => {
  const h = setup(t);
  const first = await h.launch('question');
  assert.equal(first.code, 1, first.output);
  assert.equal(h.meta().status, 'question');
  assert.deepEqual(h.meta().options, ['红色', '蓝色']);
  assert.equal(h.meta().convId, sessionId);
  assert.equal(h.meta().tokens, 11);
  assert.equal(h.events().at(-1).type, 'question');
  const reply = '选第一个，请继续。';
  const resumed = await h.dispatch('ok', 'resume', ['--text', reply]);
  assert.equal(resumed.code, 0, resumed.output);
  const [start, next] = h.wire();
  const cli = path.join(h.resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const prefix = ['--expose-internals', cli, '--profile', 'headless', '--json'];
  const permission = ['--permission-mode', 'read-only', '--approval-policy', 'never', '-'];
  assert.deepEqual(start.args, [...prefix, ...permission]);
  assert.deepEqual(next.args, [...prefix, '--session-id', sessionId, ...permission]);
  assert.ok(start.input.includes(prompt));
  assert.match(start.input, /不要执行 git commit \/ git push/);
  assert.ok(next.input.startsWith(reply));
  for (const packet of [start, next]) {
    assert.equal(packet.runAsNode, '1');
    assert.equal(packet.cwd, h.root);
  }
  assert.equal(h.meta().status, 'done');
  assert.equal(h.meta().convId, sessionId);
  assert.equal(h.meta().tokens, 22);
  assert.equal(h.events().at(-1).type, 'done');
  assert.ok(h.events().some((ev) => ev.type === 'say' && ev.text === '整理完毕。'));
  assert.match(fs.readFileSync(path.join(h.card, 'raw.log'), 'utf8'), /"phase":"step_end"/);
  assert.equal(fs.readFileSync(path.join(h.card, 'result.md'), 'utf8'), '整理完毕。');
});

for (const [scenario, status, event, reason] of [
  ['truncated', 'failed', 'error', /没有返回完整/],
  ['login', 'blocked', 'blocked', /被阻碍：.*登录/],
]) {
  test('DeepSeek 离线调度：' + (scenario === 'login' ? '登录失败时保留被阻碍原因' : '没有 final 的零退出码仍记为失败'), async (t) => {
    const h = setup(t);
    const { code, output } = await h.launch(scenario);
    assert.equal(code, 1, output);
    assert.equal(h.meta().status, status);
    assert.equal(h.events().at(-1).type, event);
    assert.match(fs.readFileSync(path.join(h.card, 'result.md'), 'utf8'), reason);
  });
}

test('DeepSeek 离线调度：停止请求指向模拟进程树，进程退出后留下停止记录', async (t) => {
  const h = setup(t);
  const running = h.launch('stop');
  try {
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(path.join(h.root, 'wire.jsonl')) && Date.now() < deadline) await delay(25);
    const [{ pid }] = h.wire();
    assert.equal(h.meta().childPid, pid);
    const stop = await h.dispatch('stop', 'stop');
    assert.equal(stop.code, 0, stop.output);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.root, 'taskkill.json'), 'utf8')), ['/PID', String(pid), '/T', '/F']);
    assert.equal((await running).code, 1);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(h.meta().childPid, null);
    assert.equal(h.meta().status, 'stopped');
    assert.equal(h.events().at(-1).type, 'stopped');
  } finally {
    await running;
  }
});
