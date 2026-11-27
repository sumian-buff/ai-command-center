import fs from 'node:fs';
import path from 'node:path';

// npm 的标准启动器和只转发一条命令的脚本可以直接启动真正的程序。
// 只识别完整的转发脚本，以免跳过其他批处理脚本里的初始化操作。
const npmHeader = '@echo off\ngoto start\n:find_dp0\nset dp0=%~dp0\nexit /b\n:start\nsetlocal\ncall :find_dp0\n';
const npmNode = 'if exist "%dp0%\\node.exe" (\nset "_prog=%dp0%\\node.exe"\n) else (\nset "_prog=node"\nset pathext=%pathext:;.js;=;%\n)\n';
const npmInvoke = 'endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%"';

function unwrapBatch(command) {
  const dir = path.dirname(command);
  const script = fs.readFileSync(command, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map(line => line.trim()).filter(Boolean).join('\n');
  let line = script.replace(/^@echo off\n/i, '');
  if (script.toLowerCase().startsWith(npmHeader)) {
    line = script.slice(npmHeader.length);
    if (line.toLowerCase().startsWith(npmNode + npmInvoke)) {
      line = 'node ' + line.slice(npmNode.length + npmInvoke.length).trimStart();
    }
  }
  // A plain forwarding command has just an executable, an optional script, and %*.
  const match = /^@?(?:"([^"\n]+)"|([^"\s]+))(?:\s+(?:"([^"\n]+)"|([^"\s]+)))?[ \t]+%\*$/i.exec(line);
  if (!match || line.includes('\n')) return null;
  function resolveTarget(token) {
    const relative = token.match(/^%(?:~dp0|dp0%)[\\/]?(.*)$/i);
    const target = relative ? path.join(dir, relative[1]) : token;
    return path.isAbsolute(target) && !/[%!]/.test(relative ? relative[1] : token) ? target : null;
  }
  const tool = match[1] || match[2];
  const scriptArg = match[3] || match[4];
  if (scriptArg) {
    const entry = resolveTarget(scriptArg);
    if (!entry) return null;
    if (/^node(?:\.exe)?$/i.test(tool)) {
      const bundled = path.join(dir, 'node.exe');
      const useBundled = script.toLowerCase().startsWith(npmHeader + npmNode) && fs.existsSync(bundled);
      return { exe: useBundled ? bundled : process.execPath, prefix: [entry] };
    }
    const exe = resolveTarget(tool);
    if (exe && path.basename(exe).toLowerCase() === 'node.exe') return { exe, prefix: [entry] };
    return null;
  }
  const exe = resolveTarget(tool);
  return exe && /\.exe$/i.test(exe) ? { exe, prefix: [] } : null;
}

function batchSpec(command, args, stdin, env) {
  const target = unwrapBatch(command);
  if (target) return { exe: target.exe, args: [...target.prefix, ...args], env, stdin };

  // A batch file may expand its arguments a second time with %*. Only place plain
  // arguments in that command line. Pass free-form task text through stdin.
  if (args.some(value => /[\x00-\x08\x0a-\x1f%&|<>^!()]/.test(value) || (value.match(/"/g) || []).length % 2 !== 0)) {
    throw new Error('这个批处理脚本会重新解释多行文字或特殊符号。请改用标准输入（stdin）传任务，或把程序路径填为官方的 .exe 或 Node 入口文件。');
  }
  const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const invocation = ['"%AICC_COMMAND_BATCH%"', ...args.map(quote)].join(' ');
  return {
    exe: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', '"' + invocation + '"'], windowsVerbatimArguments: true,
    env: { ...env, AICC_COMMAND_BATCH: command }, stdin,
  };
}

export function commandSpec(agent, meta, message, resume = false) {
  const template = resume ? agent.resumeArgs : agent.args;
  let usedPrompt = false;
  const args = (template || []).map(arg => arg.replace(/\{prompt\}|\{session\}/g, placeholder => {
    if (placeholder === '{session}' && resume) return meta.convId;
    if (placeholder === '{prompt}' && agent.input === 'arg') {
      usedPrompt = true;
      return message;
    }
    return placeholder;
  }));
  if (agent.input === 'arg' && !usedPrompt) args.push(message);
  const stdin = agent.input === 'arg' ? undefined : message;
  const env = { ...process.env, ...agent.env };
  const exe = agent.resolvedCommand;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) return batchSpec(exe, args, stdin, env);
  if (/\.[cm]?js$/i.test(exe)) return { exe: process.execPath, args: [exe, ...args], stdin, env };
  return { exe, args, stdin, env };
}

function messageText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(messageText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return messageText(value.text ?? value.content ?? value.message ?? value.result);
  }
  return '';
}

// stdout is line-oriented in both modes. Raw lines stay available even when
// a CLI interleaves JSON with ordinary messages or introduces a new event type.
export function createCommandEvents(agent, { emit, raw, setConv, checkWrite, checkUrl }) {
  const pattern = agent.sessionPattern ? new RegExp(agent.sessionPattern) : null;
  let paragraph = [];
  let afterBlank = false;
  let explicitFinal = '';
  const state = { get finalText() { return explicitFinal || paragraph.join('\n'); }, error: '', onLine };

  function remember(text) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) { afterBlank = true; continue; }
      if (/^\s*(?:被阻碍|需要你选择)[:：]/.test(line)) {
        paragraph = [];
      } else if (afterBlank) {
        const heading = paragraph[0]?.trim() || '';
        const option = /^\s*(?:[-*]\s*)?\d+[.、)）]/.test(line);
        if ((/^需要你选择[:：]/.test(heading) && option) ||
            (paragraph.length === 1 && /^被阻碍[:：]$/.test(heading))) paragraph.push('');
        else paragraph = [];
      }
      paragraph.push(line);
      afterBlank = false;
    }
  }

  function checkText(text) {
    if (/(?:访问|浏览|打开|抓取|读取网页|\b(?:visit\w*|fetch\w*|open\w*|brows\w*|download\w*|curl|wget)\b)/i.test(text)) {
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>，。；）)]+/gi)) checkUrl(match[0]);
    }
    const write = text.match(/^\s*(?:(?:正在|已经|已)?(?:写入|修改|新建|删除|编辑)(?:了)?(?:文件)?|(?:wrote|write|writing|edit(?:ed|ing)?|creat(?:e|ed|ing)|delet(?:e|ed|ing)|modif(?:y|ied|ying)|updat(?:e|ed|ing))(?: file)?)(?:\s*[:：]\s*|\s+)(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/i);
    if (write) checkWrite(write[1] || write[2] || write[3]);
  }

  function onLine(line) {
    raw(line);
    if (!line.trim()) { remember(''); return; }
    const match = pattern?.exec(line);
    if (match) setConv(match.groups?.session || match[1] || match[0]);
    let event;
    if (agent.output === 'jsonl') {
      try { event = JSON.parse(line); } catch { /* A non-JSON line is itself a progress message. */ }
    }
    const type = typeof event?.type === 'string' ? event.type.toLowerCase() : '';
    const session = event?.session_id ?? event?.sessionId ?? event?.thread_id ?? event?.threadId ??
      event?.conversation_id ?? (type === 'session' ? event?.id : null);
    if (!pattern && typeof session === 'string' && session) setConv(session);
    const tool = [event?.tool?.name, event?.tool, event?.name, type].find(value => typeof value === 'string');
    const input = event?.input ?? event?.arguments ?? event;
    const message = messageText(event);
    let text = message;
    if (typeof input?.url === 'string') {
      checkUrl(input.url);
      text ||= '访问网站：' + input.url;
    }
    if (/(?:write|edit|delete|create|patch|file_change)/i.test(tool)) {
      const file = input?.file_path ?? input?.path ?? input?.file;
      if (typeof file === 'string') {
        checkWrite(file);
        text ||= '改动文件：' + file;
      }
    }
    text ||= line;
    // A session pattern may target the decoded message instead of JSON's escaped representation.
    if (pattern && !match && text !== line) {
      const decoded = pattern.exec(text);
      if (decoded) setConv(decoded.groups?.session || decoded[1] || decoded[0]);
    }
    checkText(text);
    let level = text.length > 60 ? 'say' : 'act';
    if (/^(?:message|assistant|text|content|final|result)$/.test(type)) level = 'say';
    if (type === 'warn' || type === 'warning') level = 'warn';
    if (type === 'error') {
      state.error = text;
      level = 'error';
    }
    emit(level, text);
    if (event && !message && (session || type === 'session')) return;
    if ((type === 'result' || type === 'final') && message) {
      explicitFinal = message;
    } else if (!explicitFinal) {
      if (event) afterBlank = true; // Each JSON message is a distinct paragraph.
      remember(text);
    }
  }
  return state;
}
