import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deepseekSpec, createDeepseekEvents, deepseekBlockReason } from '../deepseek.mjs';
import { checkPermissions, safeSample, smoke } from '../scripts/try-deepseek.mjs';

// Protocol examples constructed from the installed dsh-headless JSON projector.
// Only try-deepseek.ps1 writes the separate real-session fixture.
function watch() {
  const events = [], rawLines = [], ids = [], tokens = [], writes = [], urls = [];
  const stream = createDeepseekEvents({
    emit: (type, text) => events.push({ type, text }), raw: line => rawLines.push(line),
    setConv: id => ids.push(id), addTokens: n => tokens.push(n), checkWrite: file => writes.push(file),
    checkUrl: url => { urls.push(url); return new URL(url).host; }, describeCommand: () => '运行测试',
  });
  return { stream, events, rawLines, ids, tokens, writes, urls };
}

test('DeepSeek 直接启动 exe，通过 stdin 保留中文，引号、模型与权限都明确处理', () => {
  const root = path.resolve('中文 安装目录');
  const command = path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const prompt = '带“引号”的任务\n第二行 & exit';
  const meta = { sandbox: 'workspace-write', convId: 'session-test', addDirs: [path.resolve('额外 目录')] };
  const start = deepseekSpec(command, meta, prompt);
  assert.equal(start.exe, path.join(root, 'DeepSeek Harness.exe'));
  assert.equal(start.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(start.stdin, prompt);
  assert.deepEqual(start.args, ['--expose-internals', path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    '--profile', 'headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never', '--add-dir', meta.addDirs[0], '-']);
  const resume = deepseekSpec(command, { ...meta, sandbox: 'read-only' }, prompt, true);
  assert.deepEqual(resume.args.slice(5), ['--session-id', meta.convId, '--permission-mode', 'read-only', '--approval-policy', 'never', '--add-dir', meta.addDirs[0], '-']);
  assert.throws(() => deepseekSpec(command, {}, prompt, true), /编号/);
  assert.throws(() => deepseekSpec(command, { model: 'other' }, prompt), /模型/);
  assert.throws(() => deepseekSpec(command, { sandbox: 'danger-full-access' }, prompt), /只读/);
});

test('DeepSeek 按步骤计 token，保留原始事件，最终回复取无截断的 final', () => {
  const { stream, rawLines, events, ids, tokens } = watch();
  const packets = [
    { type: 'session', sessionId: 'session-one', cwd: '.' }, { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'thinking', text: '检查中' }, { type: 'text', text: '开始回答' },
    { type: 'status', phase: 'step_end', usage: { totalTokens: 10, inputTokens: 7, outputTokens: 3, reasoningTokens: 1 } },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 5, outputTokens: 2 } },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' }, usage: { totalTokens: 17 } },
    { type: 'final', sessionId: 'session-one', text: '完整回答', reason: { kind: 'completed' } },
  ];
  packets.forEach(stream.onEvent);
  assert.deepEqual(tokens, [10, 7]);
  assert.deepEqual(rawLines.map(line => JSON.parse(line)), packets);
  assert.deepEqual(events.filter(e => e.type === 'say').map(e => e.text), ['开始回答']);
  assert.equal(ids.at(-1), 'session-one');
  assert.equal(stream.finalText, '完整回答');
  assert.equal(stream.completed, true);
});

test('DeepSeek 翻译文件、命令和网页操作，并交给已有的范围检查', () => {
  const { stream, events, writes, urls } = watch();
  for (const [tool, input] of [
    ['read', { file_path: 'note.txt' }], ['edit', { file_path: 'note.txt' }],
    ['apply_patch', { input: '*** Update File: a.txt\n*** Move to: b.txt\n' }],
    ['pwsh', { command: 'npm test' }], ['web_fetch', { url: 'https://example.com' }],
  ]) stream.onEvent({ type: 'tool_call', tool, input, callId: tool });
  assert.deepEqual(writes, ['note.txt', 'a.txt', 'b.txt']);
  assert.deepEqual(urls, ['https://example.com']);
  assert.deepEqual(events.map(e => e.text), ['查看文件：note.txt', '修改文件：note.txt', '修改项目文件', '运行测试', '读取网页：example.com']);
  stream.onEvent({ type: 'tool_result', status: 'error', result: 'file not found' });
  assert.equal(events.at(-1).type, 'warn');
  assert.equal(stream.blocked, '');
  stream.onEvent({ type: 'tool_result', status: 'error', error: { code: 'FS_SANDBOX_DENIED' } });
  assert.match(stream.blocked, /权限/);
});

test('DeepSeek 处理进程内外的错误，没有成功 final 的对话不能记为完成', () => {
  for (const packet of [
    { type: 'error', message: 'session does not exist' },
    { type: 'final', sessionId: 'session-test', text: '', reason: { kind: 'aborted' } },
    { type: 'final', sessionId: 'session-test', text: '', reason: null },
  ]) {
    const { stream, events } = watch();
    stream.onEvent(packet);
    assert.ok(stream.error);
    assert.equal(stream.completed, false);
    assert.equal(events.at(-1).type, 'error');
  }
  const { stream } = watch();
  stream.onEvent({ type: 'final', reason: { kind: 'error', error: { code: 'ACCOUNT_SIGN_IN_REQUIRED', message: 'sign in first' } }, text: '' });
  assert.match(stream.blocked, /登录/);
  assert.match(deepseekBlockReason('EPERM: operation not permitted'), /权限/);
  assert.match(deepseekBlockReason('fetch failed: ECONNREFUSED'), /网络/);
});

test('沙箱外采样先验证权限对应关系，只允许预期回复与脱敏字段进入样本', () => {
  const dump = "- id: permission\n  name: '@deepseek-ai/dsh-permission-presets'\n  config:\n    presets:\n      read-only:\n        sandbox: read-only\n      workspace-write:\n        sandbox: workspace-write\n- id: other\n";
  checkPermissions(dump);
  assert.throws(() => checkPermissions(dump.replace('sandbox: read-only', 'sandbox: danger-full-access')), /无法核实/);
  const cwd = process.cwd();
  const events = [
    { type: 'session', sessionId: 'session-private', cwd },
    { type: 'thinking', text: 'private thinking' },
    { type: 'text', text: 'AICC-DSH-OK' },
    { type: 'status', phase: 'step_end', usage: { totalTokens: 11, private: 'sensitive' } },
    { type: 'final', sessionId: 'session-private', reason: { kind: 'completed' }, text: 'AICC-DSH-OK' },
  ];
  const sample = safeSample(events, cwd);
  assert.doesNotMatch(JSON.stringify(sample), /session-private|private thinking|sensitive/);
  assert.equal(sample[3].usage.totalTokens, 11);
  assert.throws(() => safeSample([events[0], { type:'tool_call' }, events.at(-1)], cwd), /工具调用/);
});

test('一键脚本离线演练，权限错误不发任务，回包失败不覆盖样本', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-dsh-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const destination = path.join(cwd, 'sample.jsonl');
  const agent = { enabled: true, found: true, kind: 'dsh', resolvedCommand: path.join(cwd, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') };
  // dsh-base/cordis.patch.yml permission row, at --dump-config root indentation.
  let dump = [
    '- id: permission', "  name: '@deepseek-ai/dsh-permission-presets'", '  config:', '    presets:',
    '      read-only:', '        sandbox: read-only', '        approval: ask',
    '      workspace-write:', '        sandbox: workspace-write', '        approval: ask',
    '      danger-full-access:', '        sandbox: danger-full-access', '        approval: never',
  ].join('\n') + '\n';
  const expected = 'AICC-DSH-OK';
  let answer = expected, calls = 0;
  const launch = (_exe, args, options) => {
    assert.equal(options.cwd, cwd);
    const flag = args.at(-1);
    if (flag === '--help') return { status: 0, stdout: '--json --session-id --permission-mode --approval-policy --add-dir' };
    if (flag === '--dump-config') return { status: 0, stdout: dump };
    assert.equal(flag, '-');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'read-only');
    assert.ok(options.input.includes(expected));
    calls++;
    return { status: 0, stdout: [
      { type: 'session', sessionId: 'session-test', cwd },
      { type: 'text', text: answer },
      { type: 'final', sessionId: 'session-test', text: answer, reason: { kind: 'completed' } },
    ].map(e => JSON.stringify(e)).join('\n') };
  };
  const run = () => smoke(cwd, { agent, launch, destination, log() {} });
  run();
  const good = fs.readFileSync(destination, 'utf8');
  assert.match(good, /AICC-DSH-OK/);
  assert.doesNotMatch(good, /session-test/);
  assert.equal(calls, 1);
  dump = dump.replace('sandbox: read-only', 'sandbox: danger-full-access');
  assert.throws(run, /无法核实/);
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(destination, 'utf8'), good);
  dump = dump.replace('sandbox: danger-full-access', 'sandbox: read-only');
  answer = 'different';
  assert.throws(run, /预期测试回复/);
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(destination, 'utf8'), good);
  fs.unlinkSync(destination);
  assert.throws(run, /预期测试回复/);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

const fixture = new URL('./fixtures/deepseek-headless.jsonl', import.meta.url);
if (fs.existsSync(fixture)) {
  test('回放沙箱外采集的真实 DeepSeek 只读事件', () => {
    const { stream, ids, tokens } = watch();
    const packets = fs.readFileSync(fixture, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    packets.forEach(stream.onEvent);
    assert.equal(packets[0].type, 'session');
    assert.ok(ids[0]);
    assert.equal(ids[0], packets.at(-1).sessionId);
    assert.equal(stream.completed, true);
    assert.equal(stream.error, '');
    assert.equal(stream.finalText.trim(), 'AICC-DSH-OK');
    for (const count of tokens) assert.ok(Number.isSafeInteger(count) && count >= 0);
  });
}
