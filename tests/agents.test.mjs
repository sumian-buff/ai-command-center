import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listAgents, setAgent, dshPaths, addCustomAgent, removeCustomAgent, commandResumeNotice } from '../agents.cjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const runNode = promisify(execFile);
const example = { id: 'sample', name: '测试助手', kind: 'codex', color: '#123456', icon: 'S',
  enabled: true, role: '核对文字', model: 'first', command: 'cli.js' };

function setup(t, defaults = [example]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'agents.default.json'), '\uFEFF' + JSON.stringify(defaults));
  return dir;
}

test('五个默认条目使用新定位，Grok Bot 说明桌面限制且默认关闭', () => {
  const entries = JSON.parse(fs.readFileSync(path.join(repo, 'agents.default.json'), 'utf8'));
  assert.deepEqual(entries.map(e => e.id), ['codex', 'agy', 'claude', 'deepseek', 'grok']);
  assert.deepEqual(entries.map(e => e.role), [
    '程序代码主体、质量要求高的开发',
    '多面手，审美、设计、前端界面、生图、浏览网页；适合做项目的审美复核和进度监督',
    '总负责人，负责需要居中调度和思考的事，把项目补全完善直到运营上线',
    '不重要但很耗额度的内容、能力要求不高的简单重复任务，或与 DeepSeek 自身特点相关、直接用它效果更好的内容；程序主体代码一般不交给它',
    '只有桌面程序，暂时不能派活',
  ]);
  const grok = entries.at(-1);
  assert.equal(grok.enabled, false);
  assert.equal(grok.kind, 'desktop');
  assert.match(grok.reason, /暂无官方命令行/);
});

test('按顺序寻找真实文件，跳过目录和缺失项，展开环境变量', t => {
  const root = setup(t, [{ ...example, command: ['absent', '.', 'first tool.js', 'second.js'] }]);
  assert.equal(listAgents(root)[0].found, false);
  const first = path.join(root, 'first tool.js');
  const second = path.join(root, 'second.js');
  fs.writeFileSync(second, '');
  assert.equal(listAgents(root)[0].resolvedCommand, second);
  fs.writeFileSync(first, '');
  assert.equal(listAgents(root)[0].resolvedCommand, first);
  const expanded = path.join(root, 'agents.default.json');
  fs.writeFileSync(expanded, JSON.stringify([{ ...example, command: '%AICC_REGISTRY_TEST_ROOT%/second.js' }]));
  const previous = process.env.AICC_REGISTRY_TEST_ROOT;
  process.env.AICC_REGISTRY_TEST_ROOT = root;
  try { assert.equal(listAgents(root)[0].resolvedCommand, second); }
  finally {
    if (previous === undefined) delete process.env.AICC_REGISTRY_TEST_ROOT;
    else process.env.AICC_REGISTRY_TEST_ROOT = previous;
  }
});

test('DeepSeek 的启动器、可执行文件和 app.asar 同时存在才记为找到', t => {
  const command = '中文 安装目录/resources/runtime/cli/bin/dsh.cmd';
  const root = setup(t, [{ ...example, kind: 'dsh', command }]);
  const wrapper = path.join(root, command);
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, '');
  const { exe, archive, cli } = dshPaths(wrapper);
  assert.equal(exe, path.join(root, '中文 安装目录', 'DeepSeek Harness.exe'));
  assert.equal(cli, path.join(root, '中文 安装目录/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'));
  fs.writeFileSync(exe, '');
  assert.equal(listAgents(root)[0].found, false);
  fs.writeFileSync(archive, '');
  assert.equal(listAgents(root)[0].resolvedCommand, wrapper);
});

test('覆盖仅保存在本地并按编号合并，拒绝名单以外和不可编辑的设置', t => {
  const root = setup(t, [example, { ...example, id: 'second' }]);
  const defaults = fs.readFileSync(path.join(root, 'agents.default.json'));
  setAgent('sample', { role: '生成初稿', enabled: false }, root);
  setAgent('sample', { model: '' }, root);
  setAgent('second', { model: 'separate' }, root);
  const [first, second] = listAgents(root);
  assert.deepEqual([first.enabled, first.role, first.model], [false, '生成初稿', '']);
  assert.deepEqual([second.enabled, second.role, second.model], [true, '核对文字', 'separate']);
  const local = path.join(root, 'agents.local.json');
  const saved = fs.readFileSync(local);
  assert.deepEqual(JSON.parse(saved), [
    { id: 'sample', role: '生成初稿', enabled: false, model: '' }, { id: 'second', model: 'separate' },
  ]);
  for (const patch of [null, {}, { enabled: 'false' }, { role: ' ' }, { model: false }, { command: 'other.exe' }]) {
    assert.throws(() => setAgent('sample', patch, root));
  }
  assert.throws(() => setAgent('missing', { enabled: true }, root), /名单中没有/);
  assert.deepEqual(fs.readFileSync(local), saved);
  assert.deepEqual(fs.readFileSync(path.join(root, 'agents.default.json')), defaults);
});

test('遇到损坏配置时明确报错并保留原文件', t => {
  const root = setup(t);
  const local = path.join(root, 'agents.local.json');
  for (const invalid of ['{', '[{"id":"sample","kind":"agy"}]', '[{"id":"not-listed","enabled":true}]']) {
    fs.writeFileSync(local, invalid);
    assert.throws(() => listAgents(root));
    assert.throws(() => setAgent('sample', { enabled: true }, root));
    assert.equal(fs.readFileSync(local, 'utf8'), invalid);
  }
  for (const entries of [[example, { ...example, id: 'SAMPLE' }], [{ ...example, id: 'claude-session' }],
    [{ ...example, id: '../bad' }], [{ ...example, model: null }], [{ ...example, command: [] }]]) {
    fs.writeFileSync(path.join(root, 'agents.default.json'), JSON.stringify(entries));
    fs.rmSync(local, { force: true });
    assert.throws(() => listAgents(root));
  }
});

test('保存设置时可清理上次退出遗留的空锁目录', t => {
  const root = setup(t);
  const lock = path.join(root, 'agents.local.lock.tmp');
  fs.mkdirSync(lock);
  setAgent('sample', { role: '复核' }, root);
  assert.equal(listAgents(root)[0].role, '复核');
  assert.equal(fs.existsSync(lock), false);
});

const custom = { id: 'local-2', name: '本机助手', command: process.execPath };

test('自定义助手可单独增删和关闭，内置设置和默认文件保持原样', t => {
  const root = setup(t, [example, { ...example, id: 'desk', kind: 'desktop' }]);
  const original = fs.readFileSync(path.join(root, 'agents.default.json'));
  setAgent('sample', { role: '已有的个人设置' }, root);
  addCustomAgent(custom, root);
  const [builtin, desktop, local] = listAgents(root);
  assert.equal(builtin.custom, false);
  assert.deepEqual(builtin.capabilities, { resume: true, tokens: true });
  assert.deepEqual(desktop.capabilities, { resume: false, tokens: false });
  assert.equal(local.custom, true);
  assert.equal(local.found, true);
  assert.equal(local.resolvedCommand, process.execPath);
  assert.deepEqual([local.kind, local.input, local.output, local.args, local.enabled], ['command', 'stdin', 'text', [], true]);
  assert.deepEqual(local.capabilities, { resume: false, tokens: false });
  assert.match(commandResumeNotice(local, '123'), /重新派活/);
  assert.equal(commandResumeNotice(builtin, null), '');

  setAgent(custom.id, { enabled: false, role: '整理资料' }, root);
  assert.deepEqual(listAgents(root).at(-1), { ...local, enabled: false, role: '整理资料' });
  assert.throws(() => addCustomAgent(custom, root), /已有/);
  assert.throws(() => removeCustomAgent('sample', root), /只能关闭/);
  assert.throws(() => removeCustomAgent('missing', root), /名单中没有/);
  removeCustomAgent(custom.id, root);
  assert.deepEqual(listAgents(root), [builtin, desktop]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'agents.local.json'))), [{ id: 'sample', role: '已有的个人设置' }]);
  assert.deepEqual(fs.readFileSync(path.join(root, 'agents.default.json')), original);
});

test('手工填写的自定义助手可以从 PATH 找到，续聊支持固定参数和编号占位', t => {
  const root = setup(t);
  const bin = path.join(root, '命令 文件夹');
  fs.mkdirSync(bin);
  const cmd = 'some-tool.v1';
  const file = path.join(bin, cmd + (process.platform === 'win32' ? '.cmd' : ''));
  fs.writeFileSync(file, '', { mode: 0o755 });
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, cmd), '#!/bin/sh');
  const oldPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });

  const entry = { ...custom, kind: 'command', args: ['--print', '中文 空格'], command: cmd,
    input: 'arg', output: 'jsonl', env: { LANG: 'zh_CN', MAX_TOKENS: '500' }, resumeArgs: ['--id={session}'], sessionPattern: 'id=(.+)' };
  fs.writeFileSync(path.join(root, 'agents.local.json'), JSON.stringify([entry]));
  const item = listAgents(root).at(-1);
  assert.equal(path.relative(file, item.resolvedCommand), '');
  assert.deepEqual(item.args, entry.args);
  assert.deepEqual(item.capabilities, { resume: true, tokens: false });
  assert.match(commandResumeNotice(item, null), /对话编号/);
  assert.equal(commandResumeNotice(item, 'session-123'), '');
  assert.equal(commandResumeNotice({ ...item, resumeArgs: ['--continue'] }, null), '');
});

test('拒绝非法自定义字段、覆盖内置助手和密钥设置，保留已保存的本地名单', t => {
  const root = setup(t);
  const localFile = path.join(root, 'agents.local.json');
  addCustomAgent(custom, root);
  const saved = fs.readFileSync(localFile);
  const other = { ...custom, id: 'other' };
  for (const patch of [{ id: 'sample' }, { id: 'Sample' }, { id: 'a_b' }, { id: '../other' }, { id: 'nul' },
    { kind: 'dsh' }, { name: false }, { command: ' ' }, { command: [] }, { command: 'bad\0path' },
    { args: 'abc' }, { args: [3] }, { args: Array(1) }, { resumeArgs: null }, { color: '#fff' }, { icon: '<svg></svg>' },
    { role: [] }, { enabled: 1 }, { input: 'file' }, { output: 'json' }, { sessionPattern: false }, { sessionPattern: '[' },
    { env: [] }, { env: { 'x=y': 'no' } }, { env: { LANG: false } }, { env: { API_KEY: 'fake' } },
    { env: { ACCESS_TOKEN: 'fake' } }, { env: { PROFILE: 'Bearer fake-value' } }, { apiKey: 'fake' }]) {
    assert.throws(() => addCustomAgent({ ...other, ...patch }, root), undefined, JSON.stringify(patch));
    assert.deepEqual(fs.readFileSync(localFile), saved);
  }
  fs.writeFileSync(localFile, JSON.stringify([{ id: 'sample', kind: 'command', command: process.execPath }]));
  assert.throws(() => listAgents(root), /不能修改/);
  fs.writeFileSync(localFile, JSON.stringify([{ ...custom, env: { PASSWORD: 'fake' } }]));
  assert.throws(() => listAgents(root), /密钥/);
});

test('两个进程同时添加同一自定义助手，只保存其中一次', async t => {
  const root = setup(t);
  const script = 'require(process.argv[1]).addCustomAgent(JSON.parse(process.argv[2]), process.argv[3])';
  const add = () => runNode(process.execPath, ['-e', script, path.join(repo, 'agents.cjs'), JSON.stringify(custom), root],
    { windowsHide: true });
  const results = await Promise.allSettled([add(), add()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.stderr, /已有/);
  assert.deepEqual(listAgents(root).map(entry => entry.id), ['sample', custom.id]);
});

test('两个独立进程同时保存开关和定位，两项改动都保留；已退出的写入者不再占锁', async t => {
  const root = setup(t);
  const gone = spawnSync(process.execPath, ['-e', '']);
  assert.equal(gone.status, 0);
  const lock = path.join(root, 'agents.local.lock.tmp');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, String(gone.pid)), '');
  const script = "require(process.argv[1]).setAgent('sample', JSON.parse(process.argv[2]), process.argv[3])";
  await Promise.all([{ role: '并行保存' }, { enabled: false }].map(patch =>
    runNode(process.execPath, ['-e', script, path.join(repo, 'agents.cjs'), JSON.stringify(patch), root], { windowsHide: true })));
  assert.equal(listAgents(root)[0].role, '并行保存');
  assert.equal(listAgents(root)[0].enabled, false);
  assert.deepEqual(fs.readdirSync(root).sort(), ['agents.default.json', 'agents.local.json']);
});
