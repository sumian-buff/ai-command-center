// 调度器和桌面窗口共用同一份本机助手名单。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
// Electron 将 .asar 当作目录；判断另一个程序的安装包是否存在要查看磁盘上的文件。
const archiveFs = process.versions.electron ? require('original-fs') : fs;

const kinds = new Set(['codex', 'agy', 'claude', 'dsh', 'desktop']);
const editable = new Set(['enabled', 'role', 'model']);
const customFields = new Set(['id', 'name', 'kind', 'color', 'icon', 'role', 'enabled', 'command',
  'args', 'input', 'resumeArgs', 'sessionPattern', 'output', 'env']);
const reservedId = /^(claude-session|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
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
        || reservedId.test(entry.id)) {
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

function validateEnv(env) {
  if (Object.prototype.toString.call(env) !== '[object Object]') throw new Error('env 请填写普通环境变量的名称和值。');
  const secretName = /(?:api_?key|access_?key|private_?key|password|passwd|secret|credential|authorization|(?:^|_)token(?:_|$)|cookie)/i;
  const secretValue = /-----BEGIN [A-Z ]*PRIVATE KEY-----|^Bearer\s+\S+|^sk-[a-z0-9_-]{16,}/i;
  for (const [name, value] of Object.entries(env)) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('env 名称只能使用字母、数字和下划线，值请填写文字。');
    }
    if (secretName.test(name) || secretValue.test(value)) throw new Error('请让命令行工具自己保存密钥和登录信息，env 只填写普通设置。');
  }
}

function customDefinition(def) {
  if (!isObject(def)) throw new Error('请填写自定义助手的设置。');
  for (const field of Object.keys(def)) {
    if (!customFields.has(field)) throw new Error(`自定义助手没有「${field}」这个设置。`);
  }
  const entry = { kind: 'command', enabled: true, role: '自定义命令行助手', color: '#64748b', icon: 'AI',
    input: 'stdin', output: 'text', args: [], ...def };
  if (!hasText(entry.id) || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id) || reservedId.test(entry.id)) {
    throw new Error('自定义助手编号请使用小写字母、数字和短横线，以字母或数字开头，并避开保留名称。');
  }
  if (entry.kind !== 'command') throw new Error('自定义助手的 kind 请填写 command。');
  if (!hasText(entry.name)) throw new Error('name 请填写助手的显示名。');
  if (!hasText(entry.command) || entry.command.includes('\0')) throw new Error('command 请填写程序路径或 PATH 中的命令名。');
  if (typeof entry.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color)) throw new Error('color 请填写 # 开头的六位颜色。');
  if (!hasText(entry.icon) || /<[a-z]/i.test(entry.icon)) throw new Error('icon 请填写简短的图标文字或符号。');
  validatePatch({ enabled: entry.enabled, role: entry.role });
  if (!['stdin', 'arg'].includes(entry.input)) throw new Error('input 请填写 stdin 或 arg。');
  if (!['text', 'jsonl'].includes(entry.output)) throw new Error('output 请填写 text 或 jsonl。');
  for (const field of ['args', 'resumeArgs']) {
    if (!(field in entry)) continue;
    if (!Array.isArray(entry[field]) || !Array.from(entry[field]).every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
      throw new Error(`${field} 请填写字符串数组，每个参数单独一项。`);
    }
  }
  if ('sessionPattern' in entry) {
    if (!hasText(entry.sessionPattern)) throw new Error('sessionPattern 请填写匹配对话编号的正则表达式。');
    try { new RegExp(entry.sessionPattern); }
    catch { throw new Error('sessionPattern 的正则表达式无效，请检查括号和转义。'); }
  }
  if ('env' in entry) validateEnv(entry.env);
  return entry;
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
  const local = new Map();
  for (const { id, ...patch } of readEntries(root, 'agents.local.json', true)) {
    const builtin = defaults.find(entry => entry.id.toLowerCase() === id.toLowerCase());
    if (builtin) {
      if (builtin.id !== id) throw new Error(`本地设置请使用内置助手原有的编号「${builtin.id}」。`);
      validatePatch(patch);
      local.set(id, { id, ...patch });
    } else {
      local.set(id, customDefinition({ id, ...patch }));
    }
  }
  return { defaults, local };
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

function findCustomCommand(command, root) {
  const name = command.replace(/%([^%]+)%/g, (match, key) => process.env[key] ?? match);
  const explicitPath = path.isAbsolute(name) || /[/\\]/.test(name);
  const dirs = explicitPath ? [root] : (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let suffixes = [''];
  if (process.platform === 'win32' && !/\.(exe|com|bat|cmd)$/i.test(name)) {
    // npm 在 PATH 里同时放无扩展名的 Unix 脚本和 Windows 启动器。
    const pathExt = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    suffixes = pathExt.split(';').filter(ext => /^\.(com|exe|bat|cmd)$/i.test(ext));
    if (explicitPath) suffixes.push('');
  }
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(dir.replace(/^"(.*)"$/, '$1'), name + suffix);
      if (!isFile(candidate)) continue;
      if (process.platform !== 'win32') {
        try { fs.accessSync(candidate, fs.constants.X_OK); } catch { continue; }
      }
      return candidate;
    }
  }
  return null;
}

function findCommand(entry, root) {
  if (entry.kind === 'command') return findCustomCommand(entry.command, root);
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
  const { defaults, local } = readRegistry(root);
  const entries = defaults.map(entry => ({ ...entry, ...local.get(entry.id) }));
  entries.push(...Array.from(local.values()).filter(entry => entry.kind === 'command'));
  return entries.map((entry) => {
    const custom = entry.kind === 'command';
    const capabilities = { resume: custom ? Array.isArray(entry.resumeArgs) : entry.kind !== 'desktop',
      tokens: !custom && entry.kind !== 'desktop' };
    const resolvedCommand = findCommand(entry, root);
    return { ...entry, custom, capabilities, found: resolvedCommand !== null, resolvedCommand };
  });
}

function commandResumeNotice(agent, convId) {
  if (agent.kind !== 'command') return '';
  if (!agent.resumeArgs) return '这个助手没有设置接着对话的参数，请重新派活。';
  if (!convId && agent.resumeArgs.some(arg => arg.includes('{session}'))) {
    return '这个助手还没有提供对话编号，请检查会话编号的匹配规则，或重新派活。';
  }
  return '';
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

function updateLocal(root, update) {
  const local = path.join(root, 'agents.local.json');
  const tmp = local + '.' + process.pid + '.tmp';
  try {
    const release = acquireLock(root);
    try {
      const registry = readRegistry(root);
      update(registry);
      fs.writeFileSync(tmp, JSON.stringify(Array.from(registry.local.values()), null, 2) + '\n');
      fs.renameSync(tmp, local);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } finally { release(); }
    }
  } catch (err) {
    throw new Error(`保存助手设置失败：${err.message}`);
  }
}

function setAgent(id, patch, root = __dirname) {
  validatePatch(patch);
  updateLocal(root, ({ defaults, local }) => {
    if (!local.has(id) && !defaults.some(entry => entry.id === id)) throw new Error(`助手名单中没有「${id}」。`);
    if (local.get(id)?.kind === 'command' && 'model' in patch) {
      throw new Error('请在自定义工具的启动参数或工具自己的设置里选择模型。');
    }
    local.set(id, { id, ...local.get(id), ...patch });
  });
}

function addCustomAgent(def, root = __dirname) {
  const entry = customDefinition(def);
  updateLocal(root, ({ defaults, local }) => {
    if (defaults.some(({ id }) => id.toLowerCase() === entry.id)) throw new Error(`「${entry.id}」是内置助手的编号，请换一个编号。`);
    if (local.has(entry.id)) throw new Error(`名单中已有「${entry.id}」，请换一个编号。`);
    local.set(entry.id, entry);
  });
}

function removeCustomAgent(id, root = __dirname) {
  updateLocal(root, ({ defaults, local }) => {
    if (defaults.some(entry => entry.id === id)) throw new Error('内置助手只能关闭，请使用名单里的开关。');
    if (!local.delete(id)) throw new Error(`助手名单中没有「${id}」。`);
  });
}

module.exports = { listAgents, setAgent, dshPaths, addCustomAgent, removeCustomAgent, commandResumeNotice };
