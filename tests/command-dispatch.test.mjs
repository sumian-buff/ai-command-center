import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/custom-cli.cjs', import.meta.url));
const prompt = '请核对 "中文 名称" 与 %AICC_LOCALE% & !\n保留第二行和 {session}。';
const label = '清单 "名 称" 与 %PATH% & !';
const choices = '需要你选择：\n1. 检查名称\n2. 检查顺序';

function jsonLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  for (const file of fs.readdirSync(repo).filter(f => /\.[cm]js$|^agents\.default\.json$/.test(f))) {
    fs.copyFileSync(path.join(repo, file), path.join(root, file));
  }
  const cwd = path.join(root, '项目 资料');
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'prompt.txt'), prompt);
  const card = path.join(root, 'runs', 'case', 'agents', 'custom');

  function cli(command, args = [], preload = []) {
    const argv = [...preload, path.join(root, 'dispatch.mjs'), command, ...args];
    const options = { cwd: root, windowsHide: true, timeout: 15_000, env: { ...process.env, AICC_TEST_TASK: cwd } };
    return new Promise((resolve, reject) => {
      execFile(process.execPath, argv, options, (err, out, stderr) => {
        if (err && !Number.isInteger(err.code)) return reject(err);
        resolve({ code: err?.code || 0, output: out + stderr });
      });
    });
  }
  const target = ['--run', 'case', '--name', 'custom'];
  return {
    root, cwd, cli,
    add: (args, extra = [], exe = process.execPath) => cli('agent-add', [
      '--id', 'sample-cli', '--name', '清单助手', '--command', exe, '--args', JSON.stringify(args), ...extra,
    ]),
    launch: (extra = []) => cli('run', [...target, '--agent', 'sample-cli', '--cwd', cwd, '--prompt-file', 'prompt.txt', ...extra]),
    resume: (msg) => cli('resume', [...target, '--text', msg]),
    stop: () => cli('stop', target, ['--require', fixture]),
    cardFile: (name) => fs.readFileSync(path.join(card, name), 'utf8'),
    meta: () => JSON.parse(fs.readFileSync(path.join(card, 'meta.json'), 'utf8')),
    events: () => jsonLines(path.join(card, 'events.jsonl')),
    received: () => jsonLines(path.join(cwd, 'received.jsonl')),
  };
}

async function exitIs(promise, expected = 0) {
  const { code, output } = await promise;
  assert.equal(code, expected, output);
  return output;
}

test('自定义名单命令支持增删和参数校验，内置项只能关闭', async t => {
  const h = setup(t);
  const defaults = fs.readFileSync(path.join(h.root, 'agents.default.json'), 'utf8');
  await exitIs(h.add([fixture, 'done'], ['--role', '核对两份清单', '--color', '#123456']));
  const list = JSON.parse(await exitIs(h.cli('agents', ['--json'])));
  const custom = list.find(a => a.id === 'sample-cli');
  assert.equal(custom.custom, true);
  assert.equal(custom.found, true);
  assert.equal(custom.role, '核对两份清单');
  assert.equal(custom.color, '#123456');
  assert.deepEqual(custom.capabilities, { resume: false, tokens: false });
  assert.equal(list.find(a => a.id === 'codex').custom, false);
  assert.match(await exitIs(h.cli('agents')), /自定义/);
  const local = path.join(h.root, 'agents.local.json');
  const saved = fs.readFileSync(local, 'utf8');
  await exitIs(h.add([fixture, 'done']), 2);
  for (const args of [
    ['--id', 'wrong', '--args', 'not JSON'],
    ['--id', 'bad-id', '--args', '["ok",1]'],
    ['--id', 'codex'],
  ]) {
    await exitIs(h.cli('agent-add', ['--command', process.execPath, '--name', '无效', ...args]), 2);
  }
  await exitIs(h.cli('agent-remove', ['--id', 'codex']), 2);
  assert.equal(fs.readFileSync(local, 'utf8'), saved);
  await exitIs(h.cli('agent-remove', ['--id', 'sample-cli']));
  assert.ok(!JSON.parse(await exitIs(h.cli('agents', ['--json']))).some(a => a.id === 'sample-cli'));
  assert.equal(fs.readFileSync(path.join(h.root, 'agents.default.json'), 'utf8'), defaults);
});

test('文本助手从 stdin 接收完整规则和中文，监控墙收到逐行动作、选择及续聊结果', async t => {
  const h = setup(t);
  await exitIs(h.add([fixture, 'question', label], [
    '--input', 'stdin', '--env', JSON.stringify({ AICC_LOCALE: '简体 中文' }),
    '--session-pattern', '对话编号 (session-[0-9]+)',
    '--resume-args', JSON.stringify([fixture, 'done', '--session', '{session}']),
  ]));
  const first = await exitIs(h.launch(), 1);
  assert.match(first, /token|用量/i);
  assert.doesNotMatch(first, /约 0 token/);
  const [start] = h.received();
  assert.deepEqual(start.args, [label]);
  assert.equal(start.cwd, h.cwd);
  assert.equal(start.locale, '简体 中文');
  assert.ok(start.input.includes(prompt));
  assert.match(start.input, /【给你的工作规则/);
  assert.match(start.input, /被阻碍：/);
  assert.equal(h.meta().status, 'question');
  assert.equal(h.meta().convId, 'session-123');
  assert.deepEqual(h.meta().options, ['检查名称', '检查顺序']);
  assert.equal(h.events().at(-1).type, 'question');
  assert.ok(h.events().some(ev => ev.type === 'act' && ev.text === '开始核对'));
  assert.ok(h.events().some(ev => ev.type === 'say' && ev.text.includes('我在逐项核对')));
  assert.ok(h.events().some(ev => ev.type === 'say' && /不提供.*(token|用量)/.test(ev.text)));
  assert.equal(h.cardFile('result.md').trim(), choices);
  assert.match(h.cardFile('raw.log'), /对话编号 session-123/);

  const reply = '请选第一项，然后继续。';
  await exitIs(h.resume(reply));
  const [, next] = h.received();
  assert.equal(next.scenario, 'done');
  assert.deepEqual(next.args, ['--session', 'session-123']);
  assert.ok(next.input.startsWith(reply));
  assert.equal(h.meta().status, 'done');
  assert.equal(h.cardFile('result.md').trim(), '清单已整理。\n共核对两项。');
});

test('JSONL 助手通过 {prompt} 接收单个参数，保留未知行并汇报跑偏和阻碍', async t => {
  const h = setup(t);
  await exitIs(h.add([fixture, 'jsonl', label, '{prompt}', '末尾'], ['--input', 'arg', '--output', 'jsonl']));
  await exitIs(h.launch(['--sites', 'allowed.example']), 1);
  const [start] = h.received();
  assert.equal(start.input, '');
  assert.equal(start.args.length, 3);
  assert.equal(start.args[0], label);
  assert.ok(start.args[1].includes(prompt));
  assert.equal(start.args[2], '末尾');
  const events = h.events();
  for (const text of ['开始读取清单', '正在整理清单中的名称。', '原样保留', '这是混在 JSON 里的普通文本']) {
    assert.ok(events.some(ev => ['act', 'say'].includes(ev.type) && ev.text.includes(text)), text);
  }
  assert.ok(events.some(ev => ev.type === 'warn' && ev.text.includes('outside.example')));
  assert.ok(events.some(ev => ev.type === 'warn' && ev.text.includes('outside.txt')));
  assert.equal(h.meta().warnings, 2);
  assert.equal(h.meta().status, 'blocked');
  assert.equal(events.at(-1).type, 'blocked');
  assert.match(h.cardFile('raw.log'), /"unfamiliar":"原样保留"/);
  assert.equal(h.cardFile('result.md').trim(), '被阻碍：请登录模拟工具。');

  const output = await exitIs(h.resume('已经处理好'));
  assert.match(output, /接着|继续|续聊|对话/);
  assert.equal(h.meta().status, 'blocked');
  assert.equal(h.received().length, 1);
});

test('arg 没有占位符时提示放在最后，无对话编号也可按工具自带的继续参数恢复', async t => {
  const h = setup(t);
  await exitIs(h.add([fixture, 'done', label], [
    '--input', 'arg', '--resume-args', JSON.stringify([fixture, 'done', '--continue']),
  ]));
  await exitIs(h.launch());
  await exitIs(h.resume('接着核对第二份。'));
  const [start, next] = h.received();
  assert.equal(start.args.length, 2);
  assert.equal(start.args[0], label);
  assert.ok(start.args.at(-1).includes(prompt));
  assert.equal(next.args.length, 2);
  assert.equal(next.args[0], '--continue');
  assert.ok(next.args.at(-1).startsWith('接着核对第二份。'));
});

for (const [scenario, status, reason] of [
  ['blocked', 'blocked', '被阻碍：请在模拟工具里登录后再继续。'],
  ['failed', 'failed', '启动失败，示例设置文件缺少一行。'],
]) {
  test('自定义助手返回非零退出码，' + (scenario === 'blocked' ? '明确要求处理时标为被阻碍' : '普通失败保留错误原因'), async t => {
    const h = setup(t);
    await exitIs(h.add([fixture, scenario]));
    await exitIs(h.launch(), 1);
    assert.equal(h.meta().status, status);
    assert.equal(h.events().at(-1).type, status === 'failed' ? 'error' : 'blocked');
    assert.ok(h.cardFile('result.md').includes(reason));
    assert.ok(h.cardFile('raw.log').includes(reason));
  });
}

test('普通文本的越界写入提醒能区分工作目录与同名前缀的相邻目录', async t => {
  const h = setup(t);
  await exitIs(h.add([fixture, 'writes']));
  await exitIs(h.launch());
  assert.equal(h.meta().warnings, 1);
  const warnings = h.events().filter(e => e.type === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /项目 资料旧[/\\]outside\.txt/);
});

test('Windows 的 Node 批处理入口保留中文、空格、引号和多行提示', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t);
  const wrapper = path.join(h.cwd, '模拟 助手.cmd');
  fs.copyFileSync(fixture, path.join(h.cwd, 'fake-cli.cjs'));
  fs.writeFileSync(wrapper, '@echo off\r\nnode "%~dp0fake-cli.cjs" %*\r\n');
  await exitIs(h.add(['done', label], ['--input', 'arg'], wrapper));
  await exitIs(h.launch());
  const [start] = h.received();
  assert.equal(start.args.length, 2);
  assert.equal(start.args[0], label);
  assert.ok(start.args[1].includes(prompt));
});

test('Windows 保留批处理初始化步骤，通过 stdin 和参数原样传提示、中文空格与引号', { skip: process.platform !== 'win32' }, async t => {
  const h = setup(t);
  const wrapper = path.join(h.cwd, '自带初始化.bat');
  fs.copyFileSync(fixture, path.join(h.cwd, 'fake-cli.cjs'));
  fs.writeFileSync(wrapper, '@echo off\r\nsetlocal\r\nset "AICC_LOCALE=from-batch"\r\nnode "%~dp0fake-cli.cjs" %*\r\n');
  const args = ['中文 带 空格', '含"双 引号"的参数', ''];
  await exitIs(h.add(['done', ...args], ['--input', 'stdin'], wrapper));
  await exitIs(h.launch());
  const [start] = h.received();
  assert.deepEqual(start.args, args);
  assert.ok(start.input.includes(prompt));
  assert.equal(start.locale, 'from-batch');
});

test('停止自定义助手会向它的进程发送停止请求，并在退出后保留卡片和动态', async t => {
  const h = setup(t);
  await exitIs(h.add([fixture, 'hold']));
  const running = h.launch();
  try {
    const deadline = Date.now() + 6_000;
    while (!fs.existsSync(path.join(h.cwd, 'received.jsonl')) && Date.now() < deadline) await delay(20);
    const [{ pid }] = h.received();
    assert.equal(h.meta().status, 'running');
    assert.equal(h.meta().childPid, pid);
    await exitIs(h.stop());
    await exitIs(running, 1);
    if (process.platform === 'win32') {
      const request = JSON.parse(fs.readFileSync(path.join(h.cwd, 'taskkill.json'), 'utf8'));
      assert.deepEqual(request, ['/PID', String(pid), '/T', '/F']);
    }
    assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    assert.equal(h.meta().status, 'stopped');
    assert.equal(h.events().at(-1).type, 'stopped');
  } finally {
    await running;
  }
});
