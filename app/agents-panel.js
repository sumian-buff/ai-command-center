// AI指挥台 · 助手名单面板与多助手视觉解析（颜色自适应提亮、几何/首字图标、自定义助手增删、即时保存与平稳降级）
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

  // 添加自定义助手时的预设代表色（温润克制，在暖纸与深色舰桥下皆清晰耐看）
  const COLOR_PRESETS = [
    { hex: '#6b4fa2', label: '暮山紫' },
    { hex: '#2b6cb0', label: '海盐蓝' },
    { hex: '#2f7d6d', label: '竹青绿' },
    { hex: '#b84a62', label: '茜梅红' },
    { hex: '#8c6239', label: '栗木棕' },
    { hex: '#b86b1f', label: '暖赭金' },
    { hex: '#4f5d75', label: '岩灰蓝' },
  ];

  // 常见中文助手名到默认英文编号的便捷映射
  const CN_ID_HINTS = [
    [/kimi|月之暗面|暗面/i, 'kimi'],
    [/glm|智谱|清言/i, 'glm'],
    [/qwen|通义|千问|灵码/i, 'qwen'],
    [/doubao|豆包|trae/i, 'doubao'],
    [/ernie|文心|一言/i, 'ernie'],
    [/hunyuan|混元/i, 'hunyuan'],
    [/minimax|海螺/i, 'minimax'],
    [/baichuan|百川/i, 'baichuan'],
    [/spark|星火/i, 'spark'],
    [/step|阶跃/i, 'step'],
    [/yi|零一万物/i, 'yi'],
  ];

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

  function normalizeHex6(raw, allowBare = false) {
    const s = String(raw || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    }
    if (allowBare && /^[0-9a-f]{6}$/i.test(s)) return '#' + s.toLowerCase();
    return '';
  }

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

  // 提取名字的首字或首字母，用于未指定图标的自定义助手
  function extractInitial(nameHint, keyHint) {
    for (const src of [nameHint, keyHint]) {
      const s = String(src || '').trim();
      if (!s) continue;
      const m = s.match(/[\u4e00-\u9fffA-Za-z0-9]/);
      if (m) {
        const ch = m[0];
        const isHan = /[\u4e00-\u9fff]/.test(ch);
        return { text: isHan ? ch : ch.toUpperCase(), isHan };
      }
    }
    return null;
  }

  function makeInitialIcon(nameHint, keyHint) {
    const ini = extractInitial(nameHint, keyHint);
    if (!ini) return '';
    return `<span class="mark-char${ini.isHan ? ' is-han' : ''}" aria-hidden="true">${esc(ini.text)}</span>`;
  }

  function pickIcon(iconHint, key, nameHint, kindHint, isCustom) {
    const raw = String(iconHint || '').trim();
    if (raw) {
      const lower = raw.toLowerCase();
      if (ICONS[lower]) return ICONS[lower];
      // 若后端直接提供了干净的内联 SVG，安全过滤后使用
      if (/^<svg[\s>]/i.test(raw) && !/<script|on\w+\s*=|javascript:/i.test(raw)) return raw;
    }
    if (!isCustom) {
      if (ICONS[key]) return ICONS[key];
      const probe = `${key} ${String(nameHint || '').toLowerCase()}`;
      if (probe.includes('deepseek')) return ICONS.deepseek;
      if (probe.includes('grok')) return ICONS.grok;
      if (probe.includes('gemini')) return ICONS.gemini;
      if (probe.includes('codex') || probe.includes('openai')) return ICONS.codex;
      if (probe.includes('agy') || probe.includes('antigravity')) return ICONS.agy;
      if (probe.includes('claude')) return ICONS.claude;
      if (kindHint === 'desktop') return ICONS.desktop;
    }
    // 若自定义助手指定了简短字符图标（1~2 字），直接展示该字符
    if (raw && raw.length <= 2) {
      const isHan = /[\u4e00-\u9fff]/.test(raw);
      return `<span class="mark-char${isHan ? ' is-han' : ''}" aria-hidden="true">${esc(raw)}</span>`;
    }
    // 没有指定图标时，用名字首字（或首字母）生成简洁图标
    const initialIcon = makeInitialIcon(nameHint, key);
    return initialIcon || ICONS.default;
  }

  // 名单缓存（仅对既无 vendorInfo 也非内置三家的记录作补充，以及用于代码流说话人识别）
  const catalogById = new Map();

  function resolve(a) {
    if (!a) return { key: '', name: '', iconSvg: ICONS.default, styleVars: '', hasIdentity: false };
    const isCatalogItem = Boolean(a.id && !a.agent && ('enabled' in a || 'found' in a || 'kind' in a || 'custom' in a));
    const rawAgent = isCatalogItem ? a.id : a.agent;
    const key = rawAgent === 'claude-session' ? 'claude' : String(rawAgent || '').toLowerCase();
    const vi = isCatalogItem
      ? { name: a.name, color: a.color, icon: a.icon }
      : (a.vendorInfo && typeof a.vendorInfo === 'object' ? a.vendorInfo : null);

    // 没有 vendorInfo 时：优先回退到现有的 Codex / agy / Claude（及 DeepSeek）规则；其他未知新助手可参考已加载的名单
    const catalogItem = key ? catalogById.get(key) : null;
    const isCustom = Boolean(a.custom || (catalogItem && catalogItem.custom));
    const preset = !isCustom ? (PRESETS[key] || null) : null;
    const fallbackItem = !vi && !preset ? catalogItem : null;
    const colorSource = (vi && vi.color) || (catalogItem && catalogItem.color) || '';
    const derived = colorSource ? derivePalette(colorSource) : null;
    const hasIdentity = Boolean(vi || preset || fallbackItem || key);
    const palette = derived || preset || (hasIdentity ? DEFAULT_PALETTE : null);

    const displayName = rawAgent === 'claude-session'
      ? 'Claude 会话'
      : ((vi && vi.name) || (preset && preset.name) || (fallbackItem && fallbackItem.name) || rawAgent || '');
    const iconSource = (vi && vi.icon) || (fallbackItem && fallbackItem.icon) || '';
    const iconSvg = pickIcon(iconSource, key, displayName, a.kind || (catalogItem && catalogItem.kind), isCustom);
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

  window.consoleVendor = { ICONS, PRESETS, resolve, derivePalette, knownIds, makeInitialIcon };

  // ---------- 「助手」右侧管理面板 ----------
  let panelOpen = false;
  let agents = [];
  let loaded = false;
  let loadError = '';
  let hooks = { onToggle: () => {}, onUpdate: () => {} };

  // 自定义助手添加表单与删除确认状态
  let formOpen = false;
  let formAdvancedOpen = false;
  let formSaving = false;
  let formError = '';
  let formDraft = null;
  let confirmingDeleteId = '';
  let deletingId = '';

  // 每个字段的即时保存跟踪：`${id}:${field}` -> { timer, saved, saving, composing }
  const fieldState = new Map();
  // 每个助手行的提示信息：id -> { type: 'saving'|'saved'|'error', text, clearTimer }
  const rowFeedback = new Map();

  const hasListApi = () => typeof api.listAgents === 'function';
  const hasSetApi = () => typeof api.setAgent === 'function';
  const hasAddApi = () => typeof api.addAgent === 'function';
  const hasRemoveApi = () => typeof api.removeAgent === 'function';

  const ENTRY_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><circle cx="17.2" cy="9.5" r="2.4"/><path d="M15.5 14.6c2.2.3 3.9 1.7 4.5 4.2"/></svg>';
  const CHEVRON_SVG = '<svg class="ag-select-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

  function pickDefaultColor() {
    const used = new Set(agents.map((a) => normalizeHex6(a.color)).filter(Boolean));
    const unused = COLOR_PRESETS.find((c) => !used.has(c.hex));
    return unused ? unused.hex : COLOR_PRESETS[0].hex;
  }

  function createEmptyDraft() {
    return {
      name: '',
      command: '',
      role: '',
      color: pickDefaultColor(),
      id: '',
      idTouched: false,
      args: '',
      input: 'stdin',
      inputTouched: false,
      output: 'text',
      resumeArgs: '',
    };
  }

  function ensureDraft() {
    if (!formDraft) formDraft = createEmptyDraft();
    return formDraft;
  }

  // 根据名字（及可选命令路径）自动生成不重名的合法 id（小写字母、数字、短横线）
  function suggestAgentId(name, command) {
    const rawName = String(name || '').trim();
    const rawCmd = String(command || '').trim();
    let base = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base && rawName) {
      for (const [re, slug] of CN_ID_HINTS) {
        if (re.test(rawName)) { base = slug; break; }
      }
    }
    if (!base && rawCmd) {
      const file = rawCmd.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() || '';
      const stem = file.replace(/\.(exe|cmd|bat|ps1|sh|mjs|cjs|js)$/i, '');
      base = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }
    if (!base && rawName) base = 'custom';
    if (!base) return '';
    base = base.slice(0, 28).replace(/-+$/g, '') || 'custom';

    const taken = new Set(['codex', 'agy', 'claude', 'deepseek', 'grok', 'subagent', 'claude-session']);
    for (const a of agents) {
      if (a && a.id) taken.add(String(a.id).toLowerCase());
    }
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base}-${n}`)) n++;
    return `${base}-${n}`;
  }

  // 将用户输入的命令行参数文字拆分为字符串数组（兼容空格/引号写法与 JSON 数组写法，保留 Windows 反斜杠路径）
  function parseCliArgs(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return { ok: true, list: [] };
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr) && arr.every((x) => typeof x === 'string' || typeof x === 'number')) {
          return { ok: true, list: arr.map(String) };
        }
      } catch {
        // 不是合法 JSON 数组时按普通命令行参数继续解析
      }
    }
    const list = [];
    let cur = '';
    let inToken = false;
    let quote = '';
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (quote) {
        if (ch === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === quote) {
          cur += quote;
          i++;
        } else if (ch === quote) {
          quote = '';
        } else {
          cur += ch;
        }
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        inToken = true;
      } else if (/\s/.test(ch)) {
        if (inToken) {
          list.push(cur);
          cur = '';
          inToken = false;
        }
      } else {
        cur += ch;
        inToken = true;
      }
    }
    if (quote) return { ok: false, list: [] };
    if (inToken) list.push(cur);
    return { ok: true, list };
  }

  function looksLikeSecret(draft) {
    const joined = `${draft.command || ''} ${draft.args || ''} ${draft.resumeArgs || ''}`;
    return /\bsk-[A-Za-z0-9_-]{16,}\b/.test(joined) || /(?:--api[-_]?key\b|\b(?:API_KEY|SECRET_KEY|ACCESS_TOKEN)\s*=)/i.test(joined);
  }

  function statusInfo(item) {
    if (item.found === false) return { cls: 'is-missing', text: '程序没找到' };
    if (item.kind === 'desktop') return { cls: 'is-desktop', text: '只有桌面程序暂不能派活' };
    return { cls: 'is-ready', text: '可以派活' };
  }

  // 把 capabilities 里不支持的能力翻译成大白话状态补充说明
  function capabilityNotes(item) {
    if (!item || item.kind === 'desktop') return [];
    const caps = item.capabilities;
    if (!caps || typeof caps !== 'object') return [];
    const notes = [];
    if (caps.resume === false) notes.push('不能接着对话');
    if (caps.tokens === false) notes.push('不统计用量');
    return notes;
  }

  function formatCommandBrief(cmd) {
    if (Array.isArray(cmd)) return String(cmd[0] || '').trim();
    return String(cmd || '').trim();
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
      }, 1800);
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
    if (!sub || !loaded || formOpen) return;
    const enabledCount = agents.filter((a) => a.enabled).length;
    sub.textContent = `共 ${agents.length} 个 · ${enabledCount} 个开启`;
  }

  function buildAdvancedSummary(d) {
    const effId = (d.id || suggestAgentId(d.name, d.command) || '自动生成').trim();
    const inText = d.input === 'arg' ? '作为参数' : '标准输入';
    const outText = d.output === 'jsonl' ? 'JSON 行' : '普通文字';
    return `编号 ${effId} · ${inText} · ${outText}`;
  }

  function buildPreviewData(d) {
    const validHex = normalizeHex6(d.color, true) || COLOR_PRESETS[0].hex;
    const palette = derivePalette(validHex) || DEFAULT_PALETTE;
    const styleVars = `--v-color-light:${palette.light};--v-soft-light:${palette.lightSoft};--v-color-cool:${palette.cool};--v-soft-cool:${palette.coolSoft}`;
    const displayName = d.name.trim() || '新助手';
    const iconHtml = d.name.trim()
      ? (makeInitialIcon(d.name.trim(), d.id.trim()) || ICONS.default)
      : '<span class="mark-char is-han" aria-hidden="true">新</span>';
    const effId = (d.id || suggestAgentId(d.name, d.command)).trim();
    const roleBrief = d.role.trim() || (effId ? `编号：${effId}` : '填写名字和程序路径后即可添加到名单');
    return { validHex, styleVars, displayName, iconHtml, subText: roleBrief };
  }

  function renderFormView(drawer) {
    const d = ensureDraft();
    if (!d.idTouched) d.id = suggestAgentId(d.name, d.command);
    const pv = buildPreviewData(d);
    const activeHex = normalizeHex6(d.color, true);
    const secretWarn = looksLikeSecret(d);

    const swatchesHtml = COLOR_PRESETS.map((c) => {
      const on = activeHex === c.hex;
      return `<button class="ag-swatch${on ? ' is-on' : ''}" type="button" data-ag-swatch="${c.hex}" style="--sw-c:${c.hex}" title="${c.label}（${c.hex}）" aria-label="${c.label}" aria-pressed="${on ? 'true' : 'false'}"></button>`;
    }).join('');

    drawer.innerHTML = `
      <header class="ag-head">
        <div class="ag-title-wrap">
          <button class="mini ag-back-btn" type="button" data-ag-close-form="1">← 返回</button>
          <b>添加自定义助手</b>
        </div>
        <div class="ag-head-acts">
          <button class="mini" type="button" data-agents-close="1">关闭</button>
        </div>
      </header>
      <form class="ag-form" id="ag-custom-form" novalidate>
        <div class="ag-form-body">
          <div class="ag-safety-note" role="note">
            <b>添加前提醒</b>
            <p>请只接入各家<strong>官方的命令行工具</strong>、用自己的账号，不要接中转服务；密钥请在那个工具自己的设置里保存，<strong>不要填在这里</strong>。</p>
          </div>
          <div class="ag-secret-warn" id="agf-secret-warn" ${secretWarn ? '' : 'hidden'}>
            检测到填写内容里像是带有密钥参数。为了安全，请把密钥保存在该工具自己的配置或登录信息里，不要写在这里。
          </div>

          <div class="ag-preview-card" id="agf-preview" style="${esc(pv.styleVars)}">
            <div class="mark" id="agf-preview-mark">${pv.iconHtml}</div>
            <div class="ag-who-text">
              <div class="ag-name-row">
                <strong class="ag-name" id="agf-preview-name">${esc(pv.displayName)}</strong>
                <span class="ag-tag-custom">自定义</span>
              </div>
              <div class="ag-cap-note" id="agf-preview-caps">${esc(pv.subText)}</div>
            </div>
          </div>

          <div class="ag-fgroup">
            <label class="ag-flabel" for="agf-name"><span>名字</span><em class="ag-req">必填</em></label>
            <span class="ag-fhint">在监控墙和名单里显示的名字，比如 Kimi、智谱 GLM。</span>
            <input class="ag-input" id="agf-name" name="name" type="text" value="${esc(d.name)}" placeholder="例如：Kimi、GLM、通义千问" autocomplete="off" />
          </div>

          <div class="ag-fgroup">
            <label class="ag-flabel" for="agf-command"><span>程序路径</span><em class="ag-req">必填</em></label>
            <span class="ag-fhint">电脑上这个命令行工具的完整路径，或者已经装好能直接运行的命令名。</span>
            <input class="ag-input mono" id="agf-command" name="command" type="text" value="${esc(d.command)}" placeholder="例如：kimi 或 D:\\Tools\\kimi\\kimi.exe" autocomplete="off" spellcheck="false" />
          </div>

          <div class="ag-fgroup">
            <label class="ag-flabel" for="agf-role"><span>一句话定位</span></label>
            <span class="ag-fhint">用一句话说明它擅长做什么，总指挥派活时会参考这句话挑选助手。</span>
            <input class="ag-input" id="agf-role" name="role" type="text" value="${esc(d.role)}" placeholder="例如：擅长长文阅读、资料整理和中文初稿" autocomplete="off" />
          </div>

          <div class="ag-fgroup">
            <label class="ag-flabel" for="agf-color"><span>颜色</span></label>
            <span class="ag-fhint">它在监控墙和名单里的代表色，点选下方色块或自己填 # 开头的 6 位色号。</span>
            <div class="ag-color-row">
              <div class="ag-swatches" role="group" aria-label="预设颜色">${swatchesHtml}</div>
              <div class="ag-color-custom">
                <input class="ag-color-well" id="agf-color-picker" type="color" value="${esc(pv.validHex)}" title="点击自由取色" aria-label="自由取色" />
                <input class="ag-input mono ag-color-hex" id="agf-color" name="color" type="text" maxlength="7" value="${esc(d.color)}" placeholder="#6b4fa2" autocomplete="off" spellcheck="false" />
              </div>
            </div>
          </div>

          <details class="ag-adv" id="agf-adv" ${formAdvancedOpen ? 'open' : ''}>
            <summary class="ag-adv-sum">
              <span class="ag-adv-title">高级设置</span>
              <span class="ag-adv-meta" id="agf-adv-meta">${esc(buildAdvancedSummary(d))}</span>
            </summary>
            <div class="ag-adv-body">
              <div class="ag-fgroup">
                <label class="ag-flabel" for="agf-id"><span>编号 id</span></label>
                <span class="ag-fhint">内部区分助手的英文代号，只能用小写字母、数字和短横线；默认根据名字自动生成，也可以自己改。</span>
                <input class="ag-input mono" id="agf-id" name="id" type="text" value="${esc(d.id)}" placeholder="例如：kimi 或 glm-cli" autocomplete="off" spellcheck="false" />
              </div>

              <div class="ag-fgroup">
                <label class="ag-flabel" for="agf-args"><span>启动参数</span></label>
                <span class="ag-fhint">启动程序时跟在命令后面的参数，多个参数用空格隔开；如果要把任务放进参数里，用 {prompt} 代表任务文字。</span>
                <input class="ag-input mono" id="agf-args" name="args" type="text" value="${esc(d.args)}" placeholder="可留空，例如：--print {prompt}" autocomplete="off" spellcheck="false" />
              </div>

              <div class="ag-fgroup">
                <label class="ag-flabel" for="agf-input"><span>任务怎么传进去</span></label>
                <span class="ag-fhint">选择指挥台把任务文字交给这个工具的方式：从标准输入送进去，还是作为命令行参数传进去。</span>
                <div class="ag-select-wrap">
                  <select class="ag-select" id="agf-input" name="input">
                    <option value="stdin" ${d.input !== 'arg' ? 'selected' : ''}>通过标准输入</option>
                    <option value="arg" ${d.input === 'arg' ? 'selected' : ''}>作为参数</option>
                  </select>
                  ${CHEVRON_SVG}
                </div>
              </div>

              <div class="ag-fgroup">
                <label class="ag-flabel" for="agf-output"><span>输出格式</span></label>
                <span class="ag-fhint">这个工具运行时输出的是普通文字，还是一行一条 JSON 记录；不确定选「普通文字」即可。</span>
                <div class="ag-select-wrap">
                  <select class="ag-select" id="agf-output" name="output">
                    <option value="text" ${d.output !== 'jsonl' ? 'selected' : ''}>普通文字</option>
                    <option value="jsonl" ${d.output === 'jsonl' ? 'selected' : ''}>JSON 行</option>
                  </select>
                  ${CHEVRON_SVG}
                </div>
              </div>

              <div class="ag-fgroup">
                <label class="ag-flabel" for="agf-resume-args"><span>接着对话的参数</span></label>
                <span class="ag-fhint">可留空。如果它支持接着上一段对话继续聊，填续聊参数并用 {session} 代表对话编号；留空则每次新开对话。</span>
                <input class="ag-input mono" id="agf-resume-args" name="resumeArgs" type="text" value="${esc(d.resumeArgs)}" placeholder="可留空，例如：--resume {session}" autocomplete="off" spellcheck="false" />
              </div>
            </div>
          </details>
        </div>

        <footer class="ag-form-foot">
          <div class="ag-form-err" id="agf-error" role="alert" ${formError ? '' : 'hidden'}>${esc(formError)}</div>
          <div class="ag-form-acts">
            <button class="mini" type="button" data-ag-cancel-form="1" ${formSaving ? 'disabled' : ''}>取消</button>
            <button class="btn dark ag-submit-btn" type="submit" ${formSaving ? 'disabled' : ''}>${formSaving ? '正在添加…' : '添加助手'}</button>
          </div>
        </footer>
      </form>`;
  }

  // 在不销毁表单输入框的前提下，增量更新预览卡片、预设选中态和高级摘要（保证中文输入法不断词）
  function syncFormWidgets() {
    const drawer = $('#agents-drawer');
    if (!drawer || !formOpen || !formDraft) return;
    const d = formDraft;
    if (!d.idTouched) {
      d.id = suggestAgentId(d.name, d.command);
      const idInput = $('#agf-id', drawer);
      if (idInput && document.activeElement !== idInput) idInput.value = d.id;
    }

    const pv = buildPreviewData(d);
    const pvCard = $('#agf-preview', drawer);
    if (pvCard) pvCard.setAttribute('style', pv.styleVars);
    const pvMark = $('#agf-preview-mark', drawer);
    if (pvMark && pvMark.innerHTML !== pv.iconHtml) pvMark.innerHTML = pv.iconHtml;
    const pvName = $('#agf-preview-name', drawer);
    if (pvName) pvName.textContent = pv.displayName;
    const pvCaps = $('#agf-preview-caps', drawer);
    if (pvCaps) pvCaps.textContent = pv.subText;

    const activeHex = normalizeHex6(d.color, true);
    drawer.querySelectorAll('[data-ag-swatch]').forEach((btn) => {
      const on = btn.dataset.agSwatch === activeHex;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const picker = $('#agf-color-picker', drawer);
    if (picker && activeHex && picker.value.toLowerCase() !== activeHex) {
      picker.value = activeHex;
    }

    const meta = $('#agf-adv-meta', drawer);
    if (meta) meta.textContent = buildAdvancedSummary(d);

    const secretEl = $('#agf-secret-warn', drawer);
    if (secretEl) secretEl.hidden = !looksLikeSecret(d);
  }

  function showFormError(msg, focusSelector, needOpenAdv = false) {
    formError = msg;
    const drawer = $('#agents-drawer');
    if (!drawer || !formOpen) return;
    if (needOpenAdv) {
      formAdvancedOpen = true;
      const adv = $('#agf-adv', drawer);
      if (adv) adv.open = true;
    }
    const errEl = $('#agf-error', drawer);
    if (errEl) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
    }
    if (focusSelector) {
      const target = $(focusSelector, drawer);
      if (target) target.focus();
    }
  }

  function renderCardHtml(item) {
    const v = resolve(item);
    const st = statusInfo(item);
    const isCustom = Boolean(item.custom);
    const capNotes = capabilityNotes(item);
    const fb = rowFeedback.get(item.id);
    const isConfirming = isCustom && confirmingDeleteId === item.id;
    const isDeleting = isCustom && deletingId === item.id;
    const cmdBrief = isCustom ? formatCommandBrief(item.command) : '';
    const showModelField = !isCustom || Boolean(item.model);

    return `
      <section class="ag-card ${item.enabled ? '' : 'is-off'}${isCustom ? ' is-custom' : ''}" data-ag-card="${esc(item.id)}" style="${esc(v.styleVars)}">
        <div class="ag-top">
          <div class="ag-who">
            <div class="mark">${v.iconSvg}</div>
            <div class="ag-who-text">
              <div class="ag-name-row">
                <strong class="ag-name" title="${esc(item.id ? `编号：${item.id}` : '')}">${esc(item.name || item.id)}</strong>
                ${isCustom ? '<span class="ag-tag-custom">自定义</span>' : ''}
                <span class="ag-status ${st.cls}">${esc(st.text)}</span>
              </div>
              ${capNotes.length ? `<div class="ag-cap-note">${esc(capNotes.join(' · '))}</div>` : ''}
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
          ${showModelField ? `
          <label class="ag-field">
            <span class="ag-label">默认模型</span>
            <input class="ag-input mono" type="text" data-ag-field="model" data-ag-id="${esc(item.id)}" value="${esc(item.model ?? '')}" placeholder="可留空，留空时使用程序默认模型" />
          </label>` : ''}
        </div>
        ${isCustom ? (isConfirming ? `
        <div class="ag-del-confirm" role="alertdialog" aria-label="确认删除自定义助手">
          <span class="ag-del-text">确定把「${esc(item.name || item.id)}」从名单里删除吗？不会卸载电脑上的原程序。</span>
          <div class="ag-del-acts">
            <button class="mini" type="button" data-ag-del-cancel="${esc(item.id)}" ${isDeleting ? 'disabled' : ''}>取消</button>
            <button class="mini danger ag-del-go" type="button" data-ag-del-confirm="${esc(item.id)}" ${isDeleting ? 'disabled' : ''}>${isDeleting ? '正在删除…' : '确认删除'}</button>
          </div>
        </div>` : `
        <div class="ag-custom-foot">
          <span class="ag-cmd-hint" title="${esc(cmdBrief ? `命令：${cmdBrief}（编号：${item.id}）` : `编号：${item.id}`)}">${esc(cmdBrief ? `命令：${cmdBrief}` : `编号：${item.id}`)}</span>
          ${hasRemoveApi()
            ? `<button class="mini danger ag-del-btn" type="button" data-ag-del-ask="${esc(item.id)}">删除</button>`
            : '<span class="ag-need-update" title="更新后台程序后可删除自定义助手">需更新后台才可删除</span>'}
        </div>`) : ''}
        <div class="ag-feedback ${fb && fb.text ? `is-${fb.type}` : ''}" role="status" aria-live="polite">${esc(fb ? fb.text : '')}</div>
      </section>`;
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

    if (formOpen && hasAddApi()) {
      renderFormView(drawer);
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
      ? agents.map(renderCardHtml).join('')
      : '<div class="ag-empty"><b>名单里还没有助手</b><span>可以点下方按钮添加电脑上已装好的命令行 AI 助手。</span></div>';

    const footHtml = hasAddApi()
      ? `<footer class="ag-foot">
          <button class="ag-add-btn" type="button" data-ag-open-form="1">+ 添加自定义助手</button>
        </footer>`
      : `<footer class="ag-foot">
          <div class="ag-add-disabled" title="更新并重启指挥台后台程序后，可在这里接入 Kimi、GLM 等命令行助手">
            <span>+ 添加自定义助手</span>
            <em>需要更新</em>
          </div>
        </footer>`;

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
      <div class="ag-list">${cardsHtml}</div>
      ${footHtml}`;
  }

  async function refreshList(renderAfter = true) {
    if (!hasListApi()) {
      renderEntry();
      if (renderAfter && panelOpen && !formOpen) renderDrawer();
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
      if (confirmingDeleteId && !agents.some((a) => a.id === confirmingDeleteId)) {
        confirmingDeleteId = '';
      }
      hooks.onUpdate(agents);
    } catch (e) {
      loadError = (e && e.message) ? e.message : '读取助手名单出错，请稍后再试。';
      loaded = true;
    }
    renderEntry();
    if (renderAfter && panelOpen) {
      if (formOpen) {
        syncFormWidgets();
        return;
      }
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
    if (st.saving) return;

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

  function openAddForm() {
    if (!hasAddApi()) return;
    flushPendingFields();
    confirmingDeleteId = '';
    ensureDraft();
    formError = '';
    formOpen = true;
    renderDrawer();
    requestAnimationFrame(() => {
      const nameInput = $('#agf-name');
      if (nameInput) nameInput.focus();
    });
  }

  function closeAddForm(resetDraft = false) {
    if (formSaving) return;
    formOpen = false;
    formError = '';
    if (resetDraft) {
      formDraft = null;
      formAdvancedOpen = false;
    }
    renderDrawer();
  }

  async function submitAddForm() {
    if (formSaving) return;
    if (!hasAddApi()) {
      showFormError('当前后台程序还不支持添加自定义助手，请更新后重试。');
      return;
    }
    const d = ensureDraft();
    const name = d.name.trim();
    if (!name) {
      showFormError('请先填写助手的名字（例如 Kimi、GLM）。', '#agf-name');
      return;
    }
    const command = d.command.trim();
    if (!command) {
      showFormError('请填写这个命令行工具的程序路径或命令名。', '#agf-command');
      return;
    }
    if (!d.idTouched && !d.id.trim()) {
      d.id = suggestAgentId(name, command);
    }
    const id = d.id.trim().toLowerCase();
    if (!id) {
      showFormError('请填写助手编号（只能用小写英文字母、数字和短横线）。', '#agf-id', true);
      return;
    }
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(id)) {
      showFormError('编号格式不正确：只能包含小写英文字母、数字和短横线，且以字母或数字开头和结尾（例如 kimi 或 glm-cli）。', '#agf-id', true);
      return;
    }
    if (agents.some((a) => String(a.id || '').toLowerCase() === id)) {
      showFormError(`名单里已经有编号为「${id}」的助手了，请换一个编号。`, '#agf-id', true);
      return;
    }

    const color = normalizeHex6(d.color, true);
    if (!color) {
      showFormError('颜色格式不正确：请填写 # 开头的 6 位十六进制色号（例如 #6b4fa2），或点选上方预设色块。', '#agf-color');
      return;
    }
    d.color = color;

    const parsedArgs = parseCliArgs(d.args);
    if (!parsedArgs.ok) {
      showFormError('启动参数里的引号没有成对闭合，请补全或去掉多余的引号。', '#agf-args', true);
      return;
    }
    const parsedResume = parseCliArgs(d.resumeArgs);
    if (!parsedResume.ok) {
      showFormError('接着对话的参数里引号没有成对闭合，请补全或去掉多余的引号。', '#agf-resume-args', true);
      return;
    }

    const def = {
      id,
      name,
      command,
      args: parsedArgs.list,
      input: d.input === 'arg' ? 'arg' : 'stdin',
      output: d.output === 'jsonl' ? 'jsonl' : 'text',
      color,
      role: d.role.trim(),
    };
    if (parsedResume.list.length > 0) {
      def.resumeArgs = parsedResume.list;
    }

    formSaving = true;
    formError = '';
    renderDrawer();

    try {
      const err = await api.addAgent(def);
      if (err) {
        formSaving = false;
        formError = String(err);
        renderDrawer();
        return;
      }
      formSaving = false;
      formOpen = false;
      formAdvancedOpen = false;
      formDraft = null;
      formError = '';
      await refreshList(false);
      setFeedback(id, 'saved', '已添加到名单');
      renderDrawer();
      requestAnimationFrame(() => {
        const card = $('#agents-drawer')?.querySelector(`.ag-card[data-ag-card="${CSS.escape(id)}"]`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    } catch (e) {
      formSaving = false;
      formError = (e && e.message) ? e.message : '添加失败，请稍后再试。';
      renderDrawer();
    }
  }

  async function confirmRemoveAgent(id) {
    if (deletingId) return;
    const item = agents.find((a) => a.id === id);
    if (!item || !item.custom) return;
    if (!hasRemoveApi()) {
      confirmingDeleteId = '';
      renderDrawer();
      setFeedback(id, 'error', '需要更新后台程序才能删除自定义助手。');
      return;
    }
    deletingId = id;
    renderDrawer();
    try {
      const res = await api.removeAgent(id);
      const errMsg = typeof res === 'string' ? res.trim() : (res && typeof res === 'object' && res.error ? String(res.error) : '');
      deletingId = '';
      confirmingDeleteId = '';
      if (errMsg) {
        renderDrawer();
        setFeedback(id, 'error', errMsg);
        return;
      }
      fieldState.delete(`${id}:role`);
      fieldState.delete(`${id}:model`);
      rowFeedback.delete(id);
      await refreshList(true);
    } catch (e) {
      deletingId = '';
      confirmingDeleteId = '';
      renderDrawer();
      setFeedback(id, 'error', (e && e.message) ? e.message : '删除失败，请重试。');
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
    if (!formOpen) flushPendingFields();
    confirmingDeleteId = '';
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

    drawer.addEventListener('click', (e) => {
      if (e.target.closest('[data-ag-open-form]')) { openAddForm(); return; }
      if (e.target.closest('[data-ag-close-form]')) { closeAddForm(false); return; }
      if (e.target.closest('[data-ag-cancel-form]')) { closeAddForm(true); return; }

      const swBtn = e.target.closest('[data-ag-swatch]');
      if (swBtn && formOpen && formDraft) {
        const hex = swBtn.dataset.agSwatch;
        formDraft.color = hex;
        const hexInput = $('#agf-color', drawer);
        if (hexInput) hexInput.value = hex;
        if (formError) showFormError('');
        syncFormWidgets();
        return;
      }

      const askBtn = e.target.closest('[data-ag-del-ask]');
      if (askBtn) {
        flushPendingFields();
        confirmingDeleteId = askBtn.dataset.agDelAsk;
        renderDrawer();
        return;
      }
      if (e.target.closest('[data-ag-del-cancel]')) {
        confirmingDeleteId = '';
        renderDrawer();
        return;
      }
      const goBtn = e.target.closest('[data-ag-del-confirm]');
      if (goBtn) {
        confirmRemoveAgent(goBtn.dataset.agDelConfirm);
      }
    });

    drawer.addEventListener('toggle', (e) => {
      if (e.target && e.target.id === 'agf-adv') {
        formAdvancedOpen = e.target.open;
      }
    }, true);

    drawer.addEventListener('submit', (e) => {
      if (e.target && e.target.id === 'ag-custom-form') {
        e.preventDefault();
        submitAddForm();
      }
    });

    drawer.addEventListener('change', (e) => {
      const sw = e.target.closest('input[data-ag-toggle]');
      if (sw) { saveToggle(sw.dataset.agToggle, sw.checked, sw); return; }

      if (formOpen && formDraft) {
        if (e.target.id === 'agf-input') {
          formDraft.input = e.target.value === 'arg' ? 'arg' : 'stdin';
          formDraft.inputTouched = true;
          syncFormWidgets();
        } else if (e.target.id === 'agf-output') {
          formDraft.output = e.target.value === 'jsonl' ? 'jsonl' : 'text';
          syncFormWidgets();
        } else if (e.target.id === 'agf-color-picker') {
          formDraft.color = String(e.target.value || '').toLowerCase();
          const hexInput = $('#agf-color', drawer);
          if (hexInput) hexInput.value = formDraft.color;
          if (formError) showFormError('');
          syncFormWidgets();
        }
      }
    });

    drawer.addEventListener('compositionstart', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (!inp) return;
      const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
      if (st) st.composing = true;
    });

    drawer.addEventListener('compositionend', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (inp) {
        const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
        if (st) st.composing = false;
        scheduleField(inp.dataset.agId, inp.dataset.agField, 400);
        return;
      }
      if (formOpen && formDraft && e.target.closest('#ag-custom-form')) {
        syncFormWidgets();
      }
    });

    drawer.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (inp) {
        const st = fieldState.get(`${inp.dataset.agId}:${inp.dataset.agField}`);
        if (st && st.composing) return;
        scheduleField(inp.dataset.agId, inp.dataset.agField, 480);
        return;
      }

      if (!formOpen || !formDraft) return;
      const t = e.target;
      if (t.id === 'agf-name') formDraft.name = t.value;
      else if (t.id === 'agf-command') formDraft.command = t.value;
      else if (t.id === 'agf-role') formDraft.role = t.value;
      else if (t.id === 'agf-color') formDraft.color = t.value;
      else if (t.id === 'agf-color-picker') {
        formDraft.color = String(t.value || '').toLowerCase();
        const hexInput = $('#agf-color', drawer);
        if (hexInput) hexInput.value = formDraft.color;
      } else if (t.id === 'agf-id') {
        formDraft.id = t.value;
        formDraft.idTouched = t.value.trim().length > 0;
      } else if (t.id === 'agf-args') {
        formDraft.args = t.value;
        // 如果用户在参数里写了 {prompt} 且还没手动改过输入方式，自动帮他选成「作为参数」
        if (!formDraft.inputTouched && t.value.includes('{prompt}') && formDraft.input !== 'arg') {
          formDraft.input = 'arg';
          const sel = $('#agf-input', drawer);
          if (sel) sel.value = 'arg';
        }
      } else if (t.id === 'agf-resume-args') {
        formDraft.resumeArgs = t.value;
      } else {
        return;
      }

      if (formError) showFormError('');
      if (!e.isComposing) syncFormWidgets();
    });

    drawer.addEventListener('focusout', (e) => {
      const inp = e.target.closest('input[data-ag-field]');
      if (inp) {
        commitField(inp.dataset.agId, inp.dataset.agField);
        return;
      }
      if (formOpen && formDraft && e.target.id === 'agf-color') {
        const normalized = normalizeHex6(e.target.value, true);
        if (normalized && e.target.value !== normalized) {
          e.target.value = normalized;
          formDraft.color = normalized;
          syncFormWidgets();
        }
      }
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
        if (formOpen) {
          e.preventDefault();
          closeAddForm(false);
          return;
        }
        if (confirmingDeleteId) {
          e.preventDefault();
          confirmingDeleteId = '';
          renderDrawer();
          return;
        }
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
