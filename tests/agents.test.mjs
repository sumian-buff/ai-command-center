import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listAgents, setAgent, dshPaths } from '../agents.cjs';

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
