const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const assert = require('node:assert/strict')

const [agent, ...args] = process.argv.slice(2)
const work = process.cwd()
const scenario = process.env.FAKE_SCENARIO
const parentId = 'a11abe1b-4441-4e75-b024-72d3699796aa'
const subId = '61321a2e-7119-44e2-8af4-6dec8de12a4e'
const journal = (entry) => fs.appendFileSync(path.join(work, 'wire.jsonl'), JSON.stringify({ pid: process.pid, ...entry }) + '\n')
const send = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'agy', name), 'utf8').trimEnd().split(/\r?\n/)
const transcript = (id) => {
  const dir = path.join(process.env.USERPROFILE, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'transcript_full.jsonl')
}
const append = (id, line) => fs.appendFileSync(transcript(id), line + '\n')
const gate = async (name) => {
  while (!fs.existsSync(path.join(work, name))) await delay(25)
}

// exp.log contains step summaries (the original script logged at most 80 text characters
// per delta). Restore the stream envelope and keep the original step order and boundaries.
const steps = fixture('exp-steps.txt').map((line) => {
  const [, index, type, tool, state, delta] = line.match(/EV step#(\d+) (\w+) (\w*) (ACTIVE|DONE) ?(.*)$/)
  return { conversation_id: parentId, step_index: Number(index), step_type: type, tool_name: tool, state, text_delta: delta }
})
function sendSteps(index) {
  for (const step of steps.filter(s => s.step_index === index)) {
    send({ event: 'step_update', step_update: step })
  }
}

let resultSent = false
function agyResult(status, response) {
  resultSent = true
  send({ event: 'result', result: { conversation_id: parentId, status, response } })
}
async function agyTurn(content) {
  send({ event: 'init', conversation_id: parentId })
  if (content === '/browser' || scenario === 'simple') return agyResult('SUCCESS', '收到。')
  if (scenario === 'error-result') return agyResult('ERROR', '执行失败')
  const [created, dispatchReply, report, finalReply] = fixture('main.jsonl')
  const [first, next, final] = fixture('sub.jsonl')
  sendSteps(0)
  sendSteps(1)
  append(parentId, created)
  sendSteps(2)
  append(subId, first)

  if (scenario === 'stop' && process.platform === 'win32') {
    const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore', windowsHide: true })
    journal({ grandchild: grandchild.pid })
  }
  await gate('after-create')
  if (scenario === 'early-result') return agyResult('SUCCESS', '已派工。')
  if (scenario === 'crash') process.exit(7)
  append(parentId, dispatchReply)
  sendSteps(3)

  // Split a UTF-8 character inside a JSON line across two physical writes.
  const bytes = Buffer.from(next + '\n')
  const split = bytes.indexOf(Buffer.from('子助手完成')) + 1
  assert.ok(split > 0)
  fs.appendFileSync(transcript(subId), bytes.subarray(0, split))
  journal({ partial: true })
  await gate('rest-of-line')
  fs.appendFileSync(transcript(subId), bytes.subarray(split))
  await gate('send-report')

  append(subId, final)
  append(parentId, report)
  sendSteps(4)
  append(parentId, finalReply)
  sendSteps(5)
  await gate('send-result')
  agyResult('SUCCESS', JSON.parse(finalReply).content)
}

function otherTurn(input) {
  journal({ agent, args, input })
  if (agent === 'codex') {
    send({ type: 'thread.started', thread_id: parentId })
    send({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex 测试回复' } })
    send({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 2 } })
  } else {
    const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]
    send({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'Claude 测试回复' }] } })
    send({ type: 'result', result: 'Claude 测试回复', usage: { input_tokens: 9, output_tokens: 2 } })
  }
}

setTimeout(() => process.exit(40), 25000).unref()
let input = ''
let received = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  if (agent !== 'agy' || !input.includes('\n')) return
  assert.equal(received, false)
  received = true
  const { message } = JSON.parse(input)
  journal({ agent, args, input })
  agyTurn(message.content).catch(err => { console.error(err); process.exit(41) })
})
process.stdin.on('end', () => {
  if (agent !== 'agy') return otherTurn(input)
  journal({ eofAfterResult: resultSent })
  if (!resultSent) process.exit(42)
})
