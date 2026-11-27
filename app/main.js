// AI指挥台 · 桌面窗口主进程：读取 runs/ 里的记录，提供给界面；处理停止按钮和系统通知。
const { app, BrowserWindow, ipcMain, Notification, shell } = require('electron');
const { readSession } = require('./transcript');
const { diagnose, includeChildActivity } = require('./diagnose');
const { markAgentDone } = require('../mark-done.cjs');
const { foldedNames, setFolded } = require('../fold.cjs');
const { listAgents, setAgent, addCustomAgent, removeCustomAgent, commandResumeNotice } = require('../agents.cjs');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNS = path.join(ROOT, 'runs');
const recorder = process.env.AICONSOLE_RECORD?.trim() ? require('../promo/record.cjs').configure(app) : null;

function readJSON(f, d) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return d; }
}
function readLines(f) {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
// 炫酷模式用：读原始记录的最后一段（不整个读进来）
function readRawTail(f, max = 48 * 1024) {
  try {
    const size = fs.statSync(f).size;
    const len = Math.min(size, max);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    let raw = buf.toString('utf8');
    if (len < size) raw = raw.slice(raw.indexOf('\n') + 1); // 去掉被截断的半行
    return { raw, rawSize: size, rawMtime: mtime(f) };
  } catch { return { raw: '', rawSize: 0, rawMtime: 0 }; }
}

function loadAgents(runDir) {
  const dir = path.join(runDir, 'agents');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const agents = names.map((name) => {
    const d = path.join(dir, name);
    const meta = readJSON(path.join(d, 'meta.json'), null);
    if (!meta) return null;
    if (meta.agent === 'claude-session') {
      // Claude 程序里的侧边栏会话：读它实时写在硬盘上的记录
      let s;
      try { s = readSession(meta); } catch (e) { s = { events: [{ ts: meta.startedAt, type: 'error', text: '读取会话记录出错：' + e.message }], status: 'interrupted', current: '读取出错' }; }
      const tm = s.transcript ? mtime(s.transcript) : mtime(path.join(d, 'meta.json'));
      if (meta.status === 'done') {
        // 手动验收写在任务目录里，会话记录仍保留验收前的对话和状态。
        const file = path.join(d, 'events.jsonl');
        return { ...meta, ...s, status: meta.status, current: meta.current, options: meta.options, endedAt: meta.endedAt,
          events: [...s.events, ...readLines(file)].slice(-300), rawMtime: tm, _mtime: Math.max(tm, mtime(file)) };
      }
      return { ...meta, ...s, rawMtime: tm, _mtime: tm };
    }
    if (meta.status === 'running' && !alive(meta.pid)) meta.status = 'interrupted';
    const eventsFile = path.join(d, 'events.jsonl');
    const rawFile = path.join(d, 'raw.log');
    const events = readLines(eventsFile).slice(-300);
    const updated = mtime(eventsFile);
    if ((meta.kind || meta.agent) === 'agy' && meta.parent) {
      return { ...meta, events, rawMtime: mtime(rawFile), _mtime: Math.max(updated, Date.parse(meta.lastActivityAt) || 0) };
    }
    let result = '';
    try { result = fs.readFileSync(path.join(d, 'result.md'), 'utf8'); } catch {}
    return { ...meta, events, result, ...readRawTail(rawFile), _mtime: updated };
  }).filter(Boolean).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  return includeChildActivity(agents);
}

function loadRun(id, withVendorInfo = true) {
  const dir = path.join(RUNS, id);
  const agents = loadAgents(dir);
  if (withVendorInfo) {
    // 只有打开的任务需要卡片信息。任务列表和通知轮询不用逐个任务查找程序。
    let registry = [];
    try { registry = listAgents(); } catch { /* 名单配置出错时仍然可以查看历史。 */ }
    const vendors = new Map(registry.map(entry => [entry.id, entry]));
    for (const agent of agents) {
      const id = agent.agent === 'claude-session' ? 'claude' : agent.agent;
      const entry = vendors.get(id);
      agent.vendorInfo = entry ? { name: entry.name, color: entry.color, icon: entry.icon }
        : agent.vendorInfo || { name: id || '助手', color: '#64748b', icon: 'AI' };
      if (agent.kind === 'command') {
        agent.capabilities = entry?.capabilities || { resume: false, tokens: false };
        agent.resumeNotice = resumeNoticeForCard(entry, agent.convId);
      }
    }
  }
  // 旧一轮用完的卡片收起来（规则见 fold.cjs）
  const folded = foldedNames(agents);
  for (const a of agents) a.folded = folded.has(a.parent || a.name);
  return {
    id,
    plan: readJSON(path.join(dir, 'plan.json'), null),
    notes: readLines(path.join(dir, 'notes.jsonl')),
    agents,
  };
}

// 这个任务属于哪个项目：优先用计划里写明的 project；否则看助手们在哪个文件夹里干活
function projectOf(r) {
  const plan = r.plan || {};
  if (plan.project) return { key: 'name:' + String(plan.project).trim().toLowerCase(), name: String(plan.project).trim() };
  const cwds = r.agents.map((a) => a.cwd).filter((c) => c && !/\\Temp\\|scratchpad/i.test(c));
  if (!cwds.length) return { key: '', name: '' };
  const count = {};
  cwds.forEach((c) => { const k = c.toLowerCase(); count[k] = (count[k] || 0) + 1; });
  const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  const base = path.basename(top);
  // 临时文件夹名（如 scratch-2026-11-16-xxxx）不好认，改用任务标题里「：」前面的部分
  const titlePrefix = String(plan.title || '').split(/[：:]/)[0].trim();
  const name = /^scratch-|^tmp|^temp/i.test(base) && titlePrefix && titlePrefix !== plan.title ? titlePrefix : base;
  return { key: 'dir:' + top, name };
}

function listRuns() {
  let ids = [];
  try { ids = fs.readdirSync(RUNS).filter((n) => fs.statSync(path.join(RUNS, n)).isDirectory()); } catch { return []; }
  return ids.map((id) => {
    const r = loadRun(id, false);
    const times = [mtime(path.join(RUNS, id, 'plan.json')), mtime(path.join(RUNS, id, 'notes.jsonl')), ...r.agents.map((a) => a._mtime)];
    const running = r.agents.some((a) => a.status === 'running');
    const attention = r.agents.some((a) => a.status === 'blocked' || a.status === 'question' || (a.status === 'running' && a.warnings > 0));
    const proj = projectOf(r);
    return {
      id, title: (r.plan && r.plan.title) || id, updated: Math.max(...times, 0), running, attention, agentCount: r.agents.length,
      agents: r.agents.map((a) => ({ status: a.status, warnings: a.warnings || 0, handover: !!a.handover })),
      projectKey: proj.key, projectName: proj.name,
    };
  }).sort((a, b) => b.updated - a.updated);
}

// ---------- 任务列表的整理：顺序、项目分组、置顶、归档（存在 runs/_layout.json） ----------
const LAYOUT = path.join(RUNS, '_layout.json');
function saveLayout(layout) {
  try { fs.writeFileSync(LAYOUT, JSON.stringify(layout, null, 2)); return true; } catch { return false; }
}
// 删除：移到 Windows 回收站（只删指挥台里的任务记录，不碰项目文件）。运行中的任务不能删
async function trashRuns(ids) {
  const blocked = [];
  for (const id of ids || []) {
    if (!/^[\w一-龥.-]+$/.test(id) || id.startsWith('_')) continue;
    const dir = path.join(RUNS, id);
    if (!fs.existsSync(dir)) continue;
    if (loadAgents(dir).some((a) => a.status === 'running')) { blocked.push(id); continue; }
    try { await shell.trashItem(dir); } catch { blocked.push(id); }
  }
  return blocked;
}

// 调用调度器（用系统里的 node 运行，和窗口互不影响；窗口关了它也会继续跑）
function runDispatch(args) {
  const child = spawn('node', [path.join(ROOT, 'dispatch.mjs'), ...args], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
function resumeNoticeForCard(entry, convId) {
  if (!entry) return '这个自定义助手已从名单移除，请重新添加后再派活。';
  if (!entry.enabled) return '这个助手已关闭，请在助手名单里开启后再继续。';
  return commandResumeNotice(entry, convId);
}
function checkCustomReply(dir) {
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  if (meta.kind !== 'command') return '';
  let notice;
  try { notice = resumeNoticeForCard(listAgents().find(a => a.id === meta.agent), meta.convId); }
  catch (err) { notice = err.message; }
  if (notice) fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'say', text: notice }) + '\n');
  return notice;
}
function replyAgent(run, name, text) {
  const d = path.join(RUNS, run, 'agents', name);
  const notice = checkCustomReply(d);
  if (notice) return notice;
  const f = path.join(d, `reply-${Date.now()}.txt`);
  fs.writeFileSync(f, String(text || ''), 'utf8');
  runDispatch(['resume', '--run', run, '--name', name, '--message-file', f]);
  return true;
}
function openAgent(run, name, terminal) {
  return new Promise((res) => {
    const args = [path.join(ROOT, 'dispatch.mjs'), 'open', '--run', run, '--name', name];
    if (terminal) args.push('--terminal');
    const child = spawn('node', args, { cwd: ROOT, windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => res(code === 0 ? '' : err.trim() || '打开失败'));
  });
}

// ---------- 看看卡哪了：诊断、结束卡住的程序、重启接着做 ----------
const lastDiag = new Map(); // run/name -> 最近一次诊断结果（只允许结束诊断里找到的那个程序）
async function diagnoseAgent(run, name) {
  const meta = loadAgents(path.join(RUNS, run)).find((a) => a.name === name) || {};
  const lastEv = Date.parse(meta.events?.at(-1)?.ts) || 0;
  const last = Math.max(lastEv, meta.rawMtime || 0, meta.childActivityMs || 0, Date.parse(meta.lastStartedAt || meta.startedAt) || 0);
  const result = await diagnose(meta, last);
  lastDiag.set(`${run}/${name}`, result);
  return result;
}
function killStuckChild(run, name) {
  const r = lastDiag.get(`${run}/${name}`);
  if (!r || !r.killPid) return Promise.resolve('没有找到要结束的程序，请先点「看看卡哪了」');
  const d = path.join(RUNS, run, 'agents', name);
  fs.appendFileSync(path.join(d, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'user', text: `你结束了它卡住的程序：${r.killName}` }) + '\n');
  return new Promise((res) => execFile('taskkill', ['/PID', String(r.killPid), '/T', '/F'], { windowsHide: true }, () => { lastDiag.delete(`${run}/${name}`); res(''); }));
}
async function restartAgent(run, name) {
  const d = path.join(RUNS, run, 'agents', name);
  const notice = checkCustomReply(d);
  if (notice) return notice;
  await stopAgent(run, name);
  // 等调度器把它标记为已停止（最多 20 秒），再接着原来的对话继续
  for (let i = 0; i < 40; i++) {
    const m = readJSON(path.join(d, 'meta.json'), {});
    if (m.status !== 'running' || !alive(m.pid)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  lastDiag.delete(`${run}/${name}`);
  replyAgent(run, name, '你刚才好像卡住了，很久没有动静，我把你重启了。请先想想是不是有命令一直没结束（比如启动了不会自己退出的服务器或监听程序），这类命令请换成会自己结束的方式；然后从中断的地方接着完成原来的任务。');
  return '';
}

function stopAgent(run, name) {
  const d = path.join(RUNS, run, 'agents', name);
  const meta = readJSON(path.join(d, 'meta.json'), {});
  if (['agy', 'dsh', 'command'].includes(meta.kind || meta.agent)) {
    return new Promise((res) => execFile('node', [path.join(ROOT, 'dispatch.mjs'), 'stop', '--run', run, '--name', name], { cwd: ROOT, windowsHide: true }, (err) => res(!err)));
  }
  try { fs.writeFileSync(path.join(d, 'stop.flag'), new Date().toISOString()); } catch {}
  return new Promise((res) => {
    if (!meta.childPid) return res(false);
    execFile('taskkill', ['/PID', String(meta.childPid), '/T', '/F'], { windowsHide: true }, () => res(true));
  });
}

// ---------- 系统通知和提示音：跑偏、被阻碍、等你选择、完成、全部完成 ----------
const seen = new Map(); // key: run/name -> 已处理事件数
let mainWin = null;
function scanForNotifications(first) {
  let sound = null; // 一次只放一个声音：卡住 > 全部完成 > 完成一项
  const rank = { attention: 3, celebrate: 2, done: 1 };
  const want = (s) => { if (!sound || rank[s] > rank[sound]) sound = s; };
  for (const r of listRuns().slice(0, 10)) {
    const agents = loadAgents(path.join(RUNS, r.id));
    let doneNow = false;
    for (const a of agents) {
      const key = `${r.id}/${a.name}`;
      const prev = seen.get(key);
      seen.set(key, a.events.length);
      if (first || prev === undefined || a.events.length < prev) continue;
      for (const ev of a.events.slice(prev)) {
        const title = { warn: `${a.name} 可能跑偏了`, blocked: `${a.name} 被阻碍，需要你处理`, question: `${a.name} 等你做选择`, done: `${a.name} 完成了`, error: `${a.name} 出错了` }[ev.type];
        if (!recorder && title && Notification.isSupported()) new Notification({ title, body: ev.text, silent: true }).show();
        if (['warn', 'blocked', 'question', 'error'].includes(ev.type)) want('attention');
        if (ev.type === 'done') doneNow = true;
      }
    }
    if (doneNow) want(agents.length > 1 && agents.every((a) => a.status === 'done') ? 'celebrate' : 'done');
  }
  if (sound && mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('sound', sound);
}

function createWindow() {
  const options = {
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: 'AI指挥台', autoHideMenuBar: true, backgroundColor: '#FAF8F4',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  };
  const win = new BrowserWindow(recorder
    ? recorder.windowOptions(options, require('electron').screen.getPrimaryDisplay().workArea)
    : options);
  mainWin = win;
  if (recorder) {
    recorder.record(win, path.join(__dirname, 'index.html'))
      .then(() => app.exit(0), (error) => { console.error('[record]', error); app.exit(1); });
    return;
  }
  win.loadFile(path.join(__dirname, 'index.html'));
  // 调试用：设置环境变量 AICONSOLE_SHOT=<png路径> 时，几秒后把窗口画面存成图片
  if (process.env.AICONSOLE_SHOT) {
    setTimeout(async () => {
      if (process.env.AICONSOLE_SHOT_SCROLL) await win.webContents.executeJavaScript(`document.getElementById('main').scrollTop = ${Number(process.env.AICONSOLE_SHOT_SCROLL)}`);
      if (process.env.AICONSOLE_SHOT_COOL) { await win.webContents.executeJavaScript(`cool = true; applyCool();`); await new Promise((r) => setTimeout(r, 1500)); }
      if (process.env.AICONSOLE_SHOT_CLICK) { await win.webContents.executeJavaScript(`(document.querySelector(${JSON.stringify(process.env.AICONSOLE_SHOT_CLICK)})||{click(){}}).click()`); await new Promise((r) => setTimeout(r, Number(process.env.AICONSOLE_SHOT_CLICK_WAIT || 800))); }
      if (process.env.AICONSOLE_SHOT_EVAL) {
        try { fs.writeFileSync(process.env.AICONSOLE_SHOT + '.txt', String(await win.webContents.executeJavaScript(process.env.AICONSOLE_SHOT_EVAL))); }
        catch (e) { fs.writeFileSync(process.env.AICONSOLE_SHOT + '.txt', 'EVAL ERROR: ' + e.message); }
      }
      // 截图偶尔会因为画面还没准备好而失败，最多重试 5 次
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 800));
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.AICONSOLE_SHOT, img.toPNG());
          break;
        } catch {}
      }
      if (process.env.AICONSOLE_SHOT_QUIT) app.quit();
    }, Number(process.env.AICONSOLE_SHOT_DELAY || 4000));
  }
}

app.setAppUserModelId('AI指挥台');
app.whenReady().then(() => {
  fs.mkdirSync(RUNS, { recursive: true });
  ipcMain.handle('runs:list', () => listRuns());
  ipcMain.handle('run:get', (_e, id) => loadRun(id));
  ipcMain.handle('agents:list', () => listAgents());
  ipcMain.handle('agents:add', (_e, def) => {
    try { addCustomAgent(def); return ''; }
    catch (err) { return err.message; }
  });
  ipcMain.handle('agents:remove', (_e, id) => {
    try { removeCustomAgent(id); return ''; }
    catch (err) { return err.message; }
  });
  ipcMain.handle('agents:set', (_e, data) => {
    try { setAgent(data?.id, data?.patch); return ''; }
    catch (err) { return err.message; }
  });
  ipcMain.handle('agent:stop', (_e, { run, name }) => stopAgent(run, name));
  ipcMain.handle('agent:mark-done', (_e, { run, name }) => {
    try { markAgentDone(RUNS, run, name); return ''; }
    catch (err) { return err.message; }
  });
  ipcMain.handle('agent:fold', (_e, { run, name, hidden }) => {
    try { setFolded(RUNS, run, name, hidden); return ''; }
    catch (err) { return err.message; }
  });
  ipcMain.handle('agent:reply', (_e, { run, name, text }) =>
    recorder ? recorder.reply(run, name, text) : replyAgent(run, name, text));
  ipcMain.handle('agent:open', (_e, { run, name, terminal }) => openAgent(run, name, terminal));
  ipcMain.handle('layout:get', () => readJSON(LAYOUT, null));
  ipcMain.handle('layout:set', (_e, layout) => saveLayout(layout));
  ipcMain.handle('runs:trash', (_e, ids) => trashRuns(ids));
  ipcMain.handle('agent:diagnose', (_e, { run, name }) => diagnoseAgent(run, name));
  ipcMain.handle('agent:kill-stuck', (_e, { run, name }) => killStuckChild(run, name));
  ipcMain.handle('agent:restart', (_e, { run, name }) => restartAgent(run, name));
  ipcMain.handle('agent:link', (_e, { run, name }) => {
    const meta = readJSON(path.join(RUNS, run, 'agents', name, 'meta.json'), {});
    if (meta.link && /^claude:\/\//.test(meta.link)) { shell.openExternal(meta.link); return ''; }
    return '没有可以打开的会话链接';
  });
  createWindow();
  scanForNotifications(true);
  setInterval(() => scanForNotifications(false), 2000);
});
app.on('window-all-closed', () => app.quit());
