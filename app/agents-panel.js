// AI指挥台 · 助手名单面板与多助手视觉解析（颜色自适应提亮、几何图标、即时保存与平稳降级）
(function () {
  const api = window.console2 || {};
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 简洁几何线条图标（统一 24x24 视口与约 2.1px 描边，不使用商标原图或渐变）
  const ICONS = {
    codex: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="8 6 3 12 8 18"/><polyline points="16 6 21 12 16 18"/><line x1="13" y1="5" x2="11" y2="19"/></svg>',
    agy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><circle cx="12" cy="12" r="3.4"/><ellipse cx="12" cy="12" rx="9.5" ry="4.4" transform="rotate(-28 12 12)"/></svg>',
    claude: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
    // DeepSeek：深潜声呐弧与罗盘探针几何图形
    deepseek: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 3.5 18 12 12 20.5 6 12"/><circle cx="12" cy="12" r="2.2"/><path d="M4.2 7.8a9.5 9.5 0 0 0 0 8.4M19.8 7.8a9.5 9.5 0 0 1 0 8.4"/></svg>',
    grok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><line x1="5.5" y1="18.5" x2="18.5" y2="5.5"/></svg>',
    gemini: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path d="M12 3L14.8 9.2L21 12L14.8 14.8L12 21L9.2 14.8L3 12L9.2 9.2Z"/></svg>',
    desktop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><line x1="3.5" y1="9" x2="20.5" y2="9"/></svg>',
    default: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><polygon points="12 3.2 19.6 7.6 19.6 16.4 12 20.8 4.4 16.4 4.4 7.6"/><circle cx="12" cy="12" r="2.2"/></svg>',
  };

  // 旧记录没有 vendorInfo 时回退的内置规则（含 DeepSeek 默认兜底）
  const PRESETS = {
    codex: { name: 'Codex', light: '#1C727E', lightSoft: '#EAF5F7', cool: '#38BDF8', coolSoft: 'rgba(56, 189, 248, .13)', icon: 'codex' },
    agy: { name: 'Antigravity', light: '#C96B27', lightSoft: '#FCF1E8', cool: '#F59E0B', coolSoft: 'rgba(245, 158, 11, .14)', icon: 'agy' },
    claude: { name: 'Claude', light: '#3B7A57', lightSoft: '#EBF5EF', cool: '#F0835A', coolSoft: 'rgba(240, 131, 90, .14)', icon: 'claude' },
    deepseek: { name: 'DeepSeek', light: '#1E5BB8', lightSoft: '#EAF1FB', cool: '#58A6FF', coolSoft: 'rgba(88, 166, 255, .14)', icon: 'deepseek' },
  };
  const DEFAULT_PALETTE = { light: '#476278', lightSoft: '#EEF2F6', cool: '#7DD3FC', coolSoft: 'rgba(125, 211, 252, .13)' };

  // ---------- 色彩解析与炫酷模式自适应提亮 ----------
  function parseColor(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (m) {
      const h = m[1];
      if (h.length === 3) {
        return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
      }
      return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
    }
    m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (m) {
      return { r: Math.min(255, Number(m[1])), g: Math.min(255, Number(m[2])), b: Math.min(255, Number(m[3])) };
    }
    return null;
  }

  const toHex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  function luminance({ r, g, b }) {
    const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function rgbToHsl({ r, g, b }) {
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === R) h = ((G - B) / d + (G < B ? 6 : 0)) / 6;
      else if (max === G) h = ((B - R) / d + 2) / 6;
      else h = ((R - G) / d + 4) / 6;
    }
    return { h, s, l };
  }

  function hslToRgb({ h, s, l }) {
    if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  const mixWhite = ({ r, g, b }, ratio) => toHex({
    r: 255 * (1 - ratio) + r * ratio,
    g: 255 * (1 - ratio) + g * ratio,
    b: 255 * (1 - ratio) + b * ratio,
  });

  const colorCache = new Map();
  function derivePalette(colorStr) {
    if (colorCache.has(colorStr)) return colorCache.get(colorStr);
    const rgb = parseColor(colorStr);
    if (!rgb) return null;

    // 普通模式：保留名单原色；若过亮在暖白底看不清文字则轻微收深
    let lightRgb = rgb;
    if (luminance(rgb) > 0.52) {
      const hsl = rgbToHsl(rgb);
      lightRgb = hslToRgb({ h: hsl.h, s: hsl.s, l: Math.min(hsl.l, 0.44) });
    }
    const light = lightRgb === rgb ? toHex(rgb) : toHex(lightRgb);
    const lightSoft = mixWhite(lightRgb, 0.11);

    // 炫酷模式：深色舰桥底（#0B1016 / #121A23）上确保足够明亮通透
    let coolRgb = rgb;
    if (luminance(coolRgb) < 0.36) {
      const hsl = rgbToHsl(coolRgb);
      const s = hsl.s < 0.08 ? hsl.s : Math.max(hsl.s, 0.68);
      let l = Math.max(hsl.l, 0.64);
      coolRgb = hslToRgb({ h: hsl.h, s, l });
      while (luminance(coolRgb) < 0.36 && l < 0.78) {
        l += 0.03;
        coolRgb = hslToRgb({ h: hsl.h, s, l });
      }
    }
    const cool = toHex(coolRgb);
    const coolSoft = `rgba(${coolRgb.r}, ${coolRgb.g}, ${coolRgb.b}, .14)`;
    const res = { light, lightSoft, cool, coolSoft };
    colorCache.set(colorStr, res);
    return res;
  }

  function pickIcon(iconHint, key, nameHint, kindHint) {
    const raw = String(iconHint || '').trim();
    if (raw) {
      const lower = raw.toLowerCase();
      if (ICONS[lower]) return ICONS[lower];
      // 若后端直接提供了干净的内联 SVG，安全过滤后使用
      if (/^<svg[\s>]/i.test(raw) && !/<script|on\w+\s*=|javascript:/i.test(raw)) return raw;
    }
    if (ICONS[key]) return ICONS[key];
    const probe = `${key} ${String(nameHint || '').toLowerCase()}`;
    if (probe.includes('deepseek')) return ICONS.deepseek;
    if (probe.includes('grok')) return ICONS.grok;
    if (probe.includes('gemini')) return ICONS.gemini;
    if (probe.includes('codex') || probe.includes('openai')) return ICONS.codex;
    if (probe.includes('agy') || probe.includes('antigravity')) return ICONS.agy;
    if (probe.includes('claude')) return ICONS.claude;
    if (kindHint === 'desktop') return ICONS.desktop;
    return ICONS.default;
  }

  // 名单缓存（仅对既无 vendorInfo 也非内置三家的记录作补充，以及用于代码流说话人识别）
  const catalogById = new Map();

  function resolve(a) {
    if (!a) return { key: '', name: '', iconSvg: ICONS.default, styleVars: '', hasIdentity: false };
    const isCatalogItem = Boolean(a.id && !a.agent && ('enabled' in a || 'found' in a || 'kind' in a));
    const rawAgent = isCatalogItem ? a.id : a.agent;
    const key = rawAgent === 'claude-session' ? 'claude' : String(rawAgent || '').toLowerCase();
    const vi = isCatalogItem
      ? { name: a.name, color: a.color, icon: a.icon }
      : (a.vendorInfo && typeof a.vendorInfo === 'object' ? a.vendorInfo : null);

    // 没有 vendorInfo 时：优先回退到现有的 Codex / agy / Claude（及 DeepSeek）规则；其他未知新助手可参考已加载的名单
    const preset = PRESETS[key] || null;
    const fallbackItem = !vi && !preset && key ? catalogById.get(key) : null;
    const colorSource = (vi && vi.color) || (fallbackItem && fallbackItem.color) || '';
    const derived = colorSource ? derivePalette(colorSource) : null;
    const hasIdentity = Boolean(vi || preset || fallbackItem || key);
    const palette = derived || preset || (hasIdentity ? DEFAULT_PALETTE : null);

    const displayName = rawAgent === 'claude-session'
      ? 'Claude 会话'
      : ((vi && vi.name) || (preset && preset.name) || (fallbackItem && fallbackItem.name) || rawAgent || '');
    const iconSvg = pickIcon((vi && vi.icon) || (fallbackItem && fallbackItem.icon), key, displayName, a.kind || (fallbackItem && fallbackItem.kind));
    const styleVars = palette
      ? `--v-color-light:${palette.light};--v-soft-light:${palette.lightSoft};--v-color-cool:${palette.cool};--v-soft-cool:${palette.coolSoft}`
      : '';

    return {
      key,
      name: displayName,
      iconSvg,
      styleVars,
      hasIdentity,
      light: palette ? palette.light : '',
      cool: palette ? palette.cool : '',
    };
  }

  function knownIds() {
    return ['codex', 'agy', 'claude', 'deepseek', 'subagent', ...catalogById.keys()];
  }

  window.consoleVendor = { ICONS, PRESETS, resolve, derivePalette, knownIds };

  // ---------- 「助手」右侧管理面板 ----------
  let panelOpen = false;
  let agents = [];
  let loaded = false;
  let loadError = '';
  let hooks = { onToggle: () => {}, onUpdate: () => {} };

  // 每个字段的即时保存跟踪：`${id}:${field}` -> { timer, saved, pending, composing }
  const fieldState = new Map();
  // 每个助手行的提示信息：id -> { type: 'saving'|'saved'|'error', text, clearTimer }
  const rowFeedback = new Map();

  const hasListApi = () => typeof api.listAgents === 'function';
  const hasSetApi = () => typeof api.setAgent === 'function';

  const ENTRY_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17.2" cy="9.5" r="2.4"/><path d="M15.5 14.6c2.2.3 3.9 1.7 4.5 4.2"/></svg>';

  function statusInfo(item) {
    if (item.found === false) return { cls: 'is-missing', text: '程序没找到' };
    if (item.kind === 'desktop') return { cls: 'is-desktop', text: '只有桌面程序暂不能派活' };
    return { cls: 'is-ready', text: '可以派活' };
  }

  function renderEntry() {
    const bar = $('#agents-bar');
    if (!bar) return;
    if (!hasListApi()) {
      bar.innerHTML = `
        <button class="agents-entry muted ${panelOpen ? 'on' : ''}" type="button" data-agents-toggle="1" title="后台更新后可在这里挑选和管理 AI 助手">
          <span class="ae-left">${ENTRY_ICON}<span>助手</span></span>
          <span class="ae-meta warn">需要更新</span>
        </button>`;
      return;
    }
    const enabledCount = agents.filter((a) => a.enabled).length;
    const meta = loadError ? '读取失败' : (loaded ? `${enabledCount} 个开启` : '管理');
    bar.innerHTML = `
      <button class="agents-entry ${panelOpen ? 'on' : ''}" type="button" data-agents-toggle="1" aria-expanded="${panelOpen ? 'true' : 'false'}">
        <span class="ae-left">${ENTRY_ICON}<span>助手</span></span>
        <span class="ae-meta">${esc(meta)}</span>
      </button>`;
  }

  function setFeedback(id, type, text) {
    const prev = rowFeedback.get(id);
    if (prev && prev.clearTimer) clearTimeout(prev.clearTimer);
    const entry = { type, text, clearTimer: null };
    if (type === 'saved') {
      entry.clearTimer = setTimeout(() => {
        if (rowFeedback.get(id) === entry) {
          rowFeedback.delete(id);
          paintFeedback(id);
        }
      }, 1600);
    }
    rowFeedback.set(id, entry);
    paintFeedback(id);
  }

  function paintFeedback(id) {
    const drawer = $('#agents-drawer');
    if (!drawer) return;
    const card = drawer.querySelector(`.ag-card[data-ag-card="${CSS.escape(id)}"]`);
    if (!card) return;
    const box = $('.ag-feedback', card);
    if (!box) return;
    const fb = rowFeedback.get(id);
    if (!fb || !fb.text) {
      box.className = 'ag-feedback';
      box.textContent = '';
      return;
    }
    box.className = `ag-feedback is-${fb.type}`;
    box.textContent = fb.text;
  }

  function syncDrawerHeaderCount() {
    const sub = $('#agents-drawer .ag-count');
    if (!sub || !loaded) return;
    const enabledCount = agents.filter((a) => a.enabled).length;
    sub.textContent = `共 ${agents.length} 个 · ${enabledCount} 个开启`;
  }

  function renderDrawer() {
    const drawer = $('#agents-drawer');
    if (!drawer) return;
    drawer.classList.toggle('open', panelOpen);
    drawer.hidden = !panelOpen;
    if (!panelOpen) {
      drawer.innerHTML = '';
      return;
    }

    if (!hasListApi()) {
      drawer.innerHTML = `
        <header class="ag-head">
          <div class="ag-title-wrap"><b>助手</b><span class="ag-count">需要更新</span></div>
          <div class="ag-head-acts"><button class="mini" type="button" data-agents-close="1">关闭</button></div>
        </header>
        <div class="ag-intro">总指挥只会把活派给开着的助手，你在聊天里点名某个助手时也会照办。</div>
        <div class="ag-empty">
          <b>需要更新后台程序</b>
          <span>当前窗口的后台还没有提供助手名单接口，更新并重启指挥台后即可在这里管理助手。</span>
        </div>`;
      return;
    }

    if (loadError) {
      drawer.innerHTML = `
        <header class="ag-head">
          <div class="ag-title-wrap"><b>助手</b></div>
          <div class="ag-head-acts">
            <button class="mini" type="button" data-agents-reload="1">重试</button>
            <button class="mini" type="button" data-agents-close="1">关闭</button>
          </div>
        </header>
        <div class="ag-intro">总指挥只会把活派给开着的助手，你在聊天里点名某个助手时也会照办。</div>
        <div class="ag-empty is-err">
          <b>没能读到助手名单</b>
          <span>${esc(loadError)}</span>
        </div>`;
      return;
    }

    if (!loaded) {
      drawer.innerHTML = `
        <header class="ag-head">
          <div class="ag-title-wrap"><b>助手</b><span class="ag-count">正在读取…</span></div>
          <div class="ag-head-acts"><button class="mini" type="button" data-agents-close="1">关闭</button></div>
        </header>
        <div class="ag-intro">总指挥只会把活派给开着的助手，你在聊天里点名某个助手时也会照办。</div>
        <div class="ag-empty"><span>正在读取本机助手名单…</span></div>`;
      return;
    }

    const enabledCount = agents.filter((a) => a.enabled).length;
    const cardsHtml = agents.length
      ? agents.map((item) => {
          const v = resolve(item);
          const st = statusInfo(item);
          const fb = rowFeedback.get(item.id);
          return `
            <section class="ag-card ${item.enabled ? '' : 'is-off'}" data-ag-card="${esc(item.id)}" style="${esc(v.styleVars)}">
              <div class="ag-top">
                <div class="ag-who">
                  <div class="mark">${v.iconSvg}</div>
                  <div class="ag-who-text">
                    <div class="ag-name-row">
                      <strong class="ag-name">${esc(item.name || item.id)}</strong>
                      <span class="ag-status ${st.cls}">${esc(st.text)}</span>
                    </div>
                  </div>
                </div>
                <label class="sw ag-sw" title="${item.enabled ? '点击关闭这个助手' : '点击开启这个助手'}">
                  <span>${item.enabled ? '已开启' : '已关闭'}</span>
                  <input type="checkbox" data-ag-toggle="${esc(item.id)}" ${item.enabled ? 'checked' : ''} />
                  <span class="pill"><span class="knob"></span></span>
                </label>
              </div>
              <div class="ag-fields">
                <label class="ag-field">
                  <span class="ag-label">一句话定位</span>
                  <input class="ag-input" type="text" data-ag-field="role" data-ag-id="${esc(item.id)}" value="${esc(item.role ?? '')}" placeholder="比如：擅长写代码、跑测试，或擅长搜资料…" />
                </label>
                <label class="ag-field">
                  <span class="ag-label">默认模型</span>
                  <input class="ag-input mono" type="text" data-ag-field="model" data-ag-id="${esc(item.id)}" value="${esc(item.model ?? '')}" placeholder="可留空，留空时使用程序默认模型" />
                </label>
              </div>
              <div class="ag-feedback ${fb && fb.text ? `is-${fb.type}` : ''}" role="status" aria-live="polite">${esc(fb ? fb.text : '')}</div>
            </section>`;
        }).join('')
      : '<div class="ag-empty"><b>名单里还没有助手</b><span>后台配置好助手名单后会自动显示在这里。</span></div>';

    drawer.innerHTML = `
      <header class="ag-head">
        <div class="ag-title-wrap">
          <b>助手</b>
          <span class="ag-count">共 ${agents.length} 个 · ${enabledCount} 个开启</span>
        </div>
        <div class="ag-head-acts">
          <button class="mini" type="button" data-agents-reload="1" title="重新检测电脑上已安装的助手程序">重新检测</button>
          <button class="mini" type="button" data-agents-close="1">关闭</button>
        </div>
      </header>
      <div class="ag-intro">总指挥只会把活派给开着的助手，你在聊天里点名某个助手时也会照办。</div>
      <div class="ag-list">${cardsHtml}</div>`;
  }

  async function refreshList(renderAfter = true) {
    if (!hasListApi()) {
      renderEntry();
      if (renderAfter && panelOpen) renderDrawer();
      return;
    }
    try {
      const list = await api.listAgents();
      agents = Array.isArray(list) ? list : [];
      loadError = '';
      loaded = true;
      catalogById.clear();
      for (const item of agents) {
        if (item && item.id) {
          catalogById.set(String(item.id).toLowerCase(), item);
          fieldState.set(`${item.id}:role`, { timer: null, saved: String(item.role ?? ''), saving: false, composing: false });
          fieldState.set(`${item.id}:model`, { timer: null, saved: String(item.model ?? ''), saving: false, composing: false });
        }
      }
      hooks.onUpdate(agents);
    } catch (e) {
      loadError = (e && e.message) ? e.message : '读取助手名单出错，请稍后再试。';
      loaded = true;
    }
    renderEntry();
    if (renderAfter && panelOpen) {
      const drawer = $('#agents-drawer');
      const typingInside = drawer && drawer.contains(document.activeElement) && document.activeElement.matches('input[data-ag-field]');
      if (!typingInside || loadError) renderDrawer();
      else syncDrawerHeaderCount();
    }
  }

  async function saveToggle(id, checked, inputEl) {
    const item = agents.find((x) => x.id === id);
    if (!item) return;
    if (!hasSetApi()) {
      if (inputEl) inputEl.checked = !!item.enabled;
      setFeedback(id, 'error', '需要更新后台程序才能修改助手设置。');
      return;
    }
    const prev = !!item.enabled;
    item.enabled = checked;
    const card = inputEl && inputEl.closest('.ag-card');
    const swLabel = inputEl && inputEl.closest('.ag-sw')?.querySelector('span');
    if (card) card.classList.toggle('is-off', !checked);
    if (swLabel) swLabel.textContent = checked ? '已开启' : '已关闭';
    renderEntry();
    syncDrawerHeaderCount();
    setFeedback(id, 'saving', '正在保存…');

    try {
      const err = await api.setAgent(id, { enabled: Boolean(checked) });
      if (err) {
        item.enabled = prev;
        if (inputEl) inputEl.checked = prev;
        if (card) card.classList.toggle('is-off', !prev);
        if (swLabel) swLabel.textContent = prev ? '已开启' : '已关闭';
        renderEntry();
        syncDrawerHeaderCount();
        setFeedback(id, 'error', String(err));
      } else {
        setFeedback(id, 'saved', '已保存');
        hooks.onUpdate(agents);
      }
    } catch (e) {
      item.enabled = prev;
      if (inputEl) inputEl.checked = prev;
      if (card) card.classList.toggle('is-off', !prev);
      if (swLabel) swLabel.textContent = prev ? '已开启' : '已关闭';
      renderEntry();
      syncDrawerHeaderCount();
      setFeedback(id, 'error', (e && e.message) ? e.message : '保存失败，请重试。');
    }
  }

  async function commitField(id, field) {
    const key = `${id}:${field}`;
    const st = fieldState.get(key);
    const drawer = $('#agents-drawer');
    const input = drawer && drawer.querySelector(`input[data-ag-id="${CSS.escape(id)}"][data-ag-field="${CSS.escape(field)}"]`);
    const item = agents.find((x) => x.id === id);
    if (!item || !st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }

    const currentVal = input ? input.value : String(item[field] ?? '');
    if (currentVal === st.saved) return;
    if (!hasSetApi()) {
      setFeedback(id, 'error', '需要更新后台程序才能保存修改。');
      return;
    }
    if (st.saving) return; // 正在请求中，返回后会再次比对最新值

    st.saving = true;
    const sendingVal = currentVal;
    setFeedback(id, 'saving', '正在保存…');
    try {
      const patch = field === 'role' ? { role: String(sendingVal) } : { model: String(sendingVal) };
      const err = await api.setAgent(id, patch);
      if (err) {
        setFeedback(id, 'error', String(err));
      } else {
        st.saved = sendingVal;
        item[field] = sendingVal;
        setFeedback(id, 'saved', '已保存');
      }
    } catch (e) {
      setFeedback(id, 'error', (e && e.message) ? e.message : '保存失败，请重试。');
    } finally {
      st.saving = false;
      // 如果保存期间用户又继续输入了新字，紧接着把最新内容补存一次
      const latestInput = $('#agents-drawer')?.querySelector(`input[data-ag-id="${CSS.escape(id)}"][data-ag-field="${CSS.escape(field)}"]`);
      if (latestInput && latestInput.value !== st.saved && !st.composing) {
        scheduleField(id, field, 250);
      }
    }
  }

  function scheduleField(id, field, delay = 480) {
    const key = `${id}:${field}`;
    let st = fieldState.get(key);
    if (!st) {
      const item = agents.find((x) => x.id === id);
      st = { timer: null, saved: String(item ? (item[field] ?? '') : ''), saving: false, composing: false };
      fieldState.set(key, st);
    }
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => commitField(id, field), delay);
  }

  function flushPendingFields() {
    for (const [key, st] of fieldState.entries()) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
        const idx = key.lastIndexOf(':');
        if (idx > 0) commitField(key.slice(0, idx), key.slice(idx + 1));
      }
    }
  }

  function open() {
    if (panelOpen) return;
    panelOpen = true;
    renderEntry();
    renderDrawer();
    hooks.onToggle(true);
    refreshList(true);
  }

  function close() {
    if (!panelOpen) return;
    flushPendingFields();
    panelOpen = false;
    renderEntry();
    renderDrawer();
    hooks.onToggle(false);
  }

  function toggle() {
    if (panelOpen) close();
    else open();
  }

  function bindEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-agents-toggle]')) { toggle(); return; }
      if (e.target.closest('[data-agents-close]')) { close(); return; }
      if (e.target.closest('[data-agents-reload]')) {
        flushPendingFields();
        refreshList(true);
      }
    });

    const drawer = $('#agents-drawer');
    if (!drawer) return;

    drawer.addEventListener('change', (e) => {
      const sw = e.target.closest('input[data-ag-toggle]');
      if (sw) saveToggle(sw.dataset.agToggle, sw.checked, sw);
    });

    drawer.addEventListener('compositionstart', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (!inp) return;
      const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
      if (st) st.composing = true;
    });

    drawer.addEventListener('compositionend', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (!inp) return;
      const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
      if (st) st.composing = false;
      scheduleField(inp.dataset.agId, inp.dataset.agField, 400);
    });

    drawer.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (!inp) return;
      const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
      if (st && st.composing) return;
      scheduleField(inp.dataset.agId, inp.dataset.agField, 480);
    });

    drawer.addEventListener('focusout', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (!inp) return;
      commitField(inp.dataset.agId, inp.dataset.agField);
    });

    drawer.addEventListener('keydown', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (inp && e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        inp.blur();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.isComposing && panelOpen && !$('#mark-dialog')?.open) {
        const active = document.activeElement;
        if (active && drawer.contains(active) && active.matches('input[data-ag-field]')) {
          active.blur();
        }
        close();
      }
    });
  }

  window.consoleAgents = {
    init(h = {}) {
      hooks = { ...hooks, ...h };
      bindEvents();
      renderEntry();
      if (hasListApi()) refreshList(false);
    },
    open,
    close,
    toggle,
    isOpen: () => panelOpen,
    supported: hasListApi,
  };
})();
