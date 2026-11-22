// AI指挥台 · 界面（监控墙）
// 视觉设计来自 agy 第二轮方案：普通模式「暖纸工作台」，炫酷模式「静谧舰桥」。
// 每个助手一块固定画面，一屏同时可见；块内记录自己滚动，刷新时只追加新动态，不打断你翻看。
const api = window.console2;
const $ = (sel, el = document) => el.querySelector(sel);

let selected = null;
let followLatest = true;
let currentRun = null;
let chatWith = null;
let notesOpen = false;
const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; } };
const savePref = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch {} };
let cool = pref('cool', false);
let soundOn = pref('sound', true);
const drafts = new Map();
const toasts = new Map();
const tiles = new Map();
const diags = new Map();     // run/name -> 「看看卡哪了」的结果（或 'loading'）
const dismissed = new Map(); // run/name -> 你点了「继续等」时的最后动态时间
const STALE_MS = 300000;     // 运行中超过 5 分钟没有新动态才提示（AI 在云端深度思考时，安静几分钟很常见）

// ---------- 小工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plain = (s) => String(s ?? '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/^#+\s*/gm, '');
const hhmm = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }); };
const hhmmss = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false }); };
function dur(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
  return `${Math.floor(sec / 3600)}小时${Math.floor((sec % 3600) / 60)}分`;
}
function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.round(s)} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ms).toLocaleDateString('zh-CN');
}
const tok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const vendorOf = (a) => (a.agent === 'claude-session' ? 'claude' : a.agent);
const VENDOR = { codex: 'Codex', agy: 'Antigravity', claude: 'Claude' };
const ICONS = {
  codex: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/><line x1="13" y1="5" x2="11" y2="19"/></svg>',
  agy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><circle cx="12" cy="12" r="3.4"/><ellipse cx="12" cy="12" rx="9.5" ry="4.4" transform="rotate(-28 12 12)"/></svg>',
  claude: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
};
// 状态 -> [画面样式, 状态文字, 主角区样式, 主角区标签]
function look(a) {
  if (a.handover && a.status !== 'running') return ['handover', '你接管中', 'h-wait', '你接管中'];
  if (a.status === 'running' && a.warnings > 0) return ['warn', '可能跑偏', 'h-wait', '可能跑偏'];
  return {
    running: ['running', '运行中', 'h-run', '正在做'],
    question: ['question', '等你选择', 'h-wait', '等你选'],
    blocked: ['blocked', '被阻碍', 'h-block', '卡住了'],
    done: ['done', '完成', 'h-done', '已完成'],
    failed: ['failed', '失败', 'h-block', '失败了'],
    stopped: ['stopped', '已停止', '', '已停止'],
    interrupted: ['interrupted', '已中断', 'h-block', '已中断'],
  }[a.status] || [a.status, a.status, '', ''];
}
const needsYou = (a) => a.status === 'blocked' || a.status === 'question';
const lastActivity = (a) => {
  const ev = a.events && a.events.length ? new Date(a.events[a.events.length - 1].ts).getTime() : 0;
  return Math.max(ev || 0, a.rawMtime || 0, new Date(a.startedAt).getTime() || 0);
};

// 活跃度：最近 5 分钟、每 15 秒一格的动作数
function activity(a) {
  const now = Date.now();
  const buckets = new Array(20).fill(0);
  for (const ev of a.events || []) {
    if (ev.type === 'user') continue;
    const age = now - new Date(ev.ts).getTime();
    if (age < 0 || age >= 300000) continue;
    buckets[19 - Math.floor(age / 15000)]++;
  }
  return buckets;
}
function sparkSvg(series, live) {
  const W = 84, H = 20, n = series.length, gap = 1.2;
  const bw = (W - gap * (n - 1)) / n;
  const max = Math.max(4, ...series);
  let bars = '';
  series.forEach((v, i) => {
    const h = v ? Math.max(2.5, (v / max) * H) : 1.2;
    const op = v ? (i === n - 1 && live ? 1 : 0.35 + 0.55 * (i / n)) : 0.25;
    bars += `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="0.8" fill="var(--v-color)" opacity="${op.toFixed(2)}"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

// ---------- 左侧：任务列表和总览 ----------
function runState(r) {
  const st = r.agents || [];
  const wait = st.filter((a) => a.status === 'question' || a.status === 'blocked').length;
  if (wait) return ['attn', `${wait} 项等你`];
  if (st.some((a) => a.status === 'running')) return ['live', '进行中'];
  if (st.length && st.every((a) => a.status === 'done')) return ['done', '已完成'];
  return ['', st.length ? '已停下' : '规划中'];
}
const dotClass = (s) => ({ running: 'd-run', question: 'd-wait', blocked: 'd-block', done: 'd-done' }[s] || '');
// 左侧任务列表交给 sidebar.js：项目分组、拖动排序、置顶、归档、删除
function renderSidebar(runs) { window.consoleSidebar.render(runs); }
function renderSummary(run) {
  const box = $('#summary');
  if (!run || !run.agents.length) { box.innerHTML = ''; return; }
  const n = run.agents.length;
  const running = run.agents.filter((a) => a.status === 'running').length;
  const waiting = run.agents.filter(needsYou).length;
  const done = run.agents.filter((a) => a.status === 'done').length;
  const tokens = run.agents.reduce((s, a) => s + (a.tokens || 0), 0);
  box.innerHTML = `
    <div class="sum-line"><b>${n} 个助手</b>${running ? ` · <span class="r">${running} 个运行中</span>` : ''}${waiting ? ` · <span class="w">${waiting} 个等你</span>` : ''}</div>
    <div class="sum-nums"><span>累计 ${tok(tokens)} token</span><span>${done} 个已完成</span></div>`;
}

// ---------- 顶部：标题、需求、计划进度线、Claude 说明、提醒 ----------
function renderHead(run) {
  const head = $('#head');
  if (!run) { head.innerHTML = ''; return; }
  const plan = run.plan || {};
  const steps = (Array.isArray(plan.steps) ? plan.steps : []).map((s, i) => {
    const owners = run.agents.filter((a) => a.step === i + 1);
    let st = s.status || 'todo';
    if (owners.length) {
      st = owners.some((a) => a.status === 'running') ? 'doing'
        : owners.some((a) => a.status === 'blocked') ? 'blocked'
        : owners.some((a) => a.status === 'question') ? 'waiting'
        : owners.every((a) => a.status === 'done') ? 'done' : 'doing';
    }
    return { ...s, st };
  });
  const STEP = { doing: ['is-run', '进行中'], waiting: ['is-wait', '等你选择'], blocked: ['is-block', '被阻碍'], done: ['is-done', '完成'], todo: ['', '待开始'] };
  const notes = run.notes.slice().reverse();
  const alerts = [];
  for (const a of run.agents) {
    if (a.status === 'question') alerts.push(`<button class="alert-link wait" data-flash="${esc(a.name)}">● ${esc(a.name)} 等你选择</button>`);
    if (a.status === 'blocked' && !a.handover) alerts.push(`<button class="alert-link block" data-flash="${esc(a.name)}">▲ ${esc(a.name)} 被阻碍：${esc(blockedReason(a))}</button>`);
    if (a.status === 'running' && a.warnings > 0) {
      const w = a.events.filter((e) => e.type === 'warn').pop();
      alerts.push(`<button class="alert-link warn" data-flash="${esc(a.name)}">! ${esc(a.name)} 可能跑偏：${esc(w ? w.text : '')}</button>`);
    }
  }
  head.innerHTML = `
    <div class="h1">
      <div class="title-wrap"><h1 class="mission-title">${esc(plan.title || run.id)}</h1>${plan.request ? `<span class="mission-prompt" title="${esc(plan.request)}">「${esc(plan.request)}」</span>` : ''}</div>
      <div class="switches">
        <button class="listen" data-listen="1" title="依次播放三种提示音：完成一项、卡住了、全部完成">试听</button>
        <label class="sw" title="完成、卡住、全部完成时播放提示音"><span>提示音</span><input type="checkbox" id="sound" ${soundOn ? 'checked' : ''}><span class="pill"><span class="knob"></span></span></label>
        <label class="sw" title="每个画面只留一行进展，下面滚动显示它真实在跑的命令和代码"><span>炫酷模式</span><input type="checkbox" id="cool" ${cool ? 'checked' : ''}><span class="pill"><span class="knob"></span></span></label>
      </div>
    </div>
    ${steps.length || notes.length ? `<div class="h2">
      <div class="progress">${steps.map((s, i) => `${i ? '<span class="p-conn"></span>' : ''}<span class="p-step ${STEP[s.st] ? STEP[s.st][0] : ''}" title="${esc(s.text)}"><span class="p-dot"></span><span class="p-text">${i + 1}. ${esc(shortStep(s.text))}</span><span class="p-state">${STEP[s.st] ? STEP[s.st][1] : ''}</span></span>`).join('')}</div>
      ${notes.length ? `<div class="brief"><span class="brief-name">Claude：</span><span class="brief-text" title="${esc(notes[0].text)}">${esc(notes[0].text)}</span>${notes.length > 1 ? `<button class="mini-link" data-notes="1">${notesOpen ? '收起' : `全部 ${notes.length} 条`}</button>` : ''}</div>` : ''}
    </div>` : ''}
    ${notesOpen && notes.length ? `<ul class="notes">${notes.map((n) => `<li><time>${hhmmss(n.ts)}</time>${esc(n.text)}</li>`).join('')}</ul>` : ''}
    ${alerts.length ? `<div class="alerts"><span class="alerts-prefix">待你处理</span>${alerts.join('')}</div>` : ''}`;
}
const shortStep = (t) => { const s = String(t).replace(/^[^：:]{1,12}[：:]\s*/, (m) => m); return s.length > 22 ? s.slice(0, 22) + '…' : s; };
function blockedReason(a) {
  const ev = a.events.slice().reverse().find((e) => e.type === 'blocked');
  const t = plain(ev ? ev.text : a.current).replace(/^被阻碍，需要你处理[:：]?/, '').trim();
  return t.split('\n')[0] || '详情见它的画面';
}

// ---------- 监控墙 ----------
function layoutWall(n) {
  const wall = $('#wall');
  const W = wall.clientWidth;
  let cols;
  if (n <= 1) cols = 1;
  else if (W >= 1500) cols = n <= 3 ? n : n <= 6 ? 3 : 4;
  else if (W >= 900) cols = n <= 2 ? n : n <= 4 ? 2 : 3;
  else cols = 1;
  const rows = Math.ceil(n / cols);
  wall.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  wall.style.gridTemplateRows = `repeat(${rows}, minmax(250px, 1fr))`;
  const list = [...wall.querySelectorAll('.tile')];
  list.forEach((t) => { t.style.gridColumn = ''; });
  const rest = n % cols;
  if (rest && list.length) list[list.length - 1].style.gridColumn = `span ${cols - rest + 1}`;
}

function makeTile(a) {
  const el = document.createElement('section');
  el.dataset.name = a.name;
  el.innerHTML = `
    <span class="scan"></span>
    <header class="t-head">
      <div class="who"><div class="mark"></div><div class="who-text"><div class="name-row"><span class="t-name"></span><span class="t-vendor"></span></div><div class="t-meta"></div></div></div>
      <div class="tele"><div class="activity"><span class="t-spark"></span><span class="t-last"></span></div><span class="chip"><span class="pulse"></span><span class="chip-text"></span></span><span class="t-actions"></span></div>
    </header>
    <div class="now"><span class="now-k"></span><span class="now-text"></span></div>
    <div class="t-task"></div>
    <div class="t-body"><ol class="t-log"></ol><div class="t-term"></div><button class="t-jump" hidden>有新动态 ↓</button></div>
    <div class="t-wait"></div>`;
  Object.assign(el, { _count: 0, _first: null, _sig: '', _rawSize: 0, _rawPrev: '', _queue: [], _stickLog: true, _stickTerm: true, _vendor: '' });
  const log = $('.t-log', el), term = $('.t-term', el), jump = $('.t-jump', el);
  const nearBottom = (box) => box.scrollHeight - box.scrollTop - box.clientHeight < 28;
  log.addEventListener('scroll', () => { if (log.clientHeight) { el._stickLog = nearBottom(log); if (el._stickLog) jump.hidden = true; } });
  term.addEventListener('scroll', () => { if (term.clientHeight) { el._stickTerm = nearBottom(term); if (el._stickTerm) jump.hidden = true; } });
  jump.addEventListener('click', () => {
    if (cool) { term.scrollTop = term.scrollHeight; el._stickTerm = true; } else { log.scrollTop = log.scrollHeight; el._stickLog = true; }
    jump.hidden = true;
  });
  return el;
}

const MARK = { say: '“', act: '·', warn: '!', done: '✓', blocked: '▲', question: '●', error: '×', stopped: '■', user: '›' };
function eventRow(ev, fresh) {
  const li = document.createElement('li');
  li.className = `ev k-${ev.type}${fresh ? ' new' : ''}`;
  if (ev.type === 'say' || ev.type === 'blocked' || ev.type === 'question') li.classList.add('clamp');
  if (ev.detail) li.title = ev.detail;
  const text = ev.type === 'user' ? plain(ev.text).replace(/^你回复：|^你说：/, '你：') : plain(ev.text);
  li.innerHTML = `<time>${hhmm(ev.ts)}</time><i>${MARK[ev.type] || '·'}</i><p>${esc(text)}</p>`;
  return li;
}

// 代码流里的一行：按内容上色
function codeLine(line, fresh) {
  const div = document.createElement('div');
  div.className = 'c-line' + (fresh ? ' new' : '');
  const m = line.match(/^\[(\d\d:\d\d:\d\d)\]\s?([\s\S]*)$/);
  const ts = m ? m[1] : '';
  const rest = m ? m[2] : line;
  let html;
  const who = rest.match(/^(codex|agy|claude|subagent):\s?([\s\S]*)$/);
  if (who) html = `<span class="c-who">${esc(who[1])}:</span> <span class="c-say">${esc(who[2])}</span>`;
  else {
    let cls = '';
    if (/^(PS>|>>|\$ )/.test(rest) || /^(\+\+\+|\*\*\*|---)\s/.test(rest)) cls = 'c-cmd';
    else if (/^\+(?!\+)/.test(rest)) cls = 'c-add';
    else if (/^\/\//.test(rest)) cls = 'c-think';
    else if (/\[exit [1-9]|\berror\b|Error|FAIL|failed|Traceback|denied|拒绝/i.test(rest)) cls = 'c-err';
    else if (/✔|✓|passing|\[exit 0\]|SUCCESS|result\.success|\bDONE\b/.test(rest)) cls = 'c-ok';
    else if (/^<<|^#|^\s*"[\w]+":|turn\.|session\.|thread\.|system\./.test(rest)) cls = 'c-meta';
    else if (/30[12] |Redirect|被阻碍|warn/i.test(rest)) cls = 'c-warn';
    html = cls ? `<span class="${cls}">${esc(rest)}</span>` : esc(rest);
    if (cls === 'c-add' || cls === 'c-err') div.className += ' ' + cls;
  }
  div.innerHTML = (ts ? `<span class="c-ts">[${ts}]</span> ` : '') + html;
  return div;
}

function updateTile(run, a) {
  let el = tiles.get(a.name);
  if (!el) { el = makeTile(a); tiles.set(a.name, el); $('#wall').appendChild(el); }
  const vendor = vendorOf(a);
  const [st, stText, hero, heroK] = look(a);
  el.className = `tile v-${vendor} s-${st}${el.classList.contains('flash') ? ' flash' : ''}`;
  if (el._vendor !== vendor) { $('.mark', el).innerHTML = ICONS[vendor] || ''; el._vendor = vendor; }
  $('.t-name', el).textContent = a.name;
  $('.t-vendor', el).textContent = a.agent === 'claude-session' ? 'Claude 会话' : VENDOR[vendor] || vendor;
  const elapsed = ((a.endedAt ? new Date(a.endedAt) : new Date()) - new Date(a.lastStartedAt || a.startedAt)) / 1000;
  $('.t-meta', el).textContent = `${dur(elapsed)}  ${tok(a.tokens)} token`;
  $('.t-spark', el).innerHTML = sparkSvg(activity(a), a.status === 'running');
  const last = lastActivity(a);
  const lastEl = $('.t-last', el);
  lastEl.textContent = `最后动态：${ago(last)}`;
  const stale = a.status === 'running' && Date.now() - last > STALE_MS;
  lastEl.classList.toggle('stale', stale);
  a._stale = stale && dismissed.get(`${run.id}/${a.name}`) !== last;
  a._quiet = Date.now() - last;
  $('.chip-text', el).textContent = stText;
  const now = $('.now', el);
  now.className = `now ${hero}`;
  $('.now-k', now).textContent = heroK;
  $('.now-text', now).textContent = plain(a.current || '');
  $('.now-text', now).title = plain(a.current || '');
  $('.t-task', el).textContent = a.task ? `任务：${a.task}` : '';

  // 大白话记录：只追加新的
  const log = $('.t-log', el);
  const evs = a.events || [];
  const first = evs[0] ? evs[0].ts + evs[0].text : null;
  if (evs.length < el._count || first !== el._first) { log.innerHTML = ''; el._count = 0; el._first = first; el._stickLog = true; }
  if (evs.length > el._count) {
    const initial = el._count === 0;
    const frag = document.createDocumentFragment();
    for (const ev of evs.slice(el._count)) frag.appendChild(eventRow(ev, !initial));
    log.appendChild(frag);
    el._count = evs.length;
    if (el._stickLog) log.scrollTop = log.scrollHeight;
    else if (!cool) $('.t-jump', el).hidden = false;
  }

  // 代码流：用上次内容的末尾做锚点，找出新增部分，排进打字队列
  const raw = a.raw || '';
  const size = a.rawSize || 0;
  const term = $('.t-term', el);
  if (size < el._rawSize) { term.innerHTML = ''; el._rawPrev = ''; el._queue = []; }
  if (raw && raw !== el._rawPrev) {
    if (!el._rawPrev) {
      const frag = document.createDocumentFragment();
      raw.split('\n').slice(-300).forEach((l) => frag.appendChild(codeLine(l, false)));
      term.appendChild(frag);
      el._stickTerm = true;
    } else {
      const anchor = el._rawPrev.slice(-240);
      const idx = raw.lastIndexOf(anchor);
      const fresh = (idx >= 0 ? raw.slice(idx + anchor.length) : raw).replace(/^\n/, '');
      if (fresh) el._queue.push(...fresh.split('\n'));
    }
    el._rawPrev = raw;
  }
  el._rawSize = size;

  // 底部操作区与标题栏按钮：变化时才重画，正在输入时不动
  const waitSig = JSON.stringify([a.status, a.options, a.handover, a.convId, toasts.get(`${run.id}/${a.name}`), a._stale, diags.get(`${run.id}/${a.name}`), a._stale ? Math.floor(a._quiet / 60000) : 0]);
  const wait = $('.t-wait', el);
  if (waitSig !== el._sig && !wait.contains(document.activeElement)) { wait.innerHTML = renderWait(run, a); el._sig = waitSig; }
  const acts = $('.t-actions', el);
  const actSig = JSON.stringify([a.status, a.agent, a.convId]);
  if (acts._sig !== actSig) { acts.innerHTML = renderActions(a); acts._sig = actSig; }
}

function renderActions(a) {
  const b = [];
  if (a.agent === 'claude-session') b.push(`<button class="mini" data-link="${esc(a.name)}">在 Claude 里打开</button>`);
  else {
    if (a.status === 'running') b.push(`<button class="mini" data-diag="${esc(a.name)}">看看卡哪了</button>`);
    if (a.convId || a.status === 'running') b.push(`<button class="mini" data-chat="${esc(a.name)}">对话</button>`);
    if (a.agent === 'codex' && a.convId && a.status !== 'running') b.push(`<button class="mini" data-open="${esc(a.name)}">在 Codex 里打开</button>`);
    if (a.status === 'running') b.push(`<button class="mini danger" data-stop="${esc(a.name)}">停止</button>`);
  }
  return b.join('');
}

function renderWait(run, a) {
  const key = `${run.id}/${a.name}`;
  const toast = toasts.get(key) ? `<div class="w-toast">${esc(toasts.get(key))}</div>` : '';
  if (a.agent === 'claude-session') {
    if (!needsYou(a)) return toast;
    const opts = a.status === 'question' && a.options ? `<div class="choices">${a.options.map((o, i) => `<div class="w-opt static"><span>${i + 1}.</span>${esc(plain(o))}</div>`).join('')}</div>` : '';
    return `<div class="w-hint ${a.status === 'blocked' ? 'block' : ''}">${a.status === 'question' ? '等你选择，请到 Claude 程序里回复它' : '被阻碍，请到 Claude 程序里看它需要什么'}</div>${opts}${toast}`;
  }
  // 运行中：很久没动静时提示，并显示「看看卡哪了」的诊断结果
  if (a.status === 'running') {
    const d = diags.get(key);
    if (d === 'loading') return `<div class="diag"><div class="d-title">正在检查它在干什么…</div><div class="d-detail">大约需要几秒钟。</div></div>${toast}`;
    if (d) {
      const btn = {
        kill: `<button class="btn warm" data-kill="${esc(a.name)}">结束这个程序，让它接着做</button>`,
        restart: `<button class="btn ${d.actions[0] === 'restart' ? 'warm' : 'dark'}" data-restart="${esc(a.name)}">重启它，接着做</button>`,
        wait: `<button class="btn dark" data-wait="${esc(a.name)}">继续等</button>`,
      };
      return `<div class="diag v-${esc(d.verdict)}"><div class="d-title">${esc(d.title)}</div><div class="d-detail">${esc(d.detail)}</div>
        <div class="w-row">${d.actions.map((x) => btn[x] || '').join('')}</div></div>${toast}`;
    }
    if (a._stale) return `<div class="w-row stale-row"><span class="w-hint">已经 ${Math.floor(a._quiet / 60000)} 分钟没有新动态（AI 深度思考时很常见）</span><button class="btn dark" data-diag="${esc(a.name)}">看看卡哪了</button></div>${toast}`;
    return toast;
  }
  const needAction = needsYou(a) || a.handover || ['stopped', 'failed', 'interrupted'].includes(a.status);
  if (!a.convId || !needAction) return toast;
  const parts = [];
  if (a.handover) parts.push('<div class="w-hint">你在它自己的程序里接管中，处理完后点「让它继续」</div>');
  if (a.status === 'question' && a.options && a.options.length) {
    parts.push(`<div class="choices">${a.options.map((o, i) => `<button class="w-opt" data-choose="${i}" data-name="${esc(a.name)}" data-full="${esc(plain(o))}" title="${esc(plain(o))}"><span>${i + 1}.</span>${esc(plain(o))}</button>`).join('')}</div>`);
  }
  const cont = ['blocked', 'stopped', 'failed', 'interrupted'].includes(a.status) || a.handover;
  parts.push(`<div class="w-row">
    ${cont ? `<button class="btn ${a.status === 'blocked' ? 'warm' : 'dark'}" data-continue="${esc(a.name)}">${a.status === 'blocked' ? '我处理好了，继续' : '让它继续'}</button>` : ''}
    <input class="w-input" data-draft="${esc(key)}" value="${esc(drafts.get(key) || '')}" placeholder="${a.status === 'question' ? '或者直接写你的想法…' : `或直接回复 ${esc(a.name)}…`}">
    <button class="btn dark" data-send="${esc(a.name)}">发送</button>
  </div>`);
  return parts.join('') + toast;
}

function renderWall(run) {
  const wall = $('#wall');
  if (!run) {
    for (const el of tiles.values()) el.remove();
    tiles.clear();
    wall.innerHTML = '<div class="empty"><b>还没有任务</b><span>在 Claude 对话里交代任务，助手开始工作后，这里会自动出现它们的画面。</span></div>';
    wall.style.gridTemplateColumns = ''; wall.style.gridTemplateRows = '';
    return;
  }
  if (!run.agents.length) {
    for (const el of tiles.values()) el.remove();
    tiles.clear();
    wall.innerHTML = '<div class="empty"><b>还没有派出助手</b><span>Claude 正在规划，派出助手后这里会出现它们的画面。</span></div>';
    return;
  }
  const emptyBox = $('.empty', wall);
  if (emptyBox) emptyBox.remove();
  const names = new Set(run.agents.map((a) => a.name));
  for (const [n, el] of tiles) if (!names.has(n)) { el.remove(); tiles.delete(n); }
  run.agents.forEach((a) => updateTile(run, a));
  run.agents.forEach((a) => wall.appendChild(tiles.get(a.name)));
  layoutWall(run.agents.length);
  requestAnimationFrame(() => {
    for (const el of tiles.values()) {
      const l = $('.t-log', el), t = $('.t-term', el);
      if (el._stickLog && l.clientHeight) l.scrollTop = l.scrollHeight;
      if (el._stickTerm && t.clientHeight) t.scrollTop = t.scrollHeight;
    }
  });
}

// 代码流打字机：每帧给每个画面吐出几行
function pump() {
  for (const el of tiles.values()) {
    if (!el._queue.length) continue;
    const term = $('.t-term', el);
    const n = cool ? Math.max(1, Math.ceil(el._queue.length / 40)) : el._queue.length;
    const frag = document.createDocumentFragment();
    el._queue.splice(0, n).forEach((l) => frag.appendChild(codeLine(l, cool)));
    term.appendChild(frag);
    while (term.childElementCount > 500) term.firstElementChild.remove();
    if (el._stickTerm) term.scrollTop = term.scrollHeight;
    else if (cool) $('.t-jump', el).hidden = false;
  }
  requestAnimationFrame(pump);
}

// ---------- 聊天窗口 ----------
function renderChat(run) {
  const box = $('#drawer');
  const a = run && chatWith ? run.agents.find((x) => x.name === chatWith) : null;
  if (!a) { box.innerHTML = ''; box.classList.remove('open'); return; }
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const key = `chat:${run.id}/${a.name}`;
  const old = $('.c-log', box);
  const atBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  const prev = old ? old.scrollTop : 0;
  const items = a.events.map((ev) => {
    const t = esc(plain(ev.text));
    if (ev.type === 'user' && /^(你回复|你说)：/.test(ev.text)) return `<div class="b me"><p>${t.replace(/^你回复：|^你说：/, '')}</p><time>${hhmmss(ev.ts)}</time></div>`;
    if (ev.type === 'say') return `<div class="b it"><p>${t}</p><time>${hhmmss(ev.ts)}</time></div>`;
    if (ev.type === 'act' || ev.type === 'user') return `<div class="c-act">${t}</div>`;
    return `<div class="c-st k-${esc(ev.type)}">${t}</div>`;
  }).join('');
  const running = a.status === 'running';
  const options = a.status === 'question' && a.options ? a.options : [];
  box.classList.add('open');
  box.innerHTML = `
    <div class="c-head"><div><b>${esc(a.name)}</b><span>${esc(VENDOR[vendorOf(a)] || a.agent)} · ${esc(look(a)[1])}</span></div>
      <button class="mini" data-chat-close="1">关闭</button></div>
    <div class="c-log">${items || '<div class="c-act">还没有对话内容</div>'}${running ? '<div class="c-act live">它正在工作…</div>' : ''}</div>
    ${options.length ? `<div class="c-opts">${options.map((o, i) => `<button class="w-opt" data-choose="${i}" data-name="${esc(a.name)}" data-full="${esc(plain(o))}" title="${esc(plain(o))}"><span>${i + 1}.</span>${esc(plain(o))}</button>`).join('')}</div>` : ''}
    <div class="c-input">
      <textarea data-draft="${esc(key)}" ${running ? 'disabled' : ''} placeholder="${running ? '它正在工作，等它停下来再说（或先停止它）' : '跟它说点什么，Ctrl+Enter 发送'}">${esc(drafts.get(key) || '')}</textarea>
      <button class="btn dark" data-send="${esc(a.name)}" ${running ? 'disabled' : ''}>发送</button>
    </div>
    <div class="c-foot">
      ${running ? `<button class="link" data-stop="${esc(a.name)}">停止它</button>` : ''}
      ${!running && a.agent === 'codex' ? `<button class="link" data-open="${esc(a.name)}">在 Codex 桌面版里打开</button>` : ''}
      ${!running && a.agent !== 'codex' ? `<button class="link" data-open="${esc(a.name)}" data-terminal="1">高级：在终端里打开</button>` : ''}
    </div>`;
  const log = $('.c-log', box);
  log.scrollTop = atBottom ? log.scrollHeight : prev;
}

// ---------- 刷新 ----------
let lastSide = '', lastHead = '', busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const runs = await api.listRuns();
    if (followLatest && runs.length) selected = runs[0].id;
    if (selected && !runs.find((r) => r.id === selected)) selected = runs[0] ? runs[0].id : null;
    const run = selected ? await api.getRun(selected) : null;
    if (run && currentRun && run.id !== currentRun.id) { for (const el of tiles.values()) el.remove(); tiles.clear(); }
    currentRun = run;
    renderSidebar(runs); // 自己判断有没有变化，拖动或改名时不会重画
    const headSig = JSON.stringify([run && run.plan, run && run.notes.length, run && run.agents.map((a) => [a.status, a.warnings, a.handover, a.current]), notesOpen, cool, soundOn]);
    if (headSig !== lastHead) { renderHead(run); lastHead = headSig; }
    renderSummary(run);
    renderWall(run);
    renderChat(run);
  } catch (e) {
    $('#wall').innerHTML = `<div class="empty"><b>读取记录出错</b><span>${esc(e.message)}</span></div>`;
  } finally { busy = false; }
}

async function send(name, text) {
  const key = `${selected}/${name}`;
  drafts.delete(key); drafts.delete(`chat:${key}`); toasts.delete(key);
  const el = tiles.get(name); if (el) el._sig = '';
  await api.replyAgent(selected, name, text);
  setTimeout(tick, 700);
}

function applyCool() {
  document.body.classList.toggle('cool', cool);
  $('#brand-sub').textContent = cool ? '静谧舰桥' : '暖纸工作台';
  requestAnimationFrame(() => {
    for (const el of tiles.values()) {
      const t = $('.t-term', el), l = $('.t-log', el);
      if (el._stickTerm) t.scrollTop = t.scrollHeight;
      if (el._stickLog) l.scrollTop = l.scrollHeight;
      $('.t-jump', el).hidden = true;
    }
  });
}

// ---------- 交互 ----------
document.addEventListener('input', (e) => { if (e.target.matches('[data-draft]')) drafts.set(e.target.dataset.draft, e.target.value); });
document.addEventListener('change', (e) => {
  if (e.target.id === 'cool') { cool = e.target.checked; savePref('cool', cool); applyCool(); }
  if (e.target.id === 'sound') { soundOn = e.target.checked; savePref('sound', soundOn); if (soundOn) window.consoleSound.play('done'); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.matches('input.w-input') || (e.ctrlKey && e.target.matches('textarea[data-draft]'))) {
    e.preventDefault();
    const btn = e.target.parentElement.querySelector('[data-send]');
    if (btn) btn.click();
  }
});
document.addEventListener('click', async (e) => {
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t('[data-run]'))) { selected = b.dataset.run; followLatest = false; chatWith = null; lastSide = ''; lastHead = ''; return tick(); }
  if ((b = t('[data-notes]'))) { notesOpen = !notesOpen; lastHead = ''; return tick(); }
  if ((b = t('[data-listen]'))) {
    // 依次试听：完成一项 → 卡住了 → 全部完成
    window.consoleSound.play('done');
    setTimeout(() => window.consoleSound.play('attention'), 1100);
    setTimeout(() => window.consoleSound.play('celebrate'), 2400);
    return;
  }
  if ((b = t('[data-flash]'))) {
    const el = tiles.get(b.dataset.flash);
    if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'nearest' }); setTimeout(() => el.classList.remove('flash'), 1600); }
    return;
  }
  if ((b = t('[data-diag]'))) {
    const key = `${selected}/${b.dataset.diag}`;
    diags.set(key, 'loading'); tick();
    const r = await api.diagnose(selected, b.dataset.diag);
    diags.set(key, r || { verdict: 'unknown', title: '没能检查成功', detail: '可以稍后再试。', actions: ['wait'] });
    return tick();
  }
  if ((b = t('[data-kill]'))) {
    b.disabled = true; b.textContent = '正在结束…';
    const err = await api.killStuck(selected, b.dataset.kill);
    diags.delete(`${selected}/${b.dataset.kill}`);
    err ? toasts.set(`${selected}/${b.dataset.kill}`, err) : toasts.delete(`${selected}/${b.dataset.kill}`);
    return tick();
  }
  if ((b = t('[data-restart]'))) {
    if (!confirm(`重启「${b.dataset.restart}」？\n会先停止它，再让它接着原来的对话继续，之前做好的部分不会丢。`)) return;
    b.disabled = true; b.textContent = '正在重启…';
    await api.restart(selected, b.dataset.restart);
    diags.delete(`${selected}/${b.dataset.restart}`);
    return tick();
  }
  if ((b = t('[data-wait]'))) {
    const key = `${selected}/${b.dataset.wait}`;
    const a = currentRun && currentRun.agents.find((x) => x.name === b.dataset.wait);
    diags.delete(key);
    if (a) dismissed.set(key, lastActivity(a));
    const el = tiles.get(b.dataset.wait); if (el) el._sig = '';
    return tick();
  }
  if ((b = t('[data-chat]'))) { chatWith = b.dataset.chat; return tick(); }
  if (t('[data-chat-close]')) { chatWith = null; return tick(); }
  if ((b = t('[data-link]'))) {
    const err = await api.openLink(selected, b.dataset.link);
    err ? toasts.set(`${selected}/${b.dataset.link}`, err) : toasts.delete(`${selected}/${b.dataset.link}`);
    return tick();
  }
  if ((b = t('[data-stop]'))) {
    if (!confirm(`停止「${b.dataset.stop}」？\n停止后可以回复它、让它继续，或者回到 Claude 对话里重新安排。`)) return;
    b.disabled = true; b.textContent = '停止中…';
    await api.stopAgent(selected, b.dataset.stop);
    return tick();
  }
  if ((b = t('[data-choose]'))) {
    b.disabled = true;
    const text = b.dataset.full || b.textContent.replace(/^\s*\d+\.\s*/, '').trim();
    return send(b.dataset.name, `我选第 ${Number(b.dataset.choose) + 1} 个：${text}`);
  }
  if ((b = t('[data-send]'))) {
    const input = b.parentElement.querySelector('[data-draft]');
    const text = (input && input.value.trim()) || '';
    if (!text) { input && input.focus(); return; }
    if (input) input.blur();
    b.disabled = true; b.textContent = '已发送';
    return send(b.dataset.send, text);
  }
  if ((b = t('[data-continue]'))) {
    b.disabled = true;
    return send(b.dataset.continue, '我已经处理好了（如果我在它自己的程序里和你聊过，以那里说的为准），请从刚才中断的地方继续完成原来的任务。');
  }
  if ((b = t('[data-open]'))) {
    b.disabled = true;
    const err = await api.openAgent(selected, b.dataset.open, !!b.dataset.terminal);
    err ? toasts.set(`${selected}/${b.dataset.open}`, err) : toasts.delete(`${selected}/${b.dataset.open}`);
    b.disabled = false;
    return tick();
  }
  if ((b = t('.ev.clamp'))) b.classList.toggle('open');
});
window.addEventListener('resize', () => { if (currentRun) layoutWall(currentRun.agents.length); });

// 提示音：由主程序检测所有任务的变化后通知过来
if (api.onSound) api.onSound((name) => { if (soundOn) window.consoleSound.play(name); });

applyCool();
window.consoleSidebar.init({ refresh: () => tick(), selected: () => selected }).then(() => {
  tick();
  setInterval(tick, 1200);
});
requestAnimationFrame(pump);
