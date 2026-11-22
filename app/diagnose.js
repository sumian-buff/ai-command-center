// AI指挥台 · 「看看卡哪了」：检查一个看起来没动静的助手到底在干什么
// 判断依据（都在本机查看，不联网）：
//   1. 它的程序还在不在
//   2. 它启动了哪些子程序，各跑了多久（最常见的卡住：启动了一个停不下来的程序，比如网页预览服务器）
//   3. 最近两秒电脑有没有在为它干活（CPU 用量）
//   4. 它有没有正在和外部服务器通信（在等 AI 回复）
const { execFile } = require('child_process');
const path = require('path');

// 助手自己的程序（按命令行识别），不算「它启动的子程序」
// Codex 自带的运行组件（node_repl、code-mode-host 等）装在 OpenAI\Codex 或 .codex 文件夹下，也算它自己的
const isOwn = (p) => /^(conhost|node_repl|codex-code-mode-host)\.exe$/i.test(p.name)
  || /codex\.js|[\\/]codex(\.exe)?["\s]|codex-command-runner|[\\/]agy\.exe|[\\/]claude\.exe|@openai[\\/]codex|@anthropic-ai[\\/]claude-code|[\\/]OpenAI[\\/]Codex[\\/]|[\\/]\.codex[\\/]|[\\/]agy[\\/]bin[\\/]/i.test(String(p.cmd || '') + ' ');
// 命令行里的完整程序路径只留程序名，方便看
const tidy = (c) => String(c || '')
  .replace(/"[A-Za-z]:\\[^"]*\\([^\\"]+\.exe)"/gi, '$1')   // 带引号、路径里有空格的
  .replace(/\b[A-Za-z]:\\\S*\\([^\\\s"]+\.exe)/gi, '$1');  // 不带引号的

function ps(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err && !out) return resolve(null);
      try { resolve(JSON.parse(String(out).trim() || 'null')); } catch { resolve(null); }
    });
  });
}

// 一次性拿到：进程树（含启动时间、命令行）、两次 CPU 采样、对外连接
function inspect(rootPid) {
  return ps(`
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate
$tree = @(${Number(rootPid)}); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if ($tree -contains $p.ParentProcessId -and -not ($tree -contains $p.ProcessId)) { $tree += $p.ProcessId; $added = $true } } }
$alive = [bool]($all | Where-Object { $_.ProcessId -eq ${Number(rootPid)} })
function CpuSum { $s = 0; foreach ($id in $tree) { $g = Get-Process -Id $id; if ($g) { $s += $g.TotalProcessorTime.TotalMilliseconds } }; $s }
$c1 = CpuSum; Start-Sleep -Milliseconds 2000; $c2 = CpuSum
# 对外连接：直接连到外网的算；连到本机端口、但那个端口不是它自己的组件在用（比如本机的代理程序）的也算
$net = 0; $via = @()
foreach ($c in @(Get-NetTCPConnection -State Established | Where-Object { $tree -contains $_.OwningProcess })) {
  if ($c.RemoteAddress -notmatch '^(127\\.|::1$|0\\.0\\.0\\.0)') { $net++; continue }
  $l = Get-NetTCPConnection -LocalPort $c.RemotePort -State Listen | Select-Object -First 1
  if ($l -and -not ($tree -contains $l.OwningProcess)) { $net++; $n = (Get-Process -Id $l.OwningProcess).ProcessName; if ($n -and -not ($via -contains $n)) { $via += $n } }
}
$procs = foreach ($p in $all) { if ($tree -contains $p.ProcessId -and $p.ProcessId -ne ${Number(rootPid)}) {
  [pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; name = $p.Name; cmd = [string]$p.CommandLine; ageSec = [int]((Get-Date) - $p.CreationDate).TotalSeconds } } }
[pscustomobject]@{ alive = $alive; cpuMs = [math]::Round($c2 - $c1); net = $net; via = @($via); procs = @($procs) } | ConvertTo-Json -Depth 4 -Compress
`);
}

const shortCmd = (c) => { c = String(c || '').replace(/\s+/g, ' ').trim(); return c.length > 90 ? c.slice(0, 90) + '…' : c; };
const mins = (s) => (s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`);

// 根据检查结果，给出大白话结论和建议操作
async function diagnose(meta, lastActivityMs) {
  const quiet = Math.round((Date.now() - lastActivityMs) / 1000);
  if (!meta.childPid) return { verdict: 'gone', title: '找不到它的程序', detail: '记录里没有它的程序编号，可能是很早以前启动的。', actions: ['restart'] };
  const info = await inspect(meta.childPid);
  if (!info) return { verdict: 'unknown', title: '没能检查成功', detail: '读取电脑上的程序信息失败，可以稍后再试。', actions: ['wait'] };
  if (!info.alive) return { verdict: 'gone', title: '它的程序已经退出了', detail: `程序已经不在运行，但没有留下结果（已经 ${mins(quiet)} 没有动静）。`, actions: ['restart'] };

  const procs = (Array.isArray(info.procs) ? info.procs : info.procs ? [info.procs] : []);
  // 它自己启动的、跑了超过 1 分钟的外部命令，最可能是卡住的原因。
  // 只看「最外层」的那个命令（它的上级是助手自己的程序），结束它时连同它启动的程序一起结束
  const own = new Set(procs.filter(isOwn).map((p) => p.pid).concat([meta.childPid]));
  const suspects = procs.filter((p) => !isOwn(p) && p.ageSec >= 60 && own.has(p.ppid)).sort((a, b) => b.ageSec - a.ageSec);
  const cpuPct = Math.round((info.cpuMs / 2000) * 100);

  if (suspects.length) {
    const s = suspects[0];
    // 显示里面真正在跑的那个程序名（比如 powershell 里跑着 node）
    // 一层层往下找到最里面那个真正在跑的程序（比如 PowerShell 里跑着 node server.js）
    let leaf = s;
    for (let i = 0; i < 5; i++) {
      const kid = procs.filter((p) => p.ppid === leaf.pid && !isOwn(p)).sort((a, b) => b.ageSec - a.ageSec)[0];
      if (!kid) break;
      leaf = kid;
    }
    return {
      verdict: 'child', title: `它在等一个没结束的程序：${leaf.name}`,
      detail: `这个程序已经跑了 ${mins(s.ageSec)}，运行的是「${shortCmd(tidy(leaf.cmd))}」。这类程序（比如网页预览服务器、一直在监听的测试）不会自己结束，助手会一直等它。结束它，助手就能接着往下做。`,
      killPid: s.pid, killName: shortCmd(tidy(leaf.cmd)) || leaf.name, actions: ['kill', 'restart', 'wait'],
    };
  }
  if (info.cpuMs > 150) {
    return { verdict: 'busy', title: '它正在本机干活', detail: `最近 2 秒电脑在为它工作（约占一个核心的 ${cpuPct}%），只是暂时没有输出新动态，比如在跑测试或处理文件。建议再等等。`, actions: ['wait'] };
  }
  if (info.net > 0) {
    const via = (Array.isArray(info.via) ? info.via : info.via ? [info.via] : []).filter(Boolean);
    const viaText = via.length ? `（经过本机的 ${via.join('、')} 转发）` : '';
    return {
      verdict: 'thinking', title: '它在等 AI 服务器回复',
      detail: `它和 AI 服务器的连接是通的${viaText}，本机很安静，说明 AI 正在云端思考下一步。思考过程不会实时显示，遇到复杂的改动时，安静 5～10 分钟很常见（已经等了 ${mins(quiet)}）。建议继续等${quiet > 900 ? '；已经超过 15 分钟，如果还想等也可以，实在不放心再重启它' : '，不要重启，否则它要从头再想一遍'}。`,
      actions: quiet > 900 ? ['wait', 'restart'] : ['wait'],
    };
  }
  return { verdict: 'stuck', title: '它可能卡住了', detail: `程序还在，但已经 ${mins(quiet)} 没有动静，电脑没在为它干活，也没有发现它在和 AI 服务器通信。${quiet < 600 ? '如果它刚开始处理比较复杂的改动，也可能只是在思考，可以再等几分钟后重新检查；' : ''}确定卡住的话，可以重启它，让它从中断的地方接着做。`, actions: quiet < 600 ? ['wait', 'restart'] : ['restart', 'wait'] };
}

module.exports = { diagnose };
