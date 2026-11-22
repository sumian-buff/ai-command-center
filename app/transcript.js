// 读取 Claude 程序侧边栏会话的对话记录（~/.claude/projects/<目录>/<会话>.jsonl），翻译成指挥台的大白话事件。
// 会话是 Claude 程序自己在跑，指挥台不启动它，只读它实时写在硬盘上的记录。
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const cache = new Map(); // 记录文件 -> { size, mtime, result }

const short = (s, n = 60) => (s.length > n ? s.slice(0, n) + '…' : s);
const cleanUserText = (t) => String(t || '')
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '')
  .trim();

// Claude 把工作目录转成记录文件夹名：非字母数字的字符都换成「-」
const slug = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

const TOOLS = {
  Read: '查看文件', Write: '写入文件', Edit: '修改文件', MultiEdit: '修改文件', NotebookEdit: '修改笔记本',
  Glob: '查找文件', Grep: '在文件里搜索内容', Bash: '运行命令', PowerShell: '运行命令',
  WebSearch: '网上搜索', WebFetch: '读取网页', Task: '派出子助手', Agent: '派出子助手', TodoWrite: '更新待办清单',
  AskUserQuestion: '向你提问',
};
function describeTool(name, inp, siteName) {
  inp = inp || {};
  if (/^mcp__claude-in-chrome__|^mcp__Claude_Browser__/.test(name)) {
    if (inp.url) return `在浏览器打开：${siteName(inp.url)}`;
    return '在浏览器里操作';
  }
  if (/^mcp__computer-use__/.test(name)) return '操作电脑屏幕';
  if (/^mcp__ccd_turn__|^mcp__ccd_/.test(name)) return null; // 程序内部的整理动作，不显示
  let text = TOOLS[name] || `使用工具：${name.replace(/^mcp__[^_]+__/, '')}`;
  if (inp.url) text += `：${siteName(inp.url)}`;
  else if (inp.query) text += `：${inp.query}`;
  else if (inp.file_path || inp.notebook_path) text += `：${path.basename(String(inp.file_path || inp.notebook_path))}`;
  else if (inp.description) text += `：${short(String(inp.description), 40)}`;
  return text;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url); } }

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

// 找到这个会话的记录文件：在对应目录里，找启动时间之后、开头含有指挥台编号的那个
function findTranscript(meta) {
  if (meta.transcript && fs.existsSync(meta.transcript)) return meta.transcript;
  const dir = path.join(PROJECTS, slug(meta.cwd));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f)); } catch { return null; }
  const since = new Date(meta.startedAt).getTime() - 60000;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < since) continue;
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(Math.min(st.size, 400000));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      // 只认「第一条用户消息」里带指挥台编号的文件（总指挥自己的记录里也会出现这个编号，不能认错）
      for (const line of buf.toString('utf8').split('\n')) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'user' && o.message && !o.isSidechain) {
          const c = o.message.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '';
          if (text.includes(meta.marker)) return f;
          break;
        }
      }
    } catch {}
  }
  return null;
}

// 把记录翻译成事件，并推算状态
function readSession(meta) {
  const file = findTranscript(meta);
  if (!file) return { events: [{ ts: meta.startedAt, type: 'act', text: '等待 Claude 程序开始这个会话…' }], status: 'running', current: '等待会话开始', transcript: null };
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.result;

  const events = [];
  const raw = []; // 炫酷模式用的原始记录
  const clip = (s, n = 4000) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + `\n… (省略 ${s.length - n} 字)` : s; };
  let lastTs = meta.startedAt;
  let lastKind = '';     // 最后一条有意义的记录：assistant-text / assistant-tool / user-text / tool-result
  let lastText = '';
  let tokens = 0;
  let first = true;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || lastTs;
    const hm = String(ts).slice(11, 19);
    // 原始记录：包括子助手的过程
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text') raw.push(`[${hm}] ${o.isSidechain ? 'subagent' : 'claude'}: ${clip(c.text, 1500)}`);
        else if (c.type === 'thinking' && c.thinking) raw.push('// ' + clip(c.thinking, 1500).replace(/\n/g, '\n// '));
        else if (c.type === 'tool_use') {
          const inp = c.input || {};
          const body = inp.content || inp.new_string || inp.command || '';
          raw.push(`[${hm}] >> ${c.name} ${inp.file_path || inp.url || inp.query || inp.pattern || ''}${body ? '\n' + clip(body) : ''}`);
        }
      }
    } else if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      for (const c of o.message.content) if (c.type === 'tool_result') raw.push('<< ' + clip(typeof c.content === 'string' ? c.content : JSON.stringify(c.content), 2500));
    }
    if (o.isSidechain) continue; // 子助手内部过程不逐条显示在大白话记录里
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      if (o.message.usage) tokens += (o.message.usage.output_tokens || 0);
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) { events.push({ ts, type: 'say', text: c.text.trim() }); lastKind = 'assistant-text'; lastText = c.text.trim(); lastTs = ts; }
        else if (c.type === 'tool_use') {
          const t = describeTool(c.name, c.input, (u) => hostOf(u));
          if (t) events.push({ ts, type: 'act', text: t });
          lastKind = 'assistant-tool'; lastTs = ts;
        }
      }
    } else if (o.type === 'user' && o.message) {
      const content = o.message.content;
      if (typeof content === 'string') {
        const t = cleanUserText(content);
        if (first) { first = false; events.push({ ts, type: 'act', text: '接到任务（完整说明在 Claude 程序的会话里）' }); }
        else if (t) events.push({ ts, type: 'user', text: `你说：${short(t, 300)}` });
        lastKind = 'user-text'; lastTs = ts;
      } else if (Array.isArray(content) && content.some((c) => c.type === 'tool_result')) {
        lastKind = 'tool-result'; lastTs = ts;
      }
    }
  }

  // 推算状态：最后是它的文字回复、且安静了一会儿 = 这一轮说完了，在等你
  const quietMs = Date.now() - st.mtimeMs;
  let status = 'running';
  let options = [];
  if (lastKind === 'assistant-text' && quietMs > 8000) {
    if (/被阻碍[:：]/.test(lastText)) status = 'blocked';
    else if ((options = parseChoices(lastText)).length) status = 'question';
    else status = 'done';
  }
  if (status === 'running' && quietMs > 15 * 60000) status = 'interrupted';
  const current = { running: short((events.filter((e) => e.type === 'act' || e.type === 'say').pop() || {}).text || '工作中', 80), blocked: '被阻碍，需要你处理', question: '等你做选择', done: '这一轮完成了', interrupted: '很久没有动静' }[status];
  if (status === 'blocked') events.push({ ts: lastTs, type: 'blocked', text: '被阻碍，需要你处理：' + short(lastText.replace(/^[\s\S]*?被阻碍[:：]/, '').trim(), 160) });
  if (status === 'question') events.push({ ts: lastTs, type: 'question', text: '等你做选择：' + options.map((x, i) => `${i + 1}. ${x}`).join('；') });
  if (status === 'done') events.push({ ts: lastTs, type: 'done', text: '这一轮完成了' });

  let rawText = raw.join('\n');
  const rawSize = Buffer.byteLength(rawText);
  if (rawText.length > 48000) rawText = rawText.slice(-48000);
  const result = { events: events.slice(-300), status, options, current, tokens, transcript: file, result: lastText, endedAt: status === 'running' ? null : lastTs, raw: rawText, rawSize };
  cache.set(file, { size: st.size, mtime: st.mtimeMs, result });
  return result;
}

module.exports = { readSession };
