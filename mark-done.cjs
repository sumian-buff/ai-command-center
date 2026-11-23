const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function replaceJSON(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function validName(value) {
  return typeof value === 'string' && value.trim() && !/[\\/:\0]/.test(value) && !/^[. ]+$/.test(value);
}

function markAgentDone(runsDir, run, name, text = '已由你手动标记为完成') {
  if (!validName(run) || !validName(name)) throw new Error('请提供有效的任务 ID 和助手名字。');
  if (typeof text !== 'string' || !text.trim()) throw new Error('请提供标记为完成的说明。');
  const runDir = path.join(runsDir, run);
  const dir = path.join(runDir, 'agents', name);
  const metaFile = path.join(dir, 'meta.json');
  let meta;
  try { meta = readJSON(metaFile); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`找不到助手「${name}」`);
    throw e;
  }
  if (meta.status === 'running' && (alive(meta.pid) || alive(meta.childPid))) {
    throw new Error(`「${name}」还在运行，请先停止它，再标记为完成。`);
  }

  const ts = new Date().toISOString();
  if (meta.step != null) {
    const planFile = path.join(runDir, 'plan.json');
    const plan = readJSON(planFile);
    const step = Number(meta.step);
    const entry = Array.isArray(plan?.steps) && plan.steps[step - 1];
    if (!Number.isInteger(step) || !entry || typeof entry !== 'object') {
      throw new Error(`计划里没有第 ${meta.step} 步。`);
    }
    if (entry.status !== 'done') {
      entry.status = 'done';
      plan.updatedAt = ts;
      replaceJSON(planFile, plan);
    }
  }
  if (meta.status === 'done') return;
  Object.assign(meta, { status: 'done', current: '完成', endedAt: meta.endedAt || ts, options: [] });
  if (meta.handover) meta.handover = false;
  fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ ts, type: 'done', text }) + '\n');
  replaceJSON(metaFile, meta);
}

module.exports = { markAgentDone, alive };
