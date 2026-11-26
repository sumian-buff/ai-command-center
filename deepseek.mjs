import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dshPaths } from './agents.cjs';

// Mirror the installed dsh.cmd without putting the prompt or paths through cmd.exe.
const DSH_PATCH = fileURLToPath(new URL('./dsh-headless.patch.yml', import.meta.url));

export function deepseekSpec(command, meta, message, resume = false) {
  if (meta.model) {
    throw new Error('DeepSeek 的 headless 命令没有单次选模型参数。请在 DeepSeek Harness 的 headless 设置中选择模型，并清空指挥台里的 DeepSeek 模型。');
  }
  const mode = meta.sandbox ?? 'workspace-write';
  if (!['read-only', 'workspace-write'].includes(mode)) throw new Error('DeepSeek 只支持指挥台的只读和可写工作区两档。');
  if (resume && !meta.convId) throw new Error('没有 DeepSeek 对话编号，无法继续。');

  const { exe, cli } = dshPaths(command);
  // 附加覆盖层：打开 headless 默认关闭的密钥读取组件（见 dsh-headless.patch.yml）
  const args = ['--expose-internals', cli, '--profile', 'headless', '--patch', DSH_PATCH, '--json'];
  if (resume) args.push('--session-id', meta.convId);
  // Harness defines "never" as denying calls that need human approval.
  args.push('--permission-mode', mode, '--approval-policy', 'never');
  for (const dir of meta.addDirs || []) args.push('--add-dir', dir);
  args.push('-');
  return { exe, args, stdin: message, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
}

export function deepseekBlockReason(diagnostic) {
  const s = String(diagnostic || '');
  if (/ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID|\b401\b|unauthenticated|unauthorized|sign[ -]?in required|log[ -]?in required|api[ _-]?key.{0,50}(?:missing|required|not set)|(?:missing|invalid).{0,30}(?:credential|api[ _-]?key)|请.{0,4}登录/i.test(s)) {
    return '请在 DeepSeek Harness 中确认自己的账号已登录，并确认 headless 可以使用该账号。';
  }
  if (/\b(?:EPERM|EACCES|403)\b|permission denied|access (?:is )?denied|FS_SANDBOX_DENIED|APPROVAL_DENIED|AUTO_REVIEW_DENIED|unknown permission preset|拒绝访问|权限不足/i.test(s)) {
    return 'DeepSeek 缺少完成这一步的权限，请检查可访问的目录和 headless 权限预设。';
  }
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH)\b|fetch failed|network (?:error|unreachable)|网络连接失败/i.test(s)) {
    return 'DeepSeek 未能连上服务，请检查网络连接后继续。';
  }
  if (/\b429\b|quota exceeded|insufficient balance|余额不足|额度不足/i.test(s)) {
    return 'DeepSeek 报告额度不足或请求受限，请核对账号额度或稍后继续。';
  }
  return '';
}

const toolLabels = {
  read: '查看文件', read_image: '查看图片', write: '写入文件', edit: '修改文件',
  apply_patch: '修改项目文件', glob: '查找文件', grep: '在文件里搜索', web_search: '网上搜索',
  web_fetch: '读取网页', subagent: '派出子助手', todo: '更新待办清单',
};

// dsh-headless projects committed activity, one JSON object per stdout line.
export function createDeepseekEvents({ emit, raw, setConv, addTokens, checkWrite, checkUrl, describeCommand }) {
  const state = { finalText: '', completed: false, error: '', blocked: '', onEvent };

  function fail(message) {
    state.error = message;
    state.blocked ||= deepseekBlockReason(message);
    if (!state.blocked) emit('error', message);
  }

  function onToolCall(tool, input) {
    let action = toolLabels[tool] || `使用工具：${tool || '未提供名称'}`;
    if (input?.file_path) {
      if (tool === 'write' || tool === 'edit') checkWrite(input.file_path);
      action += '：' + path.basename(input.file_path);
    } else if (tool === 'apply_patch' && typeof input?.input === 'string') {
      for (const match of input.input.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) checkWrite(match[1].trim());
    } else if (input?.url) {
      action += '：' + (checkUrl(input.url) || input.url);
    } else if (input?.command) {
      action = describeCommand(input.command);
    } else if (input?.query || input?.pattern) {
      action += '：' + (input.query || input.pattern);
    }
    emit('act', action);
  }

  function onEvent(ev) {
    raw(JSON.stringify(ev));
    switch (ev.type) {
      case 'session':
        setConv(ev.sessionId);
        emit('act', 'DeepSeek 已开始处理任务');
        break;
      case 'status':
        if (ev.phase === 'step_start') emit('act', 'DeepSeek 正在处理下一步');
        if (ev.phase === 'step_end' && ev.usage) {
          const { totalTokens, inputTokens, outputTokens } = ev.usage;
          const count = totalTokens ?? (inputTokens + outputTokens);
          if (Number.isSafeInteger(count) && count >= 0) addTokens(count);
        }
        break;
      case 'text':
        if (ev.text) emit('say', ev.text);
        break;
      case 'tool_call':
        onToolCall(ev.tool, ev.input);
        break;
      case 'tool_result':
        if (ev.status === 'error') {
          const message = [ev.error?.code, ev.error?.reason, ev.result].filter(Boolean).join(' ');
          state.blocked ||= deepseekBlockReason(message);
          emit('warn', '工具未能完成操作' + (message ? '：' + message.slice(0, 200) : ''));
        }
        break;
      case 'final':
        setConv(ev.sessionId);
        state.finalText = typeof ev.text === 'string' ? ev.text : '';
        state.completed = ev.reason?.kind === 'completed';
        if (!state.completed) {
          const detail = ev.reason?.error;
          fail(detail ? [detail.code, detail.message].filter(Boolean).join(' ') : 'DeepSeek 本轮未完成（' + (ev.reason?.kind || '缺少结束原因') + '）。');
        }
        break;
      case 'error':
        fail(ev.message || 'DeepSeek 报告了错误。');
        break;
    }
  }
  return state;
}
