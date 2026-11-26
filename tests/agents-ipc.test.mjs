import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { listAgents, setAgent } from '../agents.cjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const appDir = path.join(repo, 'app');
const appRequire = createRequire(path.join(appDir, 'main.js'));

test('窗口名单接口与任务卡共用设置，兼容旧对话和已移除的助手', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(repo, 'agents.default.json'), path.join(root, 'agents.default.json'));
  const handlers = new Map();
  const calls = [];
  let api;
  const electron = {
    app: { setAppUserModelId() {}, on() {}, whenReady: () => Promise.resolve() },
    BrowserWindow: class { loadFile() {} },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)(null, ...args) },
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'console2'); api = value; } },
  };
  const modules = {
    electron,
    '../agents.cjs': { listAgents: () => listAgents(root), setAgent: (id, patch) => setAgent(id, patch, root) },
    './transcript': { readSession: () => ({ events: [], status: 'done' }) },
    child_process: { execFile(cmd, args, options, done) { calls.push([cmd, ...args]); done(null); } },
  };
  const context = {
    require: (name) => modules[name] || appRequire(name),
    __dirname: path.join(root, 'app'), process: { env: {} }, Buffer, setInterval() {},
  };
  for (const file of ['main.js', 'preload.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(appDir, file), 'utf8'), context, { filename: file });
  }
  await Promise.resolve();
  const list = await api.listAgents();
  const ds = list.find((a) => a.id === 'deepseek');
  assert.equal(typeof ds.found, 'boolean');
  assert.equal(await api.setAgent(ds.id, { role: '整理笔记', enabled: false }), '');
  assert.ok(fs.existsSync(path.join(root, 'agents.local.json')));
  assert.equal((await api.listAgents()).find((a) => a.id === ds.id).role, '整理笔记');
  for (const patch of [{ command: 'bad.exe' }, { kind: 'agy' }, { enabled: 'true' }]) {
    assert.ok(await api.setAgent(ds.id, patch));
  }

  for (const meta of [
    { name: '新卡', agent: 'deepseek', kind: 'dsh' },
    { name: '旧侧栏', agent: 'claude-session' },
    { name: '旧主卡', agent: 'agy' },
    { name: '旧子卡', agent: 'agy', parent: '旧主卡' },
    { name: '已移除', agent: 'archived' },
  ]) {
    const dir = path.join(root, 'runs', 'example', 'agents', meta.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, status: 'done' }));
  }
  const cards = (await api.getRun('example')).agents;
  const ids = { 新卡: 'deepseek', 旧侧栏: 'claude', 旧主卡: 'agy', 旧子卡: 'agy' };
  for (const card of cards) {
    const vendor = list.find((entry) => entry.id === ids[card.name]);
    if (vendor) {
      for (const field of ['name', 'color', 'icon']) assert.equal(card.vendorInfo[field], vendor[field]);
    } else {
      assert.equal(card.vendorInfo.name, 'archived');
      assert.ok(card.vendorInfo.icon && card.vendorInfo.color);
    }
  }
  assert.equal(cards.length, 5);
  assert.equal(await api.stopAgent('example', '新卡'), true);
  assert.deepEqual(Array.from(calls[0]), ['node', path.join(root, 'dispatch.mjs'), 'stop', '--run', 'example', '--name', '新卡']);
});
