// 收起用完的卡片：多轮打磨时，旧一轮的卡片会一直留在监控墙上。
// 规则：已结束的卡片，如果同一任务里之后又派出了新助手（新的一轮开始了），就自动收起。
// 用户也可以手动收起（hidden: true）或者把自动收起的放回来（hidden: false）。
// 进行中、被阻碍、等你选择的卡片永远不收起，免得漏掉需要处理的事。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FOLDABLE = new Set(['done', 'stopped', 'failed', 'interrupted']);

function endTime(a) {
  const t = Date.parse(a.endedAt || '');
  if (t) return t;
  const ev = (a.events || []).slice().reverse().find((e) => e && e.ts);
  return ev ? Date.parse(ev.ts) || 0 : 0;
}

// 返回应当收起的主助手名字。agents：同一个任务的所有助手（含 status / startedAt / endedAt / hidden）
function foldedNames(agents) {
  const tops = agents.filter((a) => !a.parent);
  const starts = tops.map((a) => [a.name, Math.max(Date.parse(a.startedAt || '') || 0, Date.parse(a.lastStartedAt || '') || 0)]);
  const out = new Set();
  for (const a of tops) {
    if (!FOLDABLE.has(a.status)) continue; // 需要处理的、还在跑的，一律不收
    if (a.hidden === true) { out.add(a.name); continue; }
    if (a.hidden === false) continue; // 用户放回来过
    const end = endTime(a);
    if (end && starts.some(([n, s]) => n !== a.name && s > end)) out.add(a.name);
  }
  return out;
}

function setFolded(runsDir, run, name, hidden) {
  if (!/^[^\\/:\0]+$/.test(String(run)) || !/^[^\\/:\0]+$/.test(String(name))) throw new Error('任务或助手名字不对');
  const file = path.join(runsDir, run, 'agents', name, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (hidden && !FOLDABLE.has(meta.status)) throw new Error(`「${name}」还没结束，不能收起`);
  meta.hidden = !!hidden;
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

module.exports = { foldedNames, setFolded, FOLDABLE };
