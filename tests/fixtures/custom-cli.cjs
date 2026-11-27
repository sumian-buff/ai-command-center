// A local CLI with no accounts or network dependencies. Record what actually crossed
// the process boundary so the dispatcher tests can check cwd, argv and stdin.
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const [scenario, ...args] = process.argv.slice(2);
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  fs.appendFileSync('received.jsonl', JSON.stringify({
    scenario, args, input, cwd: process.cwd(), locale: process.env.AICC_LOCALE, pid: process.pid,
  }) + '\n');

  switch (scenario) {
    case 'question':
      console.log('对话编号 session-123');
      console.log('开始核对');
      console.log('我在逐项核对两份清单的名称和顺序，接下来会把有差异的部分列出来。'.repeat(4));
      console.log('\n需要你选择：\n1. 检查名称\n2. 检查顺序');
      break;
    case 'jsonl':
      for (const packet of [
        { type: 'status', message: '开始读取清单' },
        { type: 'message', message: { content: [{ type: 'text', text: '正在整理清单中的名称。' }] } },
        { type: 'tool_call', tool: 'web_fetch', input: { url: 'https://outside.example/info' } },
        { type: 'tool_call', tool: 'write', input: { file_path: '../outside.txt' } },
        { unfamiliar: '原样保留' },
      ]) console.log(JSON.stringify(packet));
      console.log('这是混在 JSON 里的普通文本');
      console.log(JSON.stringify({ type: 'final', text: '被阻碍：请登录模拟工具。' }));
      break;
    case 'hold':
      console.log('正在等待停止');
      // The stop test records Windows' taskkill request here. Exit as if it arrived.
      for (let i = 0; i < 400 && !fs.existsSync('taskkill.json'); i++) await delay(25);
      break;
    case 'blocked':
      console.log('正在检查本机登录情况\n\n被阻碍：请在模拟工具里登录后再继续。');
      process.exitCode = 1;
      break;
    case 'failed':
      console.error('启动失败，示例设置文件缺少一行。');
      process.exitCode = 3;
      break;
    case 'writes':
      console.log('修改文件：./inside.txt');
      console.log('修改文件：../项目 资料旧/outside.txt');
      console.log('\n整理完毕。');
      break;
    case 'done':
      console.log('开始整理\n\n清单已整理。\n共核对两项。');
      break;
    default:
      throw new Error('未登记的模拟场景 ' + scenario);
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
} else {
  // Only loaded in the stop dispatcher. The agent itself runs as a normal child.
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const cp = require('node:child_process');
  cp.execFileSync = (command, args) => {
    assert.equal(command, 'taskkill');
    const cwd = process.env.AICC_TEST_TASK;
    const { pid } = JSON.parse(fs.readFileSync(path.join(cwd, 'received.jsonl'), 'utf8').trim());
    assert.deepEqual(args, ['/PID', String(pid), '/T', '/F']);
    fs.writeFileSync(path.join(cwd, 'taskkill.json'), JSON.stringify(args));
  };
  require('node:module').syncBuiltinESMExports();
}
