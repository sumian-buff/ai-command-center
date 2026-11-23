import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../', import.meta.url))
const redirect = fileURLToPath(new URL('./fixtures/redirect-cli.cjs', import.meta.url))
const parentId = 'a11abe1b-4441-4e75-b024-72d3699796aa'
const subId = '61321a2e-7119-44e2-8af4-6dec8de12a4e'
const name = '主助手'
const prompt = '请检查第一行\n以及带“引号”的第二行。'

function lines(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}
async function until(description, read) {
  const end = Date.now() + 8000
  do {
    const result = read()
    if (result) return result
    await delay(30)
  } while (Date.now() < end)
  assert.fail('等待超时：' + description)
}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

function sandbox(t) {
  // Copy the actual dispatcher with its sibling modules. Its normal runs/ stays isolated,
  // and no Electron executable is present under this root.
  const work = fs.mkdtempSync(path.join(repo, '.agy-test-'))
  const agents = path.join(work, 'runs', 'case', 'agents')
  const home = path.join(work, 'home')
  fs.mkdirSync(home)
  for (const f of fs.readdirSync(repo).filter(f => f.endsWith('.mjs'))) {
    fs.copyFileSync(path.join(repo, f), path.join(work, f))
  }
  fs.writeFileSync(path.join(work, 'prompt.txt'), prompt)
  const wire = () => lines(path.join(work, 'wire.jsonl'))
  const live = new Set()
  t.after(async () => {
    if (live.size) {
      for (const marker of wire()) {
        for (const pid of [marker.grandchild, marker.pid].filter(Boolean)) {
          if (alive(pid)) { try { process.kill(pid) } catch {} }
        }
      }
    }
    for (const child of live) child.kill()
    await Promise.all([...live].map(child => child.finished))
    assert.equal(path.dirname(work), path.resolve(repo))
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  function dispatch(command, args, scenario) {
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, FAKE_SCENARIO: scenario }
    const child = spawn(process.execPath, ['--require', redirect, path.join(work, 'dispatch.mjs'), command,
      '--run', 'case', '--name', name, ...args], { env, cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    for (const pipe of [child.stdout, child.stderr]) {
      pipe.setEncoding('utf8')
      pipe.on('data', data => { output += data })
    }
    live.add(child)
    child.finished = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => { live.delete(child); resolve({ code, output }) })
    })
    return child.finished
  }
  const meta = (agentName = name) => {
    const file = path.join(agents, agentName, 'meta.json')
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
  }
  const sub = () => {
    if (!fs.existsSync(agents)) return undefined
    return fs.readdirSync(agents).map(n => meta(n)).find(m => m?.parent === name)
  }
  return {
    run: (scenario, agent = 'agy', args = []) => dispatch('run', [
      '--agent', agent, '--cwd', work, '--task', '离线测试', '--prompt-file', 'prompt.txt', ...args], scenario),
    resume: (scenario) => dispatch('resume', ['--text', '接着做'], scenario),
    stop: () => dispatch('stop', [], 'stop'),
    meta, sub, wire, work,
    gate: file => fs.writeFileSync(path.join(work, file), ''),
    events: (n = name) => lines(path.join(agents, n, 'events.jsonl')),
    result: () => fs.readFileSync(path.join(agents, name, 'result.md'), 'utf8')
  }
}
async function exitIs(command, expected) {
  const { code, output } = await command
  assert.equal(code, expected, output)
}
function assertStream(message, expectedText, conversation) {
  const { args, input } = message
  const required = ['--mode', 'accept-edits', '--input-format', 'stream-json', '--output-format', 'stream-json']
  if (conversation) required.push('--conversation', conversation)
  // Flags may appear in any order. Each must have the correct adjacent value.
  assert.equal(args.length, required.length)
  for (let i = 0; i < required.length; i += 2) {
    const pos = args.indexOf(required[i])
    assert.notEqual(pos, -1, required[i])
    assert.equal(args[pos + 1], required[i + 1])
  }
  assert.match(input, /^[^\r\n]+\r?\n$/)
  const packet = JSON.parse(input)
  assert.deepEqual(packet, { event: 'user', message: { content: packet.message.content } })
  assert.ok(packet.message.content.includes(expectedText))
}

test('真实片段：创建回执先登记、持续读追加动作、匹配回报后才结束', async t => {
  const h = sandbox(t)
  const done = h.run('normal')
  // The fake has only supplied the creation receipt. No conversation:// link yet.
  const child = await until('从创建回执取得子助手编号', () => {
    const c = h.sub()
    return c?.convId === subId && c
  })
  assert.match(child.name, /^主助手 › 子助手/)
  assert.equal(child.status, 'running')
  assert.equal(h.meta().convId, parentId)
  const acts = () => h.events(child.name).filter(e => e.type === 'act').map(e => e.text)
  await until('记录第一条编辑', () => acts().some(s => s.includes('修改文件') && s.includes('count.txt')))
  h.gate('after-create')
  await until('下一条记录只写了一半', () => h.wire().some(v => v.partial))
  assert.ok(!acts().some(s => s.includes('done.txt')))
  h.gate('rest-of-line')
  await until('第二次追加中的读取和写入都已翻译', () => acts().some(s => s.includes('查看文件') && s.includes('count.txt'))
    && acts().some(s => s.includes('done.txt')))
  assert.equal(acts().filter(s => s.includes('修改文件') && s.includes('count.txt')).length, 1)
  assert.equal(h.meta().status, 'running')
  assert.equal(h.sub().status, 'running')
  h.gate('send-report')
  await until('在 result 之前收到对应子助手回报', () => h.sub()?.status === 'done')
  assert.equal(h.meta().status, 'running')
  h.gate('send-result')
  await exitIs(done, 0)
  assert.equal(h.meta().status, 'done')
  assert.match(h.result(), /已汇报完成/)
  assert.deepEqual(h.wire().filter(v => 'eofAfterResult' in v).map(v => v.eofAfterResult), [true])
  assertStream(h.wire().find(v => v.agent), prompt)
  assert.equal(h.events(name).filter(e => e.type === 'done').length, 1)
})

for (const scenario of ['early-result', 'crash']) {
  test(scenario === 'early-result' ? '成功 result 早于子助手回报，主助手与未回报条目标为被阻碍' : '进程出错时结束正在运行的子助手条目', async t => {
    const h = sandbox(t)
    const done = h.run(scenario)
    await until('子助手开始', () => h.sub()?.status === 'running')
    h.gate('after-create')
    await exitIs(done, 1)
    const status = scenario === 'early-result' ? 'blocked' : 'failed'
    assert.equal(h.meta().status, status)
    assert.equal(h.sub().status, status)
    if (scenario === 'early-result') {
      assert.match(h.result(), /子助手/)
      assert.ok(h.events().some(e => e.type === 'blocked' && e.text.includes('子助手')))
    }
  })
}

test('停止主助手会结束模拟进程和正在运行的子助手', async t => {
  const h = sandbox(t)
  const run = h.run('stop')
  await until('子助手已启动', () => h.sub()?.status === 'running')
  const agyPid = h.meta().childPid
  const grandchild = process.platform === 'win32'
    ? (await until('模拟进程树已启动', () => h.wire().find(v => v.grandchild))).grandchild
    : null
  if (grandchild) assert.equal(alive(grandchild), true)
  await exitIs(h.stop(), 0)
  await exitIs(run, 1)
  assert.equal(h.meta().status, 'stopped')
  assert.equal(h.sub().status, 'stopped')
  assert.equal(alive(agyPid), false)
  if (grandchild) assert.equal(alive(grandchild), false)
})

test('首次启用浏览器与恢复对话：四次连续输入都在 result 后关闭', async t => {
  const h = sandbox(t)
  await exitIs(h.run('simple', 'agy', ['--browser']), 0)
  await exitIs(h.resume('simple'), 0)
  const calls = h.wire().filter(v => v.agent)
  assert.equal(calls.length, 4)
  assertStream(calls[0], '/browser')
  assertStream(calls[1], prompt, parentId)
  assertStream(calls[2], '/browser', parentId)
  assertStream(calls[3], '接着做', parentId)
  assert.deepEqual(h.wire().filter(v => 'eofAfterResult' in v).map(v => v.eofAfterResult), [true, true, true, true])
})

test('agy 退出码为零但 result 报错，仍记为失败', async t => {
  const h = sandbox(t)
  await exitIs(h.run('error-result'), 1)
  assert.equal(h.meta().status, 'failed')
})

for (const agent of ['codex', 'claude']) {
  test(agent + ' 启动和恢复沿用原参数、普通文本输入和用量统计', async t => {
    const h = sandbox(t)
    await exitIs(h.run('simple', agent), 0)
    const conv = h.meta().convId
    await exitIs(h.resume('simple'), 0)
    const [start, resume] = h.wire()
    assert.ok(start.input.includes(prompt))
    assert.ok(resume.input.startsWith('接着做'))
    assert.ok(!start.input.startsWith('{"event":"user"'))
    if (agent === 'codex') {
      assert.deepEqual(start.args.slice(1), ['exec', '--json', '-s', 'workspace-write', '--skip-git-repo-check', '-C', h.work, '-'])
      assert.deepEqual(resume.args.slice(1), ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', conv, '-'])
    } else {
      const flags = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
      assert.deepEqual(start.args, [...flags, '--session-id', conv])
      assert.deepEqual(resume.args, [...flags, '--resume', conv])
    }
    assert.equal(h.meta().status, 'done')
    assert.equal(h.meta().tokens, 22)
    assert.equal(h.sub(), undefined)
    assert.match(h.result(), /测试回复/)
  })
}
