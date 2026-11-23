// agy 的标准输出给出步骤编号，主对话的 transcript 提供该步骤里完整的子助手编号和回报。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const validId = new RegExp(`^${uuid}$`, 'i');
const senderLine = new RegExp(`^\\[Message\\][^\\n]*?\\bsender=(${uuid})(?=\\s|$)`, 'im');
const now = () => new Date().toISOString();
const transcriptFile = (brain, id) => path.join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl');

function creationIds(content) {
  if (typeof content !== 'string') return [];
  const marker = content.match(/Created the following subagents?\s*:/i);
  if (!marker) return [];
  // 仅匹配创建结果，不能把其他工具读到的文件内容当作新的对话。
  return [...content.slice(marker.index + marker[0].length)
    .matchAll(new RegExp(`"conversationId"\\s*:\\s*"(${uuid})"`, 'gi'))].map(m => m[1].toLowerCase());
}

// 只读追加的字节。等换行后再解码，允许写入方把中文字符和 JSON 行拆成多次追加。
class TranscriptTail {
  constructor(file, offset = 0) {
    this.file = file;
    this.offset = this.completeOffset = offset;
    this.fragments = [];
  }

  read(onLine) {
    let fd;
    try { fd = fs.openSync(this.file, 'r'); }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = this.completeOffset = 0;
        this.fragments = [];
      }
      if (size === this.offset) return false;
      while (this.offset < size) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - this.offset));
        const n = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
        if (!n) break;
        const bytes = buffer.subarray(0, n);
        let start = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          this.fragments.push(bytes.subarray(start, end));
          const line = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          start = end + 1;
          this.completeOffset = this.offset + start;
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          if (row) onLine(row);
        }
        if (start < n) this.fragments.push(bytes.subarray(start));
        this.offset += n;
      }
      return true;
    } finally { fs.closeSync(fd); }
  }
}

function childMetas(dir) {
  const parent = path.basename(dir);
  const agents = path.dirname(dir);
  const children = [];
  for (const entry of fs.readdirSync(agents, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(parent + ' › ')) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(agents, entry.name, 'meta.json'), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) continue; throw e; }
    if (meta.parent === parent && meta.agent === 'agy') children.push(meta);
  }
  return children;
}

function appendEvent(dir, type, text) {
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts: now(), type, text }) + '\n');
}

const endLabels = {
  done: '已向主助手回报', stopped: '已随主助手停止', blocked: '被阻碍，子助手尚未回报', failed: '主助手出错，子助手已中断',
};

function endChild(dir, meta, status, reason, writeJSON) {
  if (meta.status !== 'running') return;
  Object.assign(meta, { status, current: reason || endLabels[status], endedAt: now() });
  appendEvent(dir, status === 'failed' ? 'error' : status, meta.current);
  writeJSON(path.join(dir, 'meta.json'), meta);
}

export function stopAgyChildren(dir, writeJSON) {
  for (const child of childMetas(dir)) {
    endChild(path.join(path.dirname(dir), child.name), child, 'stopped', null, writeJSON);
  }
}

export function createAgyChildren({ dir, meta, describeTool, writeJSON, cleanText,
  brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain') }) {
  const agents = path.dirname(dir);
  const previous = childMetas(dir);
  const children = [];
  const launches = new Map(); // 实时看到的派出步骤，每一步可能同时派多人
  const systemSteps = new Set();
  const sentSteps = new Set();
  const createsOnDisk = new Map();
  const reportsOnDisk = new Map();
  let parentTail;
  let nextNumber = previous.length + 1;
  const stopped = () => fs.existsSync(path.join(dir, 'stop.flag'));
  const persist = c => writeJSON(path.join(c.dir, 'meta.json'), c.meta);
  const isChildId = id => typeof id === 'string' && validId.test(id) && id.toLowerCase() !== meta.convId?.toLowerCase();

  // 记录文件有时会被写入方短暂占用。保留读取位置，下次从原处继续，主进程仍可收尾或被停止。
  function readRows(tail, entryDir, onRow) {
    try {
      const result = tail.read(onRow);
      tail.readError = null;
      return result;
    } catch (e) {
      if (!e.code) throw e;
      if (tail.readError !== e.code) {
        appendEvent(entryDir, 'warn', `暂时读不到对话记录（${e.code}），稍后重试`);
        tail.readError = e.code;
      }
      return false;
    }
  }

  function register(descriptor = {}) {
    const browser = descriptor.type_name === 'browser' || descriptor.TypeName === 'browser';
    const label = browser ? '浏览器子助手' : '子助手';
    let name, number;
    do {
      number = nextNumber++;
      name = `${meta.name} › ${label}${number === 1 ? '' : ' ' + number}`;
    } while (fs.existsSync(path.join(agents, name)));
    const child = {
      name, parent: meta.name, parentConvId: meta.convId, agent: 'agy', convId: null,
      task: descriptor.role || descriptor.Role || '', cwd: meta.cwd, pid: meta.pid,
      startedAt: now(), endedAt: null, status: 'running', current: '已派出，等待子助手记录',
    };
    const c = { dir: path.join(agents, name), meta: child };
    fs.mkdirSync(c.dir);
    appendEvent(c.dir, 'act', child.current);
    persist(c);
    children.push(c);
    return c;
  }

  function bind(c, id) {
    if (!isChildId(id)) return;
    id = id.toLowerCase();
    if (c.meta.convId || children.some(other => other.meta.convId === id)) return;
    c.meta.convId = id;
    c.tail = new TranscriptTail(transcriptFile(brainDir, id));
    persist(c);
  }

  function unbound() {
    return children.filter(c => !c.meta.convId && c.meta.status === 'running');
  }

  function receive(id, index) {
    if (!isChildId(id)) return false;
    const c = children.find(c => c.meta.convId === id.toLowerCase());
    if (!c) return false;
    // 迟到的旧回报，不能结束 send_message 刚刚交代的新工作。
    if (!(index < c.lastSentStep) && c.meta.status === 'running') {
      readChild(c);
      endChild(c.dir, c.meta, 'done', null, writeJSON);
    }
    return true;
  }

  function matchIds(slots, ids) {
    for (const [index, id] of ids.entries()) {
      const c = slots[index] || (slots[index] = register());
      bind(c, id);
    }
  }

  function childTool(s) {
    const key = s.step_index;
    const info = s.subagent_info || {};
    const params = s.tool_info?.parameters || {};
    const listed = info.subagents || params.subagents;
    const descriptors = Array.isArray(listed) && listed.length ? listed.map(d => d || {}) : [params];
    let slots = launches.get(key);
    if (!slots) {
      slots = descriptors.map(d => register(s.tool_name === 'browser_subagent' || s.step_type === 'browser_subagent'
        ? { ...d, type_name: 'browser' } : d));
      launches.set(key, slots);
    }
    descriptors.forEach((d, i) => {
      if (slots[i]) bind(slots[i], d.conversation_id || d.conversationId);
    });
    matchIds(slots, creationIds(s.tool_info?.output));
    if (s.state && !['ACTIVE', 'DONE'].includes(s.state)) {
      for (const c of slots) endChild(c.dir, c.meta, 'failed', '派出子助手失败', writeJSON);
    }
  }

  function sendTo(id, step) {
    if (!isChildId(id)) return;
    id = id.toLowerCase();
    let c = children.find(c => c.meta.convId === id);
    if (!c) {
      const old = previous.find(m => m.convId === id && m.parentConvId === meta.convId);
      if (old) {
        c = { dir: path.join(agents, old.name), meta: old, tail: new TranscriptTail(transcriptFile(brainDir, id), old.transcriptOffset) };
        children.push(c);
      } else {
        c = unbound().length === 1 ? unbound()[0] : register();
        bind(c, id);
      }
    }
    c.lastSentStep = step;
    Object.assign(c.meta, { status: 'running', endedAt: null, pid: meta.pid, current: '收到主助手的新指令' });
    appendEvent(c.dir, 'act', c.meta.current);
    persist(c);
  }

  function handleStep(s, responseText) {
    if (stopped()) return;
    if (s.step_type === 'agent_response' && responseText && unbound().length) {
      for (const m of responseText.matchAll(new RegExp(`(?:\\[([^\\]]+)\\]\\()?conversation://(${uuid})`, 'gi'))) {
        const candidates = unbound();
        const c = candidates.find(c => m[1] && c.meta.task === m[1]) || (candidates.length === 1 && candidates[0]);
        if (c) bind(c, m[2]);
      }
    } else if (s.tool_name === 'send_message') {
      const id = s.tool_info?.parameters?.Recipient;
      if (isChildId(id) && !sentSteps.has(s.step_index)) {
        sentSteps.add(s.step_index);
        sendTo(id, s.step_index);
      }
    } else if (['invoke_subagent', 'browser_subagent'].includes(s.tool_name) || s.step_type === 'browser_subagent') {
      childTool(s);
    } else if (s.step_type === 'system_message' && s.state === 'DONE') {
      systemSteps.add(s.step_index);
      const sender = senderLine.exec(s.text_delta || s.content || '')?.[1];
      if (sender) reportsOnDisk.set(s.step_index, sender);
    }
    if (s.step_type !== 'agent_response') poll();
  }

  function readParent() {
    if (!validId.test(meta.convId || '') || (!launches.size && !systemSteps.size)) return;
    parentTail ||= new TranscriptTail(transcriptFile(brainDir, meta.convId));
    readRows(parentTail, dir, row => {
      if (row.type === 'GENERIC') {
        const ids = creationIds(row.content);
        if (ids.length) createsOnDisk.set(row.step_index, ids);
      }
      if (row.type === 'SYSTEM_MESSAGE') {
        const sender = senderLine.exec(row.content)?.[1];
        if (sender) reportsOnDisk.set(row.step_index, sender);
      }
    });
    for (const [index, slots] of launches) {
      if (createsOnDisk.has(index)) {
        matchIds(slots, createsOnDisk.get(index));
        createsOnDisk.delete(index);
      }
    }
    for (const index of systemSteps) {
      if (reportsOnDisk.has(index) && receive(reportsOnDisk.get(index), index)) {
        systemSteps.delete(index);
      }
    }
  }

  function readChild(c) {
    if (!c.tail) return;
    const emit = (type, text) => {
      text = cleanText(text);
      if (!text) return;
      appendEvent(c.dir, type, text);
      if (type === 'warn') c.meta.warnings = (c.meta.warnings || 0) + 1;
      if (c.meta.status === 'running' && ['act', 'say'].includes(type)) c.meta.current = text.split('\n')[0].slice(0, 80);
    };
    const updated = readRows(c.tail, c.dir, row => {
      const calls = Array.isArray(row.tool_calls) ? row.tool_calls.filter(t => t?.name) : [];
      // 子助手里的 send_message 是向主助手回报，不是再派活给别的子助手。
      for (const tool of calls) {
        emit('act', tool.name === 'send_message' ? '向主助手回报' : describeTool(tool.name, tool.args || {}, emit));
      }
      if (row.type === 'PLANNER_RESPONSE' && row.content) emit('say', row.content);
      if (row.status === 'ERROR' || row.status === 'FAILED') emit('error', '子助手的一步操作失败了');
      const raw = calls.length ? JSON.stringify(calls) : String(row.content || row.type || '');
      fs.appendFileSync(path.join(c.dir, 'raw.log'), `[${row.created_at || now()}] ${raw.slice(0, 6000)}\n`);
    });
    if (updated) {
      c.meta.lastActivityAt = now();
      c.meta.transcriptOffset = c.tail.completeOffset;
      persist(c);
    }
  }

  function poll() {
    if (stopped()) return;
    readParent();
    for (const c of children) if (c.meta.status === 'running') readChild(c);
  }

  function finish(status, reason) {
    poll();
    for (const c of children) {
      if (stopped()) {
        // stop 命令也可能已写完，不能重复记一遍停止事件。
        const saved = JSON.parse(fs.readFileSync(path.join(c.dir, 'meta.json'), 'utf8'));
        if (saved.status === 'stopped') continue;
        endChild(c.dir, c.meta, 'stopped', null, writeJSON);
      } else {
        endChild(c.dir, c.meta, status, reason, writeJSON);
      }
    }
  }
  return { handleStep, poll, finish, runningNames: () => children.filter(c => c.meta.status === 'running').map(c => c.meta.name) };
}
