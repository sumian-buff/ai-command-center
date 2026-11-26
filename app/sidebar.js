// AI指挥台 · 左侧任务列表：项目分组、拖动排序、置顶、归档、删除
// 整理结果存在 runs/_layout.json。删除只是把指挥台里的任务记录移到回收站，不碰项目文件。
//
// 拖动规则：
//   拖到某一行的上半部 / 下半部        → 放到它前面 / 后面
//   拖到一个任务的正中间                → 两个任务组成一个新项目
//   拖到项目标题上                      → 加入这个项目
//   把项目里的任务拖到项目外面          → 脱离项目
(function () {
  const api = window.console2;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let layout = null;      // { nodes: [...], manual: {}, archivedOpen: false }
  let runsById = {};
  let lastSig = '';
  let dragging = null;    // { kind: 'r'|'p', id }
  let renaming = null;    // 正在改名的项目 id
  let notice = '';
  let hooks = { select: () => {}, refresh: () => {}, selected: () => null };

  const ICON = {
    pin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/></svg>',
    archive: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/></svg>',
    trash: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    out: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
    folder: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h7l2 2h9v11H3z"/></svg>',
  };

  // ---------- 整理数据 ----------
  const projects = () => layout.nodes.filter((n) => n.type === 'project');
  const findTop = (type, id) => layout.nodes.findIndex((n) => n.type === type && n.id === id);
  const parentOf = (runId) => projects().find((p) => p.runs.includes(runId));
  const save = () => { api.setLayout(layout); lastSig = ''; };

  function reconcile(runs) {
    if (!layout || !Array.isArray(layout.nodes)) layout = { nodes: [], manual: {}, archivedOpen: false };
    layout.manual = layout.manual || {};
    const ids = new Set(runs.map((r) => r.id));
    let changed = false;
    // 清掉已经不存在的任务、空项目
    const before = JSON.stringify(layout.nodes);
    layout.nodes = layout.nodes.filter((n) => n.type !== 'run' || ids.has(n.id));
    projects().forEach((p) => { p.runs = p.runs.filter((id) => ids.has(id)); });
    layout.nodes = layout.nodes.filter((n) => n.type !== 'project' || n.runs.length);
    if (JSON.stringify(layout.nodes) !== before) changed = true;
    // 新出现的任务：同一个项目的自动归组，其他放到最上面
    const known = new Set(layout.nodes.filter((n) => n.type === 'run').map((n) => n.id));
    projects().forEach((p) => p.runs.forEach((id) => known.add(id)));
    const fresh = runs.filter((r) => !known.has(r.id)).sort((a, b) => a.updated - b.updated);
    for (const r of fresh) {
      changed = true;
      if (r.projectKey) {
        const p = projects().find((x) => x.key === r.projectKey);
        if (p) { p.runs.unshift(r.id); continue; }
        const mateIdx = layout.nodes.findIndex((n) => n.type === 'run' && !layout.manual[n.id] && runsById[n.id] && runsById[n.id].projectKey === r.projectKey);
        if (mateIdx >= 0) {
          const mate = layout.nodes[mateIdx];
          layout.nodes.splice(mateIdx, 1, { type: 'project', id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), name: r.projectName || '新项目', key: r.projectKey, runs: [r.id, mate.id], pinned: !!mate.pinned, archived: !!mate.archived, collapsed: false });
          continue;
        }
      }
      layout.nodes.unshift({ type: 'run', id: r.id, pinned: false, archived: false });
    }
    if (changed) save();
  }

  // ---------- 状态汇总 ----------
  function stateOf(runIds) {
    const agents = runIds.flatMap((id) => (runsById[id] ? runsById[id].agents || [] : []));
    const wait = agents.filter((a) => a.status === 'question' || a.status === 'blocked').length;
    if (wait) return ['attn', `${wait} 项等你`];
    if (agents.some((a) => a.status === 'running')) return ['live', '进行中'];
    if (agents.length && agents.every((a) => a.status === 'done')) return ['done', '已完成'];
    return ['', agents.length ? '已停下' : '规划中'];
  }
  const dotClass = (s) => ({ running: 'd-run', question: 'd-wait', blocked: 'd-block', done: 'd-done' }[s] || '');
  const STATUS_TEXT = { running: '运行中', question: '等你选择', blocked: '被阻碍', done: '已完成', failed: '失败', stopped: '已停止', interrupted: '已中断' };
  function dotItem(a) {
    const stCls = dotClass(a.status);
    const v = window.consoleVendor ? window.consoleVendor.resolve(a) : null;
    if (v && v.hasIdentity && v.styleVars) {
      const tip = [v.name, STATUS_TEXT[a.status] || a.status].filter(Boolean).join(' · ');
      return `<i class="has-v ${stCls}" style="${esc(v.styleVars)}"${tip ? ` title="${esc(tip)}"` : ''}></i>`;
    }
    return `<i class="${stCls}"></i>`;
  }
  const dots = (runIds) => runIds.flatMap((id) => (runsById[id] ? runsById[id].agents : [])).slice(0, 8).map(dotItem).join('');

  // ---------- 画出来 ----------
  function actions(kind, id, node) {
    const b = [];
    if (kind === 'child') {
      b.push(`<button class="s-act" data-sact="out" data-id="${esc(id)}" title="移出项目">${ICON.out}</button>`);
    } else {
      b.push(`<button class="s-act ${node.pinned ? 'on' : ''}" data-sact="pin" data-kind="${kind}" data-id="${esc(id)}" title="${node.pinned ? '取消置顶' : '置顶'}">${ICON.pin}</button>`);
      b.push(`<button class="s-act ${node.archived ? 'on' : ''}" data-sact="archive" data-kind="${kind}" data-id="${esc(id)}" title="${node.archived ? '取消归档' : '归档'}">${ICON.archive}</button>`);
    }
    b.push(`<button class="s-act danger" data-sact="delete" data-kind="${kind === 'child' ? 'r' : kind}" data-id="${esc(id)}" title="删除（移到回收站）">${ICON.trash}</button>`);
    return `<span class="s-acts">${b.join('')}</span>`;
  }

  function runRow(id, node, child, projectName) {
    const r = runsById[id];
    if (!r) return '';
    const [cls, text] = stateOf([id]);
    const sel = hooks.selected() === id;
    // 在项目里时，去掉标题开头重复的项目名（「串串小铺：分享图放大」→「分享图放大」）
    let title = r.title;
    if (child && projectName && title.startsWith(projectName)) title = title.slice(projectName.length).replace(/^\s*[：:·\-—]\s*/, '') || r.title;
    return `<div class="run ${sel ? 'on' : ''} ${child ? 'child' : ''}" data-run="${esc(id)}" draggable="true" data-drag="r:${esc(id)}" data-zone="${child ? 'child' : 'run'}" title="${esc(r.title)}">
      <div class="run-top"><span class="run-title">${esc(title)}</span>${actions(child ? 'child' : 'r', id, node || {})}</div>
      <div class="run-sub"><span class="run-state ${cls}">${text}</span><span class="dots">${dots([id])}</span></div>
    </div>`;
  }

  function projectBlock(p) {
    const [cls, text] = stateOf(p.runs);
    const hasSel = p.runs.includes(hooks.selected());
    const name = renaming === p.id
      ? `<input class="p-rename" data-rename="${esc(p.id)}" value="${esc(p.name)}">`
      : `<span class="p-name" title="双击改名">${esc(p.name)}</span>`;
    return `<div class="proj ${hasSel ? 'has-sel' : ''}">
      <div class="p-head" data-phead="${esc(p.id)}" draggable="true" data-drag="p:${esc(p.id)}" data-zone="project">
        <span class="p-caret">${p.collapsed ? '▸' : '▾'}</span><span class="p-icon">${ICON.folder}</span>${name}
        <span class="p-count">${p.runs.length}</span>${actions('p', p.id, p)}
      </div>
      <div class="p-sub"><span class="run-state ${cls}">${text}</span><span class="dots">${dots(p.runs)}</span></div>
      ${p.collapsed ? '' : `<div class="p-runs">${p.runs.map((id) => runRow(id, null, true, p.name)).join('')}</div>`}
    </div>`;
  }

  const nodeHtml = (n) => (n.type === 'project' ? projectBlock(n) : runRow(n.id, n, false));

  function render(runs, force) {
    runsById = {};
    runs.forEach((r) => { runsById[r.id] = r; });
    reconcile(runs);
    const sig = JSON.stringify([layout, runs.map((r) => [r.id, r.title, r.agents]), hooks.selected(), notice]);
    if (!force && (sig === lastSig || dragging || renaming)) return;
    lastSig = sig;
    const pinned = layout.nodes.filter((n) => n.pinned && !n.archived);
    const normal = layout.nodes.filter((n) => !n.pinned && !n.archived);
    const archived = layout.nodes.filter((n) => n.archived);
    const total = runs.length;
    $('#run-count').textContent = `${total} 项`;
    $('#runs').innerHTML = `
      ${notice ? `<div class="s-notice">${esc(notice)}</div>` : ''}
      ${pinned.length ? `<div class="s-sec" data-section="pinned"><div class="s-sec-title">置顶</div>${pinned.map(nodeHtml).join('')}</div>` : ''}
      <div class="s-sec" data-section="normal">${pinned.length ? '<div class="s-sec-title">全部</div>' : ''}${normal.map(nodeHtml).join('') || (total ? '<div class="side-empty">没有其他任务</div>' : '<div class="side-empty">暂无任务</div>')}</div>
      ${archived.length ? `<div class="s-sec arch" data-section="archived"><button class="s-sec-title toggle" data-archtoggle="1">${layout.archivedOpen ? '▾' : '▸'} 已归档 ${archived.length}</button>${layout.archivedOpen ? archived.map(nodeHtml).join('') : ''}</div>` : ''}`;
  }

  // ---------- 操作 ----------
  function topNode(kind, id) { const i = findTop(kind === 'p' ? 'project' : 'run', id); return i >= 0 ? layout.nodes[i] : null; }

  async function doDelete(kind, id) {
    let ids, label;
    if (kind === 'p') {
      const p = topNode('p', id); if (!p) return;
      ids = p.runs.slice(); label = `项目「${p.name}」和其中 ${ids.length} 个任务的记录`;
    } else {
      ids = [id]; label = `任务「${(runsById[id] || {}).title || id}」的记录`;
    }
    if (ids.some((x) => runsById[x] && runsById[x].running)) { notice = '有助手还在运行，运行中的任务不能删除'; return hooks.refresh(); }
    if (!confirm(`删除${label}？\n\n只删除指挥台里的工作记录，不会动你的项目文件。\n会移到 Windows 回收站，误删了可以从回收站找回。`)) return;
    const blocked = await api.trashRuns(ids);
    notice = blocked && blocked.length ? `有 ${blocked.length} 个任务没删掉（可能正在运行）` : '';
    if (kind === 'p' && !(blocked && blocked.length)) layout.nodes.splice(findTop('project', id), 1);
    save();
    hooks.refresh();
  }

  function detachRun(id) {
    const i = findTop('run', id);
    if (i >= 0) return layout.nodes.splice(i, 1)[0];
    const p = parentOf(id);
    if (p) {
      p.runs.splice(p.runs.indexOf(id), 1);
      if (!p.runs.length) layout.nodes.splice(findTop('project', p.id), 1);
      return { type: 'run', id, pinned: !!p.pinned, archived: !!p.archived };
    }
    return { type: 'run', id, pinned: false, archived: false };
  }

  // 拖放：根据放下的位置决定是前、后、合并还是加入项目
  function dropOn(target, clientY) {
    if (!dragging) return;
    const zone = target.dataset.zone;
    const rect = target.getBoundingClientRect();
    const y = (clientY - rect.top) / rect.height;
    const [tKind, tId] = target.dataset.drag.split(/:(.+)/);
    if (dragging.kind + ':' + dragging.id === target.dataset.drag) return;

    if (dragging.kind === 'p') {
      // 项目只能在顶层前后移动
      const tTopId = tKind === 'p' ? tId : (parentOf(tId) ? parentOf(tId).id : tId);
      const tTopType = tKind === 'p' || parentOf(tId) ? 'project' : 'run';
      const from = findTop('project', dragging.id); if (from < 0) return;
      const moving = layout.nodes.splice(from, 1)[0];
      const to = findTop(tTopType, tTopId); if (to < 0) { layout.nodes.splice(from, 0, moving); return; }
      const ref = layout.nodes[to];
      moving.pinned = !!ref.pinned; moving.archived = !!ref.archived;
      layout.nodes.splice(y < 0.5 ? to : to + 1, 0, moving);
      return save();
    }

    // 拖的是任务
    const runId = dragging.id;
    if (zone === 'project') {
      const p = topNode('p', tId); if (!p || p.runs.includes(runId)) return;
      if (y < 0.3) {                                   // 放到项目前面（顶层）
        const node = detachRun(runId); layout.manual[runId] = true;
        node.pinned = !!p.pinned; node.archived = !!p.archived;
        layout.nodes.splice(findTop('project', p.id), 0, node);
      } else {                                         // 加入项目
        detachRun(runId); layout.manual[runId] = true;
        const p2 = topNode('p', tId); if (p2) { p2.runs.push(runId); p2.collapsed = false; }
      }
      return save();
    }
    if (zone === 'child') {                            // 放进项目里的某个位置
      const p = parentOf(tId); if (!p) return;
      detachRun(runId); layout.manual[runId] = true;
      const p2 = topNode('p', p.id) || p;
      if (!layout.nodes.includes(p2)) return save();
      const at = p2.runs.indexOf(tId);
      p2.runs.splice(y < 0.5 ? at : at + 1, 0, runId);
      return save();
    }
    // 目标是顶层任务
    if (y > 0.3 && y < 0.7) {                          // 正中间：组成新项目
      const node = detachRun(runId); layout.manual[runId] = true;
      const ti = findTop('run', tId); if (ti < 0) { layout.nodes.unshift(node); return save(); }
      const target2 = layout.nodes[ti];
      const tr = runsById[tId] || {};
      layout.nodes.splice(ti, 1, { type: 'project', id: 'p' + Date.now(), name: tr.projectName || String(tr.title || '').split(/[：:]/)[0] || '新项目', key: '', runs: [tId, runId], pinned: !!target2.pinned, archived: !!target2.archived, collapsed: false });
      layout.manual[tId] = true;
      return save();
    }
    const node = detachRun(runId); layout.manual[runId] = true;
    const ti = findTop('run', tId); if (ti < 0) { layout.nodes.unshift(node); return save(); }
    node.pinned = !!layout.nodes[ti].pinned; node.archived = !!layout.nodes[ti].archived;
    layout.nodes.splice(y < 0.5 ? ti : ti + 1, 0, node);
    save();
  }

  function clearMarks() { document.querySelectorAll('#runs .drop-before, #runs .drop-after, #runs .drop-into').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into')); }

  function bind() {
    const box = $('#runs');
    box.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-sact]');
      if (act) {
        e.stopPropagation();
        const { sact, kind, id } = act.dataset;
        if (sact === 'delete') return doDelete(kind, id);
        if (sact === 'out') { const node = detachRun(id); layout.manual[id] = true; layout.nodes.unshift(node); save(); return hooks.refresh(); }
        const node = topNode(kind, id); if (!node) return;
        if (sact === 'pin') { node.pinned = !node.pinned; if (node.pinned) node.archived = false; }
        if (sact === 'archive') { node.archived = !node.archived; if (node.archived) node.pinned = false; }
        save(); return hooks.refresh();
      }
      if (e.target.closest('[data-archtoggle]')) { e.stopPropagation(); layout.archivedOpen = !layout.archivedOpen; save(); return hooks.refresh(); }
      const head = e.target.closest('[data-phead]');
      if (head && !e.target.closest('.p-rename')) {
        e.stopPropagation();
        const p = topNode('p', head.dataset.phead); if (!p) return;
        p.collapsed = !p.collapsed; save(); return hooks.refresh();
      }
    }, true);
    box.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('.p-name'); if (!nameEl) return;
      const head = nameEl.closest('[data-phead]');
      renaming = head.dataset.phead; lastSig = ''; render(Object.values(runsById), true);
      const input = $('.p-rename', box); if (input) { input.focus(); input.select(); }
    });
    const finishRename = (input, ok) => {
      const p = topNode('p', input.dataset.rename);
      if (ok && p && input.value.trim()) p.name = input.value.trim().slice(0, 30);
      renaming = null; save(); hooks.refresh();
    };
    box.addEventListener('keydown', (e) => {
      if (!e.target.matches('.p-rename')) return;
      if (e.key === 'Enter') finishRename(e.target, true);
      if (e.key === 'Escape') finishRename(e.target, false);
    });
    box.addEventListener('focusout', (e) => { if (e.target.matches('.p-rename') && renaming) finishRename(e.target, true); });

    box.addEventListener('dragstart', (e) => {
      const el = e.target.closest('[data-drag]'); if (!el) return;
      const [kind, id] = el.dataset.drag.split(/:(.+)/);
      dragging = { kind, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.drag);
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    box.addEventListener('dragover', (e) => {
      if (!dragging) return;
      const el = e.target.closest('[data-drag]');
      clearMarks();
      if (!el) { e.preventDefault(); return; }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const y = (e.clientY - r.top) / r.height;
      const zone = el.dataset.zone;
      if (dragging.kind === 'r' && ((zone === 'project' && y >= 0.3) || (zone === 'run' && y > 0.3 && y < 0.7))) el.classList.add('drop-into');
      else el.classList.add(y < 0.5 ? 'drop-before' : 'drop-after');
    });
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      const el = e.target.closest('[data-drag]');
      clearMarks();
      if (el) dropOn(el, e.clientY);
      else if (dragging && dragging.kind === 'r') {      // 拖到空白处：脱离项目，放到最下面
        const sec = e.target.closest('[data-section]');
        const node = detachRun(dragging.id); layout.manual[dragging.id] = true;
        node.pinned = sec ? sec.dataset.section === 'pinned' : false;
        node.archived = sec ? sec.dataset.section === 'archived' : false;
        layout.nodes.push(node); save();
      }
      dragging = null; hooks.refresh();
    });
    box.addEventListener('dragend', () => { dragging = null; clearMarks(); hooks.refresh(); });
  }

  window.consoleSidebar = {
    async init(h) { hooks = h; layout = await api.getLayout(); bind(); },
    render,
    invalidate() { lastSig = ''; },
    busy: () => !!dragging || !!renaming,
    // 给主界面用：没手动选择时，默认看哪个任务（置顶和普通里最上面那个，跳过归档）
    firstVisible() {
      if (!layout) return null;
      for (const n of layout.nodes.filter((x) => !x.archived).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))) {
        if (n.type === 'run' && runsById[n.id]) return n.id;
        if (n.type === 'project' && n.runs.length) return n.runs[0];
      }
      return null;
    },
  };
})();
