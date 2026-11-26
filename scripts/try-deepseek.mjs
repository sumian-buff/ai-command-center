// Run with try-deepseek.ps1 outside the Codex sandbox. Sends one harmless prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listAgents } from '../agents.cjs';
import { deepseekSpec, deepseekBlockReason } from '../deepseek.mjs';

const answer = 'AICC-DSH-OK';
const fixture = fileURLToPath(new URL('../tests/fixtures/deepseek-headless.jsonl', import.meta.url));

export function checkPermissions(dump) {
  // --dump-config prints the composed rows as block YAML. Inspect the permission
  // plugin's literal mode mappings only. The dump itself can contain private data.
  const row = dump.split(/^(?=- )/m).find(entry => /^\s*name:\s*['"]?@deepseek-ai\/dsh-permission-presets['"]?\s*$/m.test(entry));
  if (!row || /^  disabled:\s*(?!false\s*$)\S+/m.test(row)) throw new Error('headless 没有启用可核实的权限预设。');
  const presets = row.match(/^    presets:\s*\n((?: {6}[^\n]*\n?)+)/m)?.[1] || '';
  for (const mode of ['read-only', 'workspace-write']) {
    const block = presets.match(new RegExp('^      ' + mode + ': *\\n((?: {8}[^\\n]*\\n?)+)', 'm'))?.[1] || '';
    if (!new RegExp('^        sandbox: ' + mode + ' *$', 'm').test(block)) {
      throw new Error('无法核实 headless 的 ' + mode + ' 预设，请检查 DeepSeek Harness 的权限配置。');
    }
  }
}

export function safeSample(events, cwd) {
  const first = events[0], last = events.at(-1);
  if (first?.type !== 'session' || !first.sessionId || last?.sessionId !== first.sessionId ||
      last.type !== 'final' || last.reason?.kind !== 'completed' || last.text?.trim() !== answer) {
    const failure = events.find(e => e.type === 'error')?.message || last?.reason?.error?.message;
    throw new Error(deepseekBlockReason(failure) || '未收到同一会话的预期测试回复和完成事件。');
  }
  if (path.resolve(first.cwd).toLowerCase() !== path.resolve(cwd).toLowerCase()) throw new Error('DeepSeek 工作目录与空白测试目录不一致。');
  if (events.some(e => ['tool_call', 'tool_result'].includes(e.type))) throw new Error('测试期间收到了工具调用，已停止采样。');
  // Keep only known fields. Do not write account data, paths or free-form
  // reasoning to the repository. Counts and observed event order remain real.
  const sessionId = 'session-00000000-0000-4000-8000-000000000000';
  return events.map(e => {
    if (e.type === 'session') return { type: e.type, sessionId, cwd: '<测试目录>' };
    if (e.type === 'final') return { type: e.type, sessionId, reason: { kind: 'completed' }, text: e.text };
    if (e.type === 'thinking') return { type: e.type, text: '<已省略推理文字>' };
    if (e.type === 'text' && typeof e.text === 'string' && answer.includes(e.text.trim())) return { type: e.type, text: e.text };
    if (e.type !== 'status' || !['turn_start', 'step_start', 'step_end', 'turn_end'].includes(e.phase)) {
      throw new Error('测试收到预期以外的事件或文字，请核对 Harness 版本。');
    }
    const item = { type: e.type, phase: e.phase };
    for (const key of ['turn', 'step']) if (Number.isSafeInteger(e[key])) item[key] = e[key];
    if (e.reason?.kind === 'completed') item.reason = { kind: 'completed' };
    if (e.usage) {
      item.usage = {};
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
        if (Number.isSafeInteger(e.usage[key])) item.usage[key] = e.usage[key];
      }
    }
    return item;
  });
}

export function smoke(cwd, { agent = listAgents().find(a => a.id === 'deepseek'), launch = spawnSync, destination = fixture, log = console.log } = {}) {
  if (!agent?.enabled || !agent.found || agent.kind !== 'dsh') throw new Error('请先开启 DeepSeek，并确认名单里的 Harness 程序可以找到。');
  const spec = deepseekSpec(agent.resolvedCommand, { sandbox: 'read-only', model: agent.model }, '请只回复 AICC-DSH-OK。不要使用任何工具，不要读取或修改任何文件。');
  const cli = (...args) => {
    const proc = launch(spec.exe, args, { cwd, env: spec.env, input: args.at(-1) === '-' ? spec.stdin : '', encoding: 'utf8',
      windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    if (proc.error || proc.status !== 0) {
      const detail = deepseekBlockReason([proc.error?.message, proc.stderr].join(' '));
      throw new Error(detail || 'DeepSeek Harness 未能执行' + (args.includes('--help') ? '帮助检查' : args.includes('--dump-config') ? '配置检查' : '只读测试') + '（' + (proc.error?.code || proc.status || proc.signal) + '），请检查 headless 启动和登录状态。');
    }
    return proc.stdout.replace(/\r\n/g, '\n');
  };
  const profile = spec.args.slice(0, spec.args.indexOf('--json'));
  const help = cli(...profile, '--help');
  for (const flag of ['--json', '--session-id', '--permission-mode', '--approval-policy', '--add-dir']) {
    if (!help.includes(flag)) throw new Error('当前 headless 帮助缺少 ' + flag + '，请核对安装版本。');
  }
  checkPermissions(cli(...profile, '--dump-config'));
  log('已核实只读和可写工作区两档权限。正在发送一条只读测试文字。');
  const events = cli(...spec.args).trim().split('\n').map(line => JSON.parse(line));
  const sample = safeSample(events, cwd).map(e => JSON.stringify(e)).join('\n') + '\n';
  const tmp = destination + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, sample, { flag: 'wx' });
    fs.renameSync(tmp, destination);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  log('收到了 ' + answer + '，会话已完成。脱敏后的真实事件已保存至 ' + destination);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aicc-dsh-'));
  try {
    smoke(cwd);
  } catch (error) {
    console.error('被阻碍：' + (error instanceof SyntaxError ? 'DeepSeek 输出不是预期的逐行 JSON，请核对版本。' : error.message));
    process.exitCode = 1;
  } finally {
    // Only remove our empty directory. Leave unexpected contents for inspection.
    try { fs.rmdirSync(cwd); } catch { console.error('测试工作目录已保留：' + cwd); }
  }
}
