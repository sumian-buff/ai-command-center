#!/usr/bin/env node
// AI指挥台 · 调度器
// Claude 用它启动名单中已开启的助手，把实时事件翻译成大白话，写进 runs/<任务>/ 给桌面窗口显示。
//
// 用法（详见 README.md）：
//   node dispatch.mjs agents [--json]
//   node dispatch.mjs agent-set --id <助手ID> [--enabled true|false] [--role 定位] [--model 模型]
//   node dispatch.mjs run    --run <任务ID> --agent <助手ID> --name <显示名> --task <一句话任务>
//                            --cwd <工作目录> --prompt-file <提示文件> [--sites 域名1,域名2] [--step N] [--readonly]
//   node dispatch.mjs resume --run <任务ID> --name <显示名> (--message-file <文件> | --text <话>)
//   node dispatch.mjs open   --run <任务ID> --name <显示名>      打开它自己的对话窗口
//   node dispatch.mjs stop   --run <任务ID> --name <显示名>
//   node dispatch.mjs mark   --run <任务ID> --name <显示名> [--text <说明>]
//   node dispatch.mjs fold   --run <任务ID> --name <显示名> [--undo]   收起/放回用完的卡片
//   node dispatch.mjs step   --run <任务ID> --n <步骤号> --status todo|doing|done|blocked
//   node dispatch.mjs note   --run <任务ID> --text <Claude 的说明>
//   node dispatch.mjs status [--run <任务ID>]                    给 Claude 看的进度汇总

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createAgyChildren, stopAgyChildren } from './agy-children.mjs';
import { alive, markAgentDone } from './mark-done.cjs';
import { foldedNames, setFolded } from './fold.cjs';
import { listAgents, setAgent, addCustomAgent, removeCustomAgent, commandResumeNotice } from './agents.cjs';
import { deepseekSpec, createDeepseekEvents, deepseekBlockReason } from './deepseek.mjs';
import { commandSpec, createCommandEvents } from './command.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.join(ROOT, 'runs');

// ---------- 小工具 ----------
const now = () => new Date().toISOString();
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      out[k] = next !== undefined && !next.startsWith('--') ? argv[++i] : true;
    } else out._.push(a);
  }
  return out;
}
function readJSON(f, d) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; }
}
function writeJSON(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const data = JSON.stringify(o, null, 2);
  const tmp = f + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, f); } catch { try { fs.writeFileSync(f, data); } catch {} }
}
function appendLine(f, o) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(o) + '\n');
}
const short = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);
const cleanText = (t) =>
  String(t || '')
    .replace(/\[([^\]]+)\]\(<?(?:file:|\/?[A-Za-z]:)[^)]*\)/g, '$1') // 本地文件链接只留文件名
    .replace(/\r/g, '')
    .trim();
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const agentDir = (run, name) => path.join(RUNS, String(run), 'agents', String(name));

// ---------- 网站名字 ----------
const SITE_NAMES = [
  ['xiaohongshu.com', '小红书'], ['xhscdn.com', '小红书'], ['apps.apple.com', 'App Store'], ['apple.com', '苹果官网'],
  ['douyin.com', '抖音'], ['taobao.com', '淘宝'], ['tmall.com', '天猫'], ['1688.com', '1688'], ['jd.com', '京东'],
  ['zhihu.com', '知乎'], ['douban.com', '豆瓣'], ['bilibili.com', 'B站'], ['weibo.com', '微博'], ['qq.com', '腾讯/微信'],
  ['baidu.com', '百度'], ['google.com', 'Google'], ['bing.com', '必应'], ['github.com', 'GitHub'], ['dianping.com', '大众点评'],
  ['taptap.cn', 'TapTap'], ['csdn.net', 'CSDN'], ['youtube.com', 'YouTube'], ['wikipedia.org', '维基百科'],
];
function siteName(host) {
  const h = host.replace(/^www\./, '');
  const hit = SITE_NAMES.find(([d]) => h === d || h.endsWith('.' + d));
  return hit ? `${hit[1]}（${h}）` : h;
}

// ---------- 提示包装：汇报规则 + 遇阻规则 + 选择规则 ----------
function buildPrompt(agent, userPrompt, sites) {
  const lines = [
    '【给你的工作规则，请严格遵守】',
    '1. 用户不懂代码，会实时看你的进度。开始前先用一句中文说明你的计划；每开始一个新的小阶段，先用一句中文说明接下来要做什么、为什么。不要在说明里贴代码。',
    '2. 遇到登录、权限、缺少插件或工具、需要 API key 这类阻碍时，不要换路线、不要改用别的数据源绕过去。直接在最后的回复里以「被阻碍：」开头，写明卡在哪里、需要用户做什么，然后结束。用户处理好后会让你继续。',
    '3. 需要用户做选择时，不要弹出提问窗口、不要使用任何提问工具。在最后的回复里单独写一行「需要你选择：」，下面每行一个选项，用 1. 2. 3. 编号并写清楚区别，然后结束，等用户回复。',
    '4. 除此之外，欢迎你主动补充和改进，但要在总结里说明你额外做了什么、为什么。',
    '5. 最后用几句中文总结：做了什么、改了哪些文件、还有什么问题。',
  ];
  if (sites.length) lines.push(`6. 本任务的网站范围：${sites.join('、')}。超出范围的网站不要去。`);
  if (agent === 'agy') {
    lines.push('7. 只能创建和编辑文件，不要运行任何终端命令，也不要使用 git。');
    lines.push('8. 需要浏览网页时，用浏览器子代理操作用户自己的 Chrome。如果网站要求登录或登录已过期：用浏览器打开该网站的登录页面并停在那里，然后以「被阻碍：」开头说明「已在你的 Chrome 里打开了某某网站的登录页，请登录后让我继续」，然后结束。不要尝试替用户输入账号密码，不要绕过登录。');
    lines.push('9. 在网站上只做浏览和阅读，不要点赞、收藏、关注、评论、发帖、私信或购买。');
    // 每次新连接 Chrome，Chrome 都会弹「允许远程调试」窗口（Chrome 的安全设计，关不掉），所以要少连、别反复重连
    lines.push('10. 每连接一次 Chrome，用户都要在 Chrome 弹窗里点一次「允许」，所以要尽量少连接：整个任务尽量只派一个浏览器子代理，后续步骤用 send_message 继续给同一个子代理下指令，不要每一步都新开子代理。不要在网页里运行脚本（evaluate_script 在无人值守模式下会被拒绝，子代理会因此失败），用页面快照、点击、填写、上传文件这类普通操作代替。连不上 Chrome 或连接超时时不要反复重试：以「被阻碍：」开头说明「请看一下 Chrome 有没有弹出允许远程调试的窗口，点允许后让我继续」，然后结束。');
  }
  if (['codex', 'dsh', 'command'].includes(agent)) lines.push('7. 不要执行 git commit / git push，提交由 Claude 负责。');
  if (agent === 'claude') lines.push('7. 你是被派出来干活的助手：自己完成任务，不要再把活派给其他 agent，不要使用 AI指挥台的 dispatch.mjs，不要执行 git commit / git push。');
  return lines.join('\n') + '\n\n【任务】\n' + userPrompt;
}

// ---------- 把命令行翻译成大白话 ----------
function describeCommand(cmd) {
  const c = String(cmd || '');
  const inner = (c.match(/-Command\s+['"]?([\s\S]*)$/i) || [, c])[1];
  const file = (inner.match(/[\w\u4e00-\u9fa5.\-\\/]+\.(md|txt|json|js|mjs|ts|tsx|jsx|html|css|py|toml|yaml|yml|csv|xml|vue)\b/i) || [])[0];
  const fname = file ? path.basename(file.replace(/\\\\/g, '\\')) : '';
  if (/\b(git)\b/i.test(inner)) return '查看/操作版本记录（git）';
  if (/\b(npm|pnpm|yarn)\b.*\btest\b|\bpytest\b|\bvitest\b|\bjest\b/i.test(inner)) return '运行测试';
  if (/\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip\s+install\b/i.test(inner)) return '安装依赖包';
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?(build|dev|start)\b/i.test(inner)) return '构建/启动项目';
  if (/Set-Content|Out-File|Add-Content|WriteAll|New-Item|apply_patch|(^|\s)>{1,2}\s*[\w.\\/-]+\.\w{1,5}\b/i.test(inner)) return fname ? `修改文件：${fname}` : '修改文件';
  if (/\b(node|python)\b/i.test(inner) && fname) return `检查/运行：${fname}`;
  if (/Get-Content|\bcat\b|\btype\b|Select-String|\brg\b|\bgrep\b|\bsed -n\b/i.test(inner)) return fname ? `查看文件：${fname}` : '查看文件内容';
  if (/Get-ChildItem|\bls\b|\bdir\b|\bfind\b/i.test(inner)) return '浏览文件夹';
  if (/\b(python|node)\b/i.test(inner)) return '运行脚本';
  return '运行了一条命令';
}

// ---------- 识别「需要你选择」的选项 ----------
function parseChoices(text) {
  const m = text.match(/需要你选择[:：]?\s*\n([\s\S]*)$/);
  if (!m) return [];
  const opts = [];
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(?:[-*]\s*)?(\d+)[.、)）]\s*(.+?)\s*$/);
    if (mm) opts.push(mm[2].replace(/\*\*/g, ''));
    else if (opts.length && line.trim() === '') continue;
    else if (opts.length) break;
  }
  return opts.slice(0, 8);
}

// ---------- 各个助手的启动方式 ----------
function cleanClaudeEnv() {
  // 去掉宿主 Claude 会话的内部环境变量，让被派出的 Claude 成为独立会话
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE/i.test(k)) delete env[k];
  return env;
}
function agyStream(command, message, conversationId, model) {
  const args = ['--mode', 'accept-edits', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (model) args.push('--model', model); // 例如 gemini-4-neon-xhigh，用 agy models 查看
  if (conversationId) args.push('--conversation', conversationId);
  return cliSpec(command, args, JSON.stringify({ event: 'user', message: { content: message } }) + '\n');
}
// 仅当派活时显式加了 --network / --add-dir 才放开：单次任务联网、额外可写目录。
function codexExtra(m) {
  const extra = [];
  if (m.network) extra.push('-c', 'sandbox_workspace_write.network_access=true');
  // 额外可写目录用 -c 配置传：exec resume 不认 --add-dir，-c 对新建和继续都生效
  if (m.addDirs && m.addDirs.length) extra.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(m.addDirs)}`);
  // --approve-for-me（只用于上架类任务）：允许请求出沙箱，先按 ~/.codex/rules 判定，规则未覆盖的交给 Codex 自动审核。
  // 用 -c 配置而不是 codex 的同名参数，因为 exec resume 不支持该参数，而 -c 对新建和继续都生效。
  if (m.approveForMe) extra.push('-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"');
  return extra;
}
// --path-add：把指定目录临时加到这个 Codex 进程的 PATH 最前面（例如 redapp 的 npm 安装目录）。
function codexEnv(m) {
  if (!m.pathAdd || !m.pathAdd.length) return undefined;
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return { ...process.env, [key]: [...m.pathAdd, process.env[key] || ''].join(path.delimiter) };
}
function cliSpec(command, args, stdin, env) {
  // npm 安装的官方 CLI 可直接交给 Node；原生程序直接运行。
  if (/\.[cm]?js$/i.test(command)) return { exe: process.execPath, args: [command, ...args], stdin, env };
  return { exe: command, args, stdin, env };
}

const adapters = {
  codex(command, m, message, resume) {
    const args = resume
      ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode="${m.sandbox || 'workspace-write'}"`]
      : ['exec', '--json', '-s', m.sandbox, '--skip-git-repo-check', '-C', m.cwd];
    if (m.model) args.push('--model', m.model);
    args.push(...codexExtra(m));
    if (resume) args.push(m.convId);
    return cliSpec(command, [...args, '-'], message, codexEnv(m));
  },
  agy(command, m, message, resume) {
    return agyStream(command, message, resume ? m.convId : null, m.model);
  },
  claude(command, m, message, resume) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
    if (m.model) args.push('--model', m.model);
    return cliSpec(command, [...args, resume ? '--resume' : '--session-id', m.convId], message, cleanClaudeEnv());
  },
  dsh: deepseekSpec,
};

function listedAgent(id) {
  const agent = listAgents().find((entry) => entry.id === id);
  if (!agent) throw new Error(`助手名单里没有「${id}」，请运行 node dispatch.mjs agents 查看可用编号。`);
  return agent;
}

function runnableAgent(agent, previousKind) {
  if (agent.kind === 'desktop') throw new Error(`${agent.name} 只有桌面程序，暂无官方命令行，不能无人值守派活。`);
  if (!agent.enabled) throw new Error(`${agent.name} 已关闭。如需派活，请先在助手名单中开启它。`);
  if (!agent.found) throw new Error(`找不到 ${agent.name} 的启动程序，请检查安装位置和助手名单中的 command。`);
  if (previousKind && agent.kind !== previousKind) throw new Error('该助手的启动方式已改变，请用新的任务卡重新派活。');
  return agent;
}

// ---------- 确保指挥台窗口开着：派活、登记会话、写计划说明时自动打开 ----------
function ensureConsole() {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(exe)) return;
  let running = false;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `@(Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }).Count`],
    { encoding: 'utf8', windowsHide: true });
    running = Number(out.trim()) > 0;
  } catch {}
  if (!running) spawn(exe, [ROOT], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
}

// ---------- 运行一个助手进程，翻译事件，结束后定状态 ----------
async function runAgent(run, name, spec, agent, browserSetup = false) {
  const dir = agentDir(run, name);
  const eventsFile = path.join(dir, 'events.jsonl');
  const metaFile = path.join(dir, 'meta.json');
  const stopFlag = path.join(dir, 'stop.flag');
  const meta = readJSON(metaFile, null);
  Object.assign(meta, { status: 'running', pid: process.pid, lastStartedAt: now(), endedAt: null, options: [], handover: false, current: browserSetup ? '正在启用浏览器…' : '正在启动…' });
  const sites = meta.sites || [];
  const cwd = meta.cwd;

  const warned = new Set();
  const emit = (type, text, extra = {}) => {
    text = cleanText(text);
    if (!text) return;
    if (type === 'warn') {
      if (warned.has(text)) return; // 同一个提醒只报一次
      warned.add(text);
      meta.warnings = (meta.warnings || 0) + 1;
    }
    appendLine(eventsFile, { ts: now(), type, text, ...extra });
    if (type === 'act' || type === 'say') meta.current = short(text.split('\n')[0], 80);
    writeJSON(metaFile, meta);
  };
  const checkUrl = (url, report = emit) => {
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
    if (sites.length && !sites.some((s) => host === s || host.endsWith('.' + s))) report('warn', `访问了任务范围外的网站：${siteName(host)}`);
    return host;
  };
  const checkWrite = (p, report = emit) => {
    if (!p) return;
    const abs = path.resolve(cwd, String(p));
    const relative = path.relative(cwd, abs);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) report('warn', `改动了任务文件夹以外的文件：${abs}`);
  };
  const addTokens = (n) => { meta.tokens = (meta.tokens || 0) + (n || 0); writeJSON(metaFile, meta); };

  // 原始记录（给炫酷模式用）：真实的命令、输出、写入的代码，太大时只保留最后一段
  const rawFile = path.join(dir, 'raw.log');
  let rawWrites = 0;
  const raw = (text) => {
    if (text === undefined || text === null || text === '') return;
    let s = String(text).replace(/\r/g, '');
    if (s.length > 6000) s = s.slice(0, 6000) + `\n… (省略 ${s.length - 6000} 字)`;
    try {
      fs.appendFileSync(rawFile, s.endsWith('\n') ? s : s + '\n');
      if (++rawWrites % 100 === 0 && fs.statSync(rawFile).size > 3 * 1024 * 1024) {
        const all = fs.readFileSync(rawFile, 'utf8');
        fs.writeFileSync(rawFile, all.slice(-1024 * 1024));
      }
    } catch {}
  };
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const rawJson = (o) => { try { return JSON.stringify(o, null, 2); } catch { return String(o); } };
  const setConv = (id) => { if (id && meta.convId !== id) { meta.convId = id; writeJSON(metaFile, meta); } };

  const child = spawn(spec.exe, spec.args, {
    cwd, stdio: [spec.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments, env: spec.env || process.env,
  });
  let lastError = '';
  const kind = meta.kind || meta.agent;
  const isAgy = kind === 'agy';
  if (child.stdin) child.stdin.on('error', (err) => { lastError = '无法向助手发送消息：' + err.message; });
  meta.childPid = child.pid;
  writeJSON(metaFile, meta);
  // 停止请求也可能正好赶在浏览器准备结束与正式进程登记之间。
  if (child.pid && fs.existsSync(stopFlag)) killTree(child.pid);
  else if (child.stdin && child.pid) {
    if (isAgy) child.stdin.write(spec.stdin);
    else child.stdin.end(spec.stdin);
  }

  let finalText = '';
  const agyText = new Map();

  // --- Codex 事件 ---
  const onCodex = (ev) => {
    const it = ev.item || {};
    // 原始记录
    if (ev.type === 'item.started' && it.type === 'command_execution') raw(`[${stamp()}] PS> ${it.command}`);
    else if (ev.type === 'item.completed' && it.type === 'command_execution') raw(`${it.aggregated_output || ''}[exit ${it.exit_code}]`);
    else if (ev.type === 'item.completed' && it.type === 'file_change') raw((it.changes || []).map((c) => `[${stamp()}] ${c.kind === 'add' ? '+++ new' : c.kind === 'delete' ? '--- del' : '*** edit'} ${c.path}`).join('\n'));
    else if (ev.type === 'item.completed' && it.type === 'reasoning' && it.text) raw(`// ${it.text.replace(/\n/g, '\n// ')}`);
    else if (ev.type === 'item.completed' && it.type === 'agent_message') raw(`[${stamp()}] codex: ${it.text}`);
    else if (ev.type === 'item.completed' && it.type === 'web_search') raw(`[${stamp()}] web.search(${JSON.stringify(it.query || (it.action && it.action.query) || '')})\n${(it.results || []).slice(0, 5).map((r) => `  -> ${r.domain || ''} ${String(r.snippet || '').slice(0, 160)}`).join('\n')}`);
    else if (ev.type === 'turn.completed') raw(`[${stamp()}] turn.completed ${rawJson(ev.usage)}`);
    else if (ev.type && !/^item\.updated$/.test(ev.type) && it.type !== 'agent_message') raw(`[${stamp()}] ${ev.type}${it.type ? ' ' + it.type : ''}`);
    if (ev.type === 'thread.started') setConv(ev.thread_id);
    else if (ev.type === 'item.completed' && it.type === 'agent_message') { finalText = it.text; emit('say', it.text); }
    else if (ev.type === 'item.started' && it.type === 'command_execution') {
      const urls = String(it.command || '').match(/https?:\/\/[^\s'"\\)]+/g) || [];
      if (urls.length) urls.forEach((u) => { const h = checkUrl(u); if (h) emit('act', `访问网站：${siteName(h)}`); });
      else emit('act', describeCommand(it.command), { detail: short(String(it.command || ''), 400) });
    }
    else if (ev.type === 'item.completed' && it.type === 'command_execution' && it.exit_code && it.exit_code !== 0) {
      emit('act', '上一条命令没成功，正在处理', { detail: short(String(it.aggregated_output || ''), 400) });
    }
    else if (ev.type === 'item.completed' && it.type === 'file_change') {
      for (const ch of it.changes || []) {
        checkWrite(ch.path);
        const verb = ch.kind === 'add' ? '新建了' : ch.kind === 'delete' ? '删除了' : '修改了';
        emit('act', `${verb}文件：${path.basename(String(ch.path || ''))}`);
      }
    }
    else if (ev.type === 'item.completed' && it.type === 'web_search') {
      const act = it.action || {};
      if (act.type === 'open_page' && act.url) { const h = checkUrl(act.url); emit('act', `打开网页：${h ? siteName(h) : act.url}`); }
      else if (it.query || act.query) emit('act', `网上搜索：${it.query || act.query}`);
    }
    else if (ev.type === 'item.completed' && it.type === 'mcp_tool_call') emit('act', `使用工具：${it.server || ''} ${it.tool || ''}`.trim());
    else if (ev.type === 'item.started' && /collab|subagent|spawn/i.test(String(it.type || ''))) {
      // Codex 自己派出子助手（事件格式未完全确认，尽量识别）
      const tool = String(it.tool || it.name || '');
      const what = it.prompt || it.description || '';
      emit('act', /spawn|start/i.test(tool + it.type) || !tool ? `派出子助手${what ? '：' + short(String(what), 40) : ''}` : `和子助手协作（${tool}）`);
    }
    else if ((ev.type === 'item.updated' || ev.type === 'item.completed') && it.type === 'todo_list') {
      const items = it.items || [];
      emit('act', `更新了待办清单（${items.filter((x) => x.completed).length}/${items.length} 完成）`);
    }
    else if (ev.type === 'turn.completed' && ev.usage) addTokens((ev.usage.input_tokens || 0) - (ev.usage.cached_input_tokens || 0) + (ev.usage.output_tokens || 0));
    else if (ev.type === 'error' || ev.type === 'turn.failed') { lastError = ev.message || (ev.error && ev.error.message) || '出错了'; emit('error', lastError); }
  };

  // --- agy 事件 ---
  const AGY_TOOLS = {
    read_file: '查看文件', view_file: '查看文件', list_dir: '浏览文件夹', find_by_name: '查找文件', grep_search: '在文件里搜索内容',
    write_to_file: '写入文件', replace_file_content: '修改文件', multi_replace_file_content: '修改文件', sed_file: '修改文件', notebook_edit: '修改笔记本',
    write_file: '写入文件', edit_file: '修改文件', create_file: '新建文件', delete_file: '删除文件',
    search_web: '网上搜索', read_url_content: '读取网页', open_browser_url: '在浏览器打开网页', read_browser_page: '阅读浏览器页面',
    browser_click_element: '在网页上点击', click_browser_pixel: '在网页上点击', browser_input: '在网页上输入文字', browser_scroll: '滚动网页',
    browser_scroll_dom: '滚动网页', browser_press_key: '在网页上按键', capture_browser_screenshot: '给网页截图', browser_get_dom: '读取网页结构',
    list_browser_pages: '查看打开的网页', execute_browser_javascript: '在网页里运行脚本', browser_refresh_page: '刷新网页',
    run_command: '运行命令', send_command_input: '给命令输入内容', command_status: '查看命令进度',
    invoke_subagent: '派出子助手', browser_subagent: '派出浏览器子助手', define_subagent: '创建子助手', manage_subagents: '管理子助手',
    generate_image: '生成图片', ask_permission: '请求权限', ask_custom_permission: '请求权限', ask_question: '向你提问（无人值守时会被自动拒绝）',
    manage_task: '更新任务清单', wait: '等待', wait_5_seconds: '等待',
    send_message: '给子助手发消息',
  };
  const AGY_WRITE = new Set(['write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit', 'edit_file', 'create_file', 'delete_file']);
  const pick = (obj, keys) => { for (const k of keys) if (obj && obj[k]) return String(obj[k]); return ''; };
  function describeAgyTool(tool, params, report) {
    const label = AGY_TOOLS[tool] || `使用工具：${tool}`;
    const url = pick(params, ['Url', 'url', 'URL']);
    const file = pick(params, ['Path', 'path', 'AbsolutePath', 'TargetFile', 'File', 'file']);
    const query = pick(params, ['query', 'Query', 'SearchQuery']);
    if (AGY_WRITE.has(tool)) checkWrite(file, report);
    if (url) {
      const host = checkUrl(url, report);
      return label + '：' + (host ? siteName(host) : url);
    }
    if (query) return label + '：' + query;
    if (file) return label + '：' + path.basename(file);
    return label;
  }
  const children = isAgy ? createAgyChildren({ dir, meta, describeTool: describeAgyTool, writeJSON, cleanText }) : null;
  const pollTimer = isAgy ? setInterval(() => children.poll(), 500) : null;
  let agyResultStatus;
  let unfinished = [];
  let agyStreaming = false;
  const onAgy = (ev) => {
    // 原始记录：流式回复逐字写入，工具调用写参数和结果
    if (ev.event === 'step_update') {
      const s = ev.step_update || {};
      if (s.step_type === 'agent_response' && s.text_delta) {
        try { fs.appendFileSync(rawFile, (agyStreaming ? '' : `[${stamp()}] agy: `) + s.text_delta); } catch {}
        agyStreaming = s.state !== 'DONE';
        if (s.state === 'DONE') raw('');
      } else if (s.step_type === 'tool' || s.step_type === 'subagent') {
        if (agyStreaming) { raw(''); agyStreaming = false; }
        const info = s.tool_info || {};
        if (s.state === 'ACTIVE') raw(`[${stamp()}] >> ${s.tool_name}(${rawJson(info.parameters || s.subagent_info || {})})`);
        else raw(`<< ${s.tool_name} ${s.state}${s.duration_seconds ? ` ${Number(s.duration_seconds).toFixed(2)}s` : ''}${info.output ? '\n' + String(info.output) : ''}`);
      }
    } else if (ev.event === 'init') raw(`[${stamp()}] session.init ${ev.conversation_id || ''}`);
    else if (ev.event === 'result') raw(`[${stamp()}] result ${rawJson({ status: ev.result && ev.result.status, usage: ev.result && ev.result.usage })}`);
    if (ev.event === 'init') setConv(ev.conversation_id || (ev.init && ev.init.conversation_id));
    else if (ev.event === 'step_update') {
      const s = ev.step_update || {};
      setConv(s.conversation_id);
      if (s.step_type === 'agent_response') {
        const t = (agyText.get(s.step_index) || '') + (s.text_delta || '');
        agyText.set(s.step_index, t);
        if (s.state === 'DONE') { emit('say', t); finalText = t; }
        if (s.usage) addTokens(s.usage.total_tokens || 0);
      } else if ((s.step_type === 'tool' || s.step_type === 'subagent') && s.state === 'ACTIVE') {
        emit('act', describeAgyTool(s.tool_name, s.tool_info?.parameters, emit));
      } else if (s.step_type === 'tool' && s.state && !['ACTIVE', 'DONE'].includes(s.state)) {
        emit('error', `操作没成功：${AGY_TOOLS[s.tool_name] || s.tool_name}（${s.state}）`);
      }
      children.handleStep(s, agyText.get(s.step_index));
    } else if (ev.event === 'result') {
      child.stdin.end();
      const r = ev.result || {};
      setConv(r.conversation_id);
      if (r.response) finalText = r.response;
      agyResultStatus = r.status || '未提供状态';
      if (agyResultStatus !== 'SUCCESS') { lastError = `agy 结束状态：${agyResultStatus}`; emit('error', lastError); }
      if (r.response) children.handleStep({ step_type: 'agent_response' }, r.response);
      children.poll();
      unfinished = children.runningNames();
    }
  };

  // --- Claude 事件 ---
  const CLAUDE_TOOLS = {
    Read: '查看文件', Write: '写入文件', Edit: '修改文件', MultiEdit: '修改文件', NotebookEdit: '修改笔记本',
    Glob: '查找文件', Grep: '在文件里搜索内容', LS: '浏览文件夹', Bash: '运行命令', PowerShell: '运行命令',
    WebSearch: '网上搜索', WebFetch: '读取网页', Task: '派出子助手', Agent: '派出子助手', TodoWrite: '更新待办清单',
    AskUserQuestion: '向你提问（无人值守时无法弹窗）',
  };
  const onClaude = (ev) => {
    if (ev.session_id) setConv(ev.session_id);
    // 原始记录：工具调用的输入（包括写进文件的代码）和返回结果
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text') raw(`[${stamp()}] claude: ${c.text}`);
        else if (c.type === 'thinking' && c.thinking) raw(`// ${c.thinking.replace(/\n/g, '\n// ')}`);
        else if (c.type === 'tool_use') {
          const inp = c.input || {};
          const body = inp.content || inp.new_string || inp.command || '';
          raw(`[${stamp()}] >> ${c.name} ${inp.file_path || inp.url || inp.query || inp.pattern || ''}${body ? '\n' + body : ''}`);
        }
      }
    } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'tool_result') raw(`<< ${typeof c.content === 'string' ? c.content : rawJson(c.content)}`);
      }
    } else if (ev.type === 'system' || ev.type === 'result') raw(`[${stamp()}] ${ev.type}${ev.subtype ? '.' + ev.subtype : ''}`);
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) { emit('say', c.text); finalText = c.text; }
        else if (c.type === 'tool_use') {
          const inp = c.input || {};
          let text = CLAUDE_TOOLS[c.name] || `使用工具：${c.name}`;
          if (inp.url) { const h = checkUrl(inp.url); text += `：${h ? siteName(h) : inp.url}`; }
          else if (inp.query) text += `：${inp.query}`;
          else if (inp.file_path || inp.notebook_path) text += `：${path.basename(String(inp.file_path || inp.notebook_path))}`;
          else if (inp.command) text = describeCommand(inp.command);
          else if (inp.description) text += `：${short(String(inp.description), 40)}`;
          if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(c.name)) checkWrite(inp.file_path || inp.notebook_path);
          emit('act', text);
        }
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string' && ev.result.trim()) finalText = ev.result;
      if (ev.usage) addTokens((ev.usage.input_tokens || 0) + (ev.usage.cache_creation_input_tokens || 0) + (ev.usage.output_tokens || 0));
      if (ev.is_error) { lastError = ev.result || 'Claude 助手出错了'; emit('error', lastError); }
    }
  };

  const dsh = kind === 'dsh' ? createDeepseekEvents({ emit, raw, setConv, addTokens, checkWrite, checkUrl, describeCommand }) : null;
  const custom = kind === 'command' ? createCommandEvents(agent, { emit, raw, setConv, checkWrite, checkUrl }) : null;
  const parser = { codex: onCodex, agy: onAgy, claude: onClaude, dsh: dsh?.onEvent }[kind];
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    try {
      if (custom) { custom.onLine(line); return; }
      line = line.trim();
      if (!line.startsWith('{')) { if (dsh) raw(line); return; }
      let ev; try { ev = JSON.parse(line); } catch { if (dsh) raw(line); return; }
      parser(ev);
    } catch (e) {
      const reason = `解析事件出错：${e.message}`;
      if (dsh || custom) lastError = reason;
      emit('error', reason);
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
  if (custom) readline.createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', raw);

  const code = await new Promise((res) => { child.on('close', res); child.on('error', (e) => { lastError = e.message; res(-1); }); });
  await new Promise((r) => setTimeout(r, 200)); // 等最后几行读完
  clearInterval(pollTimer);

  // 被用户停止后，记录可能被其他进程改过，重新读一次合并
  const stopped = fs.existsSync(stopFlag);
  if (custom) {
    finalText = custom.finalText;
    lastError = custom.error || lastError;
    meta.childPid = null;
    if (!stopped && (lastError || code !== 0)) {
      lastError ||= stderr.trim() || `程序提前退出（${code ?? '被中断'}）。`;
      if (/^(?:被阻碍|需要你选择)[:：]/.test(stderr.trim())) finalText = stderr.trim();
      finalText ||= lastError;
    }
  }
  let dshBlock = '';
  if (dsh) {
    if (stderr.trim()) raw(stderr.trim());
    lastError = dsh.error || lastError;
    dshBlock = dsh.blocked || (!dsh.completed && deepseekBlockReason(lastError + '\n' + stderr));
    if (!stopped && !dsh.completed && !dshBlock && !lastError) {
      lastError = stderr.trim() ? short(stderr.trim(), 2000) : 'DeepSeek 退出前没有返回完整的本轮结果。';
    }
    finalText = dshBlock ? '被阻碍：' + dshBlock : (dsh.finalText || lastError);
    if (!stopped && lastError && !dshBlock && !dsh.error) emit('error', lastError);
    meta.childPid = null;
  }
  finalText = cleanText(finalText);
  if (isAgy && !stopped && !lastError) {
    if (!agyResultStatus) lastError = 'agy 退出前没有返回本轮结果。';
    else if (browserSetup && !meta.convId) lastError = '启用浏览器后没有收到 agy 的对话编号。';
    if (lastError) emit('error', lastError);
  }
  const missingReports = !stopped && agyResultStatus === 'SUCCESS' && unfinished.length > 0;
  if (missingReports) {
    const reason = '被阻碍：agy 已返回本轮结果，但以下子助手仍在运行，尚未收到回报：' + unfinished.join('、');
    finalText = finalText ? reason + '\n\n' + finalText : reason;
  }
  const blocked = (custom ? /^\s*被阻碍[:：]/m : /被阻碍[:：]/).test(finalText);
  const options = parseChoices(finalText);
  const acceptReply = custom || (code === 0 && (!dsh || !lastError));
  if (stopped) meta.status = 'stopped';
  else if (missingReports || dshBlock) meta.status = 'blocked';
  else if (acceptReply && blocked) meta.status = 'blocked';
  else if (acceptReply && options.length) meta.status = 'question';
  else if (code === 0 && !lastError) meta.status = 'done';
  else meta.status = 'failed';
  if (children) {
    children.finish(meta.status === 'question' ? 'done' : meta.status);
    meta.childPid = null;
    if (browserSetup && meta.status === 'done') {
      meta.status = 'running';
      emit('act', '浏览器已启用，准备发送任务');
      return 'ready';
    }
  }
  meta.options = meta.status === 'question' ? options : [];
  meta.endedAt = now();
  if (custom && meta.status === 'failed' && lastError) {
    const detail = short(lastError, 2000);
    if (!finalText.includes(detail)) finalText += '\n\n' + detail;
    if (!custom.error) emit('error', detail);
  }
  if (!finalText && stderr.trim()) finalText = '（没有拿到回复，错误信息如下）\n' + short(stderr.trim(), 2000);
  if (isAgy && !finalText && lastError) finalText = lastError;
  fs.writeFileSync(path.join(dir, 'result.md'), finalText || '（没有回复）');

  const label = { stopped: '已被你停止', blocked: '被阻碍，需要你处理', question: '等你做选择', done: '完成', failed: '失败' }[meta.status];
  const evType = { done: 'done', blocked: 'blocked', question: 'question', stopped: 'stopped' }[meta.status] || 'error';
  let evText = label;
  if (meta.status === 'blocked') evText += '：' + short(finalText.replace(/^[\s\S]*?被阻碍[:：]/, '').trim(), 160);
  if (meta.status === 'question') evText += '：' + options.map((o, i) => `${i + 1}. ${o}`).join('；');
  const usage = custom ? COMMAND_USAGE_NOTICE : `累计约 ${meta.tokens || 0} token`;
  const resumeNotice = custom && commandResumeNotice(agent, meta.convId);
  if (resumeNotice) appendLine(eventsFile, { ts: now(), type: 'say', text: resumeNotice });
  emit(evType, evText);
  meta.current = label;
  writeJSON(metaFile, meta);

  console.log(`【${name}】${label}｜${usage}｜跑偏提醒 ${meta.warnings || 0} 次｜${resumeNotice || '对话编号 ' + (meta.convId || '无')}`);
  console.log(finalText);
  return meta.status;
}

// 浏览器任务先用 /browser 启用 Chrome，再在同一个对话里发送正式任务。
async function dispatchTurn(run, meta, agent, message, spec) {
  const command = agent.resolvedCommand;
  if (agent.kind === 'agy' && meta.browser) {
    const status = await runAgent(run, meta.name, agyStream(command, '/browser', meta.convId, meta.model), agent, true);
    if (status !== 'ready') return status;
    meta = readJSON(path.join(agentDir(run, meta.name), 'meta.json'), null);
    spec = agyStream(command, message, meta.convId, meta.model);
  }
  return runAgent(run, meta.name, spec, agent);
}

const COMMAND_USAGE_NOTICE = '这个助手不提供 token 用量统计';

function turnSpec(agent, meta, message, resume) {
  if (agent.kind === 'command') return commandSpec(agent, meta, message, resume);
  return adapters[agent.kind](agent.resolvedCommand, meta, message, resume);
}

// ---------- 命令：run ----------
async function cmdRun(a) {
  const run = String(a.run || '');
  if (!run || !a.agent || !a['prompt-file']) {
    console.error('用法：node dispatch.mjs run --run <任务ID> --agent <名单中的助手ID> --prompt-file <文件> [--name 显示名] [--task 任务] [--cwd 目录] [--sites 域名] [--step N] [--readonly] [--network] [--add-dir 目录] [--model 模型] [--path-add 目录] [--approve-for-me]');
    process.exit(2);
  }
  const agent = runnableAgent(listedAgent(String(a.agent)));
  const { id, kind } = agent;
  const name = String(a.name || id);
  const dir = agentDir(run, name);
  const old = readJSON(path.join(dir, 'meta.json'), null);
  if (old && old.status === 'running' && alive(old.pid)) { console.error(`「${name}」还在运行，换一个名字或先停止它。`); process.exit(2); }
  if (old?.parent) { console.error('这个名字属于子助手，请另选一个助手名。'); process.exit(2); }
  const sites = a.sites ? String(a.sites).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const prompt = buildPrompt(kind, fs.readFileSync(String(a['prompt-file']), 'utf8').replace(/^\uFEFF/, ''), sites);
  const meta = {
    name, agent: id, kind, task: String(a.task || ''), cwd: path.resolve(String(a.cwd || process.cwd())), sites,
    step: a.step ? Number(a.step) : null, sandbox: a.readonly ? 'read-only' : 'workspace-write',
    convId: kind === 'claude' ? randomUUID() : null,
    status: 'running', startedAt: now(), endedAt: null, pid: process.pid, childPid: null, tokens: 0, warnings: 0, options: [], current: '正在启动…',
  };
  if (kind === 'agy' && (a.browser || sites.length)) meta.browser = true;
  if (kind === 'codex' && a.network) meta.network = true;
  const model = typeof a.model === 'string' ? a.model : agent.model;
  if (model) meta.model = model;
  if (kind === 'codex' && a['approve-for-me']) {
    if (a.readonly) { console.error('--approve-for-me 不能与 --readonly 同时使用。'); process.exit(2); }
    meta.approveForMe = true;
  }
  if (kind === 'codex' && a['path-add']) meta.pathAdd = String(a['path-add']).split(',').map((d) => path.resolve(d.trim())).filter(Boolean);
  if ((kind === 'codex' || kind === 'dsh') && a['add-dir']) meta.addDirs = String(a['add-dir']).split(',').map((d) => d.trim()).filter(Boolean).map((d) => path.resolve(d));
  if (agent.custom) {
    meta.capabilities = agent.capabilities;
    meta.vendorInfo = { name: agent.name, color: agent.color, icon: agent.icon };
    meta.tokens = null;
  }
  const spec = turnSpec(agent, meta, prompt, false);
  ensureConsole();
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'stop.flag'), { force: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'raw.log'), `# ${name} (${id}) · ${now()}\n# cwd: ${meta.cwd}\n`);
  try { fs.unlinkSync(path.join(dir, 'result.md')); } catch {}
  writeJSON(path.join(dir, 'meta.json'), meta);
  appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'act', text: `接到任务：${meta.task || '（未命名）'}` });
  if (agent.custom) appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'say', text: COMMAND_USAGE_NOTICE + '。' });
  const status = await dispatchTurn(run, meta, agent, prompt, spec);
  process.exit(status === 'done' ? 0 : 1);
}

// ---------- 命令：resume（接着原来的对话继续） ----------
async function cmdResume(a) {
  const run = String(a.run || ''), name = String(a.name || '');
  const dir = agentDir(run, name);
  const meta = readJSON(path.join(dir, 'meta.json'), null);
  if (!meta) { console.error(`找不到助手「${name}」`); process.exit(2); }
  if (meta.parent) { console.error(`请通过主助手「${meta.parent}」继续任务。`); process.exit(2); }
  if (meta.status === 'running' && alive(meta.pid)) { console.error(`「${name}」还在运行，不能同时继续。`); process.exit(2); }
  if (meta.kind !== 'command' && !meta.convId) { console.error(`「${name}」没有对话编号，无法继续。`); process.exit(2); }
  let agent;
  try {
    agent = listedAgent(meta.agent);
    const notice = commandResumeNotice(agent, meta.convId);
    if (notice) {
      appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'say', text: notice });
      console.log(notice);
      return;
    }
    runnableAgent(agent, meta.kind || meta.agent);
  }
  catch (err) {
    appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'error', text: err.message });
    throw err;
  }
  let msg = a['message-file'] ? fs.readFileSync(String(a['message-file']), 'utf8').replace(/^\uFEFF/, '') : String(a.text || '');
  msg = msg.trim() || '我已经处理好了，请从刚才中断的地方继续完成原来的任务。';
  // 提醒它沿用原来的工作规则
  let wrapped = msg + '\n\n（请继续遵守最开始的工作规则：每个阶段用一句中文说明；遇到阻碍以「被阻碍：」开头说明；需要选择时写「需要你选择：」并列出编号选项；最后总结。）';
  if (agent.kind === 'agy' && (meta.browser || a.browser)) wrapped += '\n（用浏览器时：每连接一次 Chrome 用户都要点一次「允许」，尽量沿用同一个浏览器子代理、用 send_message 继续下指令；不要在网页里运行脚本；连不上 Chrome 时不要反复重试，以「被阻碍：」开头请用户在 Chrome 弹窗里点允许。）';
  const spec = turnSpec(agent, meta, wrapped, true);
  appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'user', text: `你回复：${msg}` });
  // 先占住「进行中」，避免启用浏览器那一分钟里，用户在指挥台又点一次继续
  fs.rmSync(path.join(dir, 'stop.flag'), { force: true });
  Object.assign(meta, { kind: agent.kind, status: 'running', pid: process.pid, childPid: null, current: '正在接着干活…', options: [] });
  delete meta.hidden; // 旧卡片接着干活了，重新回到监控墙上
  if (agent.kind === 'agy' && a.browser) meta.browser = true;
  writeJSON(path.join(dir, 'meta.json'), meta);
  const status = await dispatchTurn(run, meta, agent, wrapped, spec);
  process.exit(status === 'done' ? 0 : 1);
}

// ---------- 命令：open（打开它自己的对话窗口） ----------
function cmdOpen(a) {
  const run = String(a.run || ''), name = String(a.name || '');
  const dir = agentDir(run, name);
  const meta = readJSON(path.join(dir, 'meta.json'), null);
  if (meta?.kind === 'command') {
    console.log('这个助手通过命令行工作。要继续，请在指挥台回复；没有设置续聊参数时请重新派活。');
    return;
  }
  if (!meta || !meta.convId) { console.error('没有对话编号，无法打开。'); process.exit(2); }
  if (meta.parent) { console.error(`请打开主助手「${meta.parent}」的对话。`); process.exit(2); }
  if (meta.status === 'running' && alive(meta.pid)) { console.error(`「${name}」还在后台运行，请先停止它再打开对话窗口。`); process.exit(2); }
  const markHandover = (how) => {
    meta.handover = true;
    meta.current = '你在它的对话窗口里接管中';
    writeJSON(path.join(dir, 'meta.json'), meta);
    appendLine(path.join(dir, 'events.jsonl'), { ts: now(), type: 'user', text: `你在${how}里打开了它的对话，直接和它对话。处理完后点「让它继续」。` });
  };
  // Codex 有桌面版，并支持 codex://threads/<编号> 直接打开指定对话
  const kind = meta.kind || meta.agent;
  if (kind === 'codex' && !a.terminal) {
    spawn('cmd.exe', ['/d', '/c', `start "" "codex://threads/${encodeURIComponent(meta.convId)}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    markHandover(' Codex 桌面版');
    return;
  }
  if (kind === 'dsh') throw new Error('要继续这段 DeepSeek 对话，请在指挥台回复或运行 resume 命令。');
  const agent = runnableAgent(listedAgent(meta.agent), kind);
  const flag = { codex: 'resume', agy: '--conversation', claude: '--resume' }[kind];
  const interactive = cliSpec(agent.resolvedCommand, [flag, meta.convId]);
  const script = [
    `$Host.UI.RawUI.WindowTitle = ${psQuote(name + ' 的对话窗口')}`,
    `Set-Location -LiteralPath ${psQuote(meta.cwd)}`,
    `Write-Host ${psQuote('这是「' + name + '」自己的对话窗口，带着刚才的完整记录。处理完后关掉这个窗口，回到 AI指挥台点「让它继续」。')} -ForegroundColor Yellow`,
    '& ' + [interactive.exe, ...interactive.args].map(psQuote).join(' '),
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const env = kind === 'claude' ? cleanClaudeEnv() : process.env;
  const title = `AI指挥台 - ${name.replace(/"/g, '')}`;
  const WT = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  if (fs.existsSync(WT)) {
    // 优先用新版 Windows 终端：老式控制台画不出这些对话界面，会是一片黑
    spawn(WT, ['-w', 'new', 'new-tab', '--title', title, '-d', meta.cwd, 'powershell.exe', '-NoExit', '-NoProfile', '-EncodedCommand', encoded], {
      cwd: meta.cwd, detached: true, stdio: 'ignore', env,
    }).unref();
  } else {
    // 没有 Windows 终端时退回老式控制台（用 start 开新窗口，这样它有自己的键盘输入）
    spawn('cmd.exe', ['/d', '/c', `start "${title}" powershell.exe -NoExit -NoProfile -EncodedCommand ${encoded}`], {
      cwd: meta.cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env,
    }).unref();
  }
  markHandover('终端窗口');
}

// ---------- Claude 侧边栏会话：brief 生成任务说明，attach 登记到指挥台 ----------
const markerOf = (run, name) => `【指挥台编号：${run}/${name}】`;
function cmdBrief(a) {
  // 打印给 Claude 侧边栏会话的完整任务说明（带工作规则和指挥台编号），供 start_session 的 prompt 使用
  const run = String(a.run || ''), name = String(a.name || '');
  const sites = a.sites ? String(a.sites).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  const body = fs.readFileSync(String(a['prompt-file']), 'utf8').replace(/^﻿/, '');
  process.stdout.write(markerOf(run, name) + '\n' + buildPrompt('claude', body, sites) + '\n');
}
function cmdAttach(a) {
  const run = String(a.run || ''), name = String(a.name || '');
  if (!run || !name || !a.session) { console.error('用法：node dispatch.mjs attach --run <任务ID> --name <名字> --session <local_会话编号> --cwd <目录> [--task 任务] [--link claude://...] [--step N]'); process.exit(2); }
  const dir = agentDir(run, name);
  fs.mkdirSync(dir, { recursive: true });
  const sessionId = String(a.session);
  writeJSON(path.join(dir, 'meta.json'), {
    name, agent: 'claude-session', task: String(a.task || ''), cwd: path.resolve(String(a.cwd || process.cwd())),
    step: a.step ? Number(a.step) : null, sessionId, marker: markerOf(run, name),
    link: String(a.link || `claude://claude.ai/epitaxy/${sessionId}`),
    status: 'running', startedAt: now(), warnings: 0, options: [],
  });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  console.log(`已登记：${name}（Claude 侧边栏会话 ${sessionId}）`);
}

// ---------- 命令：stop / mark / step / note / status ----------
function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true });
  } catch (err) {
    if (alive(pid)) throw err;
  }
}
function cmdStop(a) {
  const dir = agentDir(a.run, a.name);
  const meta = readJSON(path.join(dir, 'meta.json'), {});
  if (meta.parent) { console.error(`请停止主助手「${meta.parent}」，它会一起停止子助手。`); process.exit(2); }
  const kind = meta.kind || meta.agent;
  const managedStop = ['agy', 'dsh', 'command'].includes(kind);
  if (managedStop && meta.status !== 'running') return;
  fs.writeFileSync(path.join(dir, 'stop.flag'), now());
  if (managedStop) {
    if (meta.childPid) killTree(meta.childPid);
    // 正常情况下由持有日志的调度器统一收尾。调度器意外退出时才接管记录。
    if (!alive(meta.pid)) {
      if (kind === 'agy') stopAgyChildren(dir, writeJSON);
      Object.assign(meta, { status: 'stopped', endedAt: now(), childPid: null, current: '已被你停止' });
      writeJSON(path.join(dir, 'meta.json'), meta);
      appendLine(path.join(dir, 'events.jsonl'), { ts: meta.endedAt, type: 'stopped', text: meta.current });
    }
    return;
  }
  if (meta.childPid) { try { execFileSync('taskkill', ['/PID', String(meta.childPid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
}
function cmdMark(a) {
  try {
    markAgentDone(RUNS, a.run, a.name, a.text);
    console.log(`「${a.name}」已标记为完成。`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
function cmdFold(a) {
  try {
    setFolded(RUNS, String(a.run), String(a.name), !a.undo);
    console.log(a.undo ? `「${a.name}」已放回监控墙。` : `「${a.name}」已收起。`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
function cmdStep(a) {
  const f = path.join(RUNS, String(a.run), 'plan.json');
  const plan = readJSON(f, null);
  const n = Number(a.n);
  if (!plan || !Array.isArray(plan.steps) || !plan.steps[n - 1]) { console.error('计划里没有这一步'); process.exit(2); }
  plan.steps[n - 1].status = String(a.status || 'done');
  plan.updatedAt = now();
  writeJSON(f, plan);
}
function cmdNote(a) { appendLine(path.join(RUNS, String(a.run), 'notes.jsonl'), { ts: now(), text: String(a.text || '') }); }
function cmdStatus(a) {
  let runs = [];
  try { runs = fs.readdirSync(RUNS).filter((n) => fs.statSync(path.join(RUNS, n)).isDirectory()); } catch {}
  if (a.run) runs = runs.filter((r) => r === String(a.run));
  else runs = runs.sort().slice(-5);
  const NAMES = { running: '进行中', done: '完成', blocked: '被阻碍', question: '等你选择', failed: '失败', stopped: '已停止' };
  for (const r of runs) {
    const plan = readJSON(path.join(RUNS, r, 'plan.json'), {});
    console.log(`\n== ${r}  ${plan.title || ''}`);
    let names = [];
    try { names = fs.readdirSync(path.join(RUNS, r, 'agents')); } catch {}
    // 旧一轮用完、已收起的卡片只列名字，省得刷屏
    const metas = names.map((n) => readJSON(path.join(agentDir(r, n), 'meta.json'), null)).filter(Boolean)
      .map((m) => (m.status === 'running' && m.agent !== 'claude-session' && !alive(m.pid) ? { ...m, status: 'interrupted' } : m));
    const folded = foldedNames(metas);
    if (folded.size) console.log(`（已收起：${[...folded].join('、')}）`);
    for (const n of names) {
      const m = readJSON(path.join(agentDir(r, n), 'meta.json'), null);
      if (!m) continue;
      if (folded.has(m.parent || n)) continue;
      if (m.agent === 'claude-session' && m.status !== 'done') { console.log(`- ${n}（Claude 侧边栏会话 ${m.sessionId}）进度请用 list_sessions / 打开会话查看`); continue; }
      const st = m.status === 'running' && !alive(m.pid) ? '已中断' : NAMES[m.status] || m.status;
      const evs = fs.existsSync(path.join(agentDir(r, n), 'events.jsonl'))
        ? fs.readFileSync(path.join(agentDir(r, n), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-3).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : [];
      console.log(`- ${n}（${m.agent}）${st}${m.handover ? '，用户在对话窗口接管过' : ''}｜现在：${m.current}`);
      for (const e of evs) console.log(`    ${e.ts.slice(11, 19)} [${e.type}] ${short(String(e.text).replace(/\n/g, ' '), 120)}`);
    }
  }
}

function cmdAgents(a) {
  const agents = listAgents();
  if (a.json) { console.log(JSON.stringify(agents, null, 2)); return; }
  for (const agent of agents) {
    console.log(`${agent.name}（${agent.id}）｜${agent.custom ? '自定义' : '内置'}｜${agent.enabled ? '已开启' : '已关闭'}｜默认模型：${agent.model || '由助手决定'}｜${agent.found ? '已找到程序' : '未找到程序'}`);
    console.log('  ' + agent.role);
    if (agent.custom) console.log('  ' + (agent.capabilities.resume ? '已设置接着对话的参数。' : commandResumeNotice(agent)) + COMMAND_USAGE_NOTICE + '。');
    if (agent.kind === 'desktop') console.log('  ' + (agent.reason || '只有桌面程序，暂无官方命令行，不能无人值守派活。'));
  }
}

function cmdAgentAdd(a) {
  const { _, 'resume-args': resumeArgs, 'session-pattern': sessionPattern, ...def } = a;
  if (_.length !== 1 || !def.id || !def.name || !def.command) {
    throw new Error('用法：node dispatch.mjs agent-add --id <编号> --name <显示名> --command <程序> [--args JSON数组] [--input stdin|arg] [--resume-args JSON数组] [--output text|jsonl]');
  }
  if (sessionPattern !== undefined) def.sessionPattern = sessionPattern;
  if (resumeArgs !== undefined) def.resumeArgs = resumeArgs;
  for (const field of ['args', 'resumeArgs', 'env']) {
    if (Object.hasOwn(def, field)) {
      try { def[field] = JSON.parse(def[field]); }
      catch { throw new Error(`${field} 的 JSON 格式无效，请检查引号和括号。`); }
    }
  }
  if (Object.hasOwn(def, 'enabled')) def.enabled = parseEnabled(def.enabled);
  addCustomAgent(def);
  console.log(`已添加自定义助手「${def.name}」（${def.id}）。`);
}

function cmdAgentRemove({ _, id, ...rest }) {
  if (typeof id !== 'string' || _.length !== 1 || Object.keys(rest).length) {
    throw new Error('用法：node dispatch.mjs agent-remove --id <自定义助手编号>');
  }
  removeCustomAgent(id);
  console.log(`已从名单移除「${id}」，原有任务记录仍可查看。`);
}

function parseEnabled(value) {
  if (!['true', 'false'].includes(value)) throw new Error('--enabled 请填写 true（开启）或 false（关闭）。');
  return value === 'true';
}

function cmdAgentSet(a) {
  const { _, id, ...patch } = a;
  if (typeof id !== 'string' || !Object.keys(patch).length || _.length !== 1) {
    throw new Error('用法：node dispatch.mjs agent-set --id <助手ID> [--enabled true|false] [--role "定位"] [--model "模型"]');
  }
  if (Object.hasOwn(patch, 'enabled')) patch.enabled = parseEnabled(patch.enabled);
  setAgent(id, patch);
  console.log(`已保存「${id}」的助手设置。`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { agents: cmdAgents, 'agent-set': cmdAgentSet, 'agent-add': cmdAgentAdd, 'agent-remove': cmdAgentRemove,
  run: cmdRun, resume: cmdResume, open: cmdOpen, stop: cmdStop,
  mark: cmdMark, fold: cmdFold, step: cmdStep, note: cmdNote, status: cmdStatus, brief: cmdBrief, attach: cmdAttach, ensure: ensureConsole };
try {
  if (!Object.hasOwn(commands, cmd)) throw new Error('命令：' + Object.keys(commands).join(' | ') + '（见 README.md）');
  if (cmd === 'attach' || cmd === 'note') ensureConsole();
  await commands[cmd](args);
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
