import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { foldedNames, setFolded } from '../fold.cjs'

const t = (min) => new Date(Date.UTC(2026, 10, 23, 5, min)).toISOString()

test('新一轮开始后，上一轮已完成的卡片自动收起，最新的一张留着', () => {
  const agents = [
    { name: '调研', status: 'done', startedAt: t(0), endedAt: t(10) },
    { name: '大框架', status: 'done', startedAt: t(11), endedAt: t(20) },
    { name: '第二轮', status: 'running', startedAt: t(30) },
  ]
  assert.deepEqual([...foldedNames(agents)].sort(), ['大框架', '调研'].sort())
})

test('并行的几张卡片里，先做完的不收起，等下一轮开始才收', () => {
  const agents = [
    { name: 'A', status: 'done', startedAt: t(0), endedAt: t(5) },
    { name: 'B', status: 'running', startedAt: t(0) },
  ]
  assert.equal(foldedNames(agents).size, 0)
})

test('需要你处理的卡片永远不收，手动放回的也不收', () => {
  const agents = [
    { name: '卡住', status: 'blocked', startedAt: t(0), endedAt: t(5), hidden: true },
    { name: '等选择', status: 'question', startedAt: t(0), endedAt: t(5) },
    { name: '放回', status: 'done', startedAt: t(0), endedAt: t(5), hidden: false },
    { name: '新', status: 'running', startedAt: t(30) },
  ]
  assert.equal(foldedNames(agents).size, 0)
})

test('手动收起只对已结束的卡片生效；旧卡片接着干活后自动回来', () => {
  const agents = [
    { name: '手动', status: 'done', startedAt: t(0), endedAt: t(5), hidden: true },
    { name: '旧卡续做', status: 'done', startedAt: t(0), lastStartedAt: t(40), endedAt: t(50) },
    { name: '中间', status: 'done', startedAt: t(20), endedAt: t(30) },
  ]
  assert.deepEqual([...foldedNames(agents)].sort(), ['中间', '手动'].sort())
})

test('子助手不单独计算，跟着主助手走', () => {
  const agents = [
    { name: '主', status: 'done', startedAt: t(0), endedAt: t(5) },
    { name: '主 › 浏览器', parent: '主', status: 'done', startedAt: t(10), endedAt: t(12) },
  ]
  assert.equal(foldedNames(agents).size, 0)
})

test('setFolded 写入 meta.json，进行中的卡片拒绝收起', () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-'))
  const dir = path.join(runs, 'r1', 'agents', 'X')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'meta.json')
  fs.writeFileSync(file, JSON.stringify({ name: 'X', status: 'running' }))
  assert.throws(() => setFolded(runs, 'r1', 'X', true), /还没结束/)
  fs.writeFileSync(file, JSON.stringify({ name: 'X', status: 'done' }))
  setFolded(runs, 'r1', 'X', true)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hidden, true)
  setFolded(runs, 'r1', 'X', false)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hidden, false)
  assert.throws(() => setFolded(runs, '../x', 'X', true))
  fs.rmSync(runs, { recursive: true, force: true })
})
