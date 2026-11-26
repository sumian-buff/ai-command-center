// 调度器和桌面窗口共用同一份本机助手名单。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Electron 将 .asar 当作目录；判断另一个程序的安装包是否存在要查看磁盘上的文件。
const archiveFs = process.versions.electron ? require('original-fs') : fs;

const kinds = new Set(['codex', 'agy', 'claude', 'dsh', 'desktop']);
const editable = new Set(['enabled', 'role', 'model']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

function readEntries(root, file, optional = false) {
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (optional && err.code === 'ENOENT') return [];
    throw new Error(`无法读取 ${file}，请检查文件和 JSON 格式（${err.message}）。`);
  }
  if (!Array.isArray(entries)) throw new Error(`${file} 应使用数组，每个助手写一项。`);
  const ids = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || !hasText(entry.id) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id)
        || /^(claude-session|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(entry.id)) {
      throw new Error(`${file} 有无效的助手编号，请使用字母、数字、横线或下划线，并避开保留名称。`);
    }
    const key = entry.id.toLowerCase();
    if (ids.has(key)) throw new Error(`${file} 里助手编号「${entry.id}」重复。`);
    ids.add(key);
  }
  return entries;
}

function validatePatch(patch) {
  if (!isObject(patch) || !Object.keys(patch).length) throw new Error('请提供要修改的设置。');
  for (const [key, value] of Object.entries(patch)) {
    if (!editable.has(key)) throw new Error(`不能修改「${key}」，只允许修改 enabled、role、model。`);
    if (key === 'enabled' && typeof value !== 'boolean') throw new Error('enabled 请填写 true 或 false。');
    if (key === 'role' && !hasText(value)) throw new Error('role 请填写一句助手定位。');
    if (key === 'model' && typeof value !== 'string') throw new Error('model 请填写模型名字或空字符串。');
  }
}

function readRegistry(root) {
  const defaults = readEntries(root, 'agents.default.json');
  for (const entry of defaults) {
    const commands = Array.isArray(entry.command) ? entry.command : [entry.command];
    if (![entry.name, entry.icon].every(hasText) || !/^#[0-9a-f]{6}$/i.test(entry.color)
        || !kinds.has(entry.kind) || !commands.length || !commands.every(hasText)) {
      throw new Error(`助手「${entry.id}」的显示名、图标、六位颜色、适配方式或程序路径无效。`);
    }
    validatePatch({ enabled: entry.enabled, role: entry.role, model: entry.model === undefined ? '' : entry.model });
  }
  const overrides = new Map();
  for (const { id, ...patch } of readEntries(root, 'agents.local.json', true)) {
    if (!defaults.some((entry) => entry.id === id)) throw new Error(`本地设置里的助手「${id}」不在默认名单中。`);
    validatePatch(patch);
    overrides.set(id, patch);
  }
  return { defaults, overrides };
}

// 与官方 dsh.cmd 的相对路径一致。普通 Node 进程只能直接检查 app.asar 档案。
function dshPaths(command) {
  const resources = path.resolve(path.dirname(command), '../../..');
  const archive = path.join(resources, 'app.asar');
  return {
    exe: path.resolve(resources, '..', 'DeepSeek Harness.exe'),
    archive,
    cli: path.join(archive, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
  };
}

function isFile(file, disk = fs) {
  try { return disk.statSync(file).isFile(); }
  catch { return false; }
}

function findCommand(entry, root) {
  for (const candidate of [].concat(entry.command)) {
    const expanded = candidate.replace(/%([^%]+)%/g, (match, key) => process.env[key] || match);
    if (/%[^%]+%/.test(expanded)) continue;
    const command = path.resolve(root, expanded);
    if (!isFile(command)) continue;
    if (entry.kind === 'dsh') {
      const { exe, archive } = dshPaths(command);
      if (path.basename(command).toLowerCase() !== 'dsh.cmd' || !isFile(exe) || !isFile(archive, archiveFs)) continue;
    }
    return command;
  }
  return null;
}

function listAgents(root = __dirname) {
  const { defaults, overrides } = readRegistry(root);
  return defaults.map((entry) => {
    const resolvedCommand = findCommand(entry, root);
    return { ...entry, ...overrides.get(entry.id), found: resolvedCommand !== null, resolvedCommand };
  });
}

// 临时目录先放入进程编号再原子改名。中途退出时，下一个写入者只会清理已退出进程的锁。
function removeEmptyLock(dir) {
  try { fs.rmdirSync(dir); } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
  }
}
function removeLock(dir, owner) {
  try { fs.unlinkSync(path.join(dir, owner)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  removeEmptyLock(dir);
}
function acquireLock(root) {
  const lock = path.join(root, 'agents.local.lock.tmp');
  const staging = path.join(root, 'agents.local.' + randomUUID() + '.tmp');
  fs.mkdirSync(staging);
  const owner = String(process.pid);
  fs.writeFileSync(path.join(staging, owner), '');
  const timer = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 1000;
  try {
    for (;;) {
      try {
        fs.renameSync(staging, lock);
        return () => removeLock(lock, owner);
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      }
      if (Date.now() >= deadline) throw new Error('另一个程序正在保存助手设置，或目录不可写，请稍后再试。');
      let names;
      try { names = fs.readdirSync(lock); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      // 上次保存可能刚删除编号就中断。非递归删除只会成功移走空目录。
      if (!names.length) { removeEmptyLock(lock); continue; }
      if (names.length === 1 && /^\d+$/.test(names[0])) {
        try { process.kill(Number(names[0]), 0); } catch (err) {
          if (err.code === 'ESRCH') { removeLock(lock, names[0]); continue; }
        }
      }
      Atomics.wait(timer, 0, 0, 15);
    }
  } catch (err) {
    removeLock(staging, owner);
    throw err;
  }
}

function setAgent(id, patch, root = __dirname) {
  validatePatch(patch);
  const local = path.join(root, 'agents.local.json');
  const tmp = local + '.' + process.pid + '.tmp';
  try {
    const release = acquireLock(root);
    try {
      const { defaults, overrides } = readRegistry(root);
      if (!defaults.some((entry) => entry.id === id)) throw new Error(`助手名单中没有「${id}」。`);
      overrides.set(id, { ...overrides.get(id), ...patch });
      const entries = Array.from(overrides, ([id, values]) => ({ id, ...values }));
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n');
      fs.renameSync(tmp, local);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } finally { release(); }
    }
  } catch (err) {
    throw new Error(`保存助手设置失败：${err.message}`);
  }
}

module.exports = { listAgents, setAgent, dshPaths };
