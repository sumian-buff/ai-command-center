// Only loaded when AICONSOLE_RECORD is set. All scene content comes from the normal renderer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const FPS = 30;
const env = (key) => process.env['AICONSOLE_RECORD' + key]?.trim();
const choiceRun = 'promo-choice';
const choiceAgent = 'Codex·片尾标语';

function settings() {
  const size = /^(\d+)x(\d+)$/i.exec(env('_SIZE') || '1920x1080');
  if (!size) throw new Error('AICONSOLE_RECORD_SIZE 必须是 宽x高');
  const [width, height] = size.slice(1).map(Number);
  if (![width, height].every((n) => n >= 2 && n <= 8192 && n % 2 === 0)) {
    throw new Error('H.264 录制要求宽高为 2 至 8192 的偶数');
  }
  const seconds = Number(env('_SECONDS') || 72);
  const zoom = Number(env('_ZOOM') || 1);
  if (!(seconds >= 1 / FPS && seconds <= 3600 && zoom >= 0.5 && zoom <= 3)) {
    throw new Error('录制时长或缩放无效');
  }
  const mode = env('_COOL') || '1';
  if (!['0', '1'].includes(mode)) throw new Error('AICONSOLE_RECORD_COOL 必须为 0 或 1');
  const output = path.resolve(env(''));
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('请指定 .mp4 输出文件');
  const ready = env('_READY') && path.resolve(env('_READY'));
  const trace = env('_TRACE') && path.resolve(env('_TRACE'));
  const click = env('_CLICK') && path.resolve(env('_CLICK'));
  const run = env('_RUN') || null;
  const hideSidebar = env('_HIDE_SIDEBAR') === '1', sidebarOnly = env('_SIDEBAR_ONLY') === '1';
  if (hideSidebar && sidebarOnly) throw new Error('不能同时隐藏和单独拍摄侧栏');
  if (click && (run !== choiceRun || !trace || sidebarOnly)) throw new Error('选项点击需要指定 promo-choice 任务、可见卡片和 TRACE 文件');
  const files = [output, ready, trace, click].filter(Boolean);
  if (new Set(files.map((f) => f.toLowerCase())).size !== files.length) throw new Error('输出文件路径重复');
  for (const file of files) {
    if (fs.existsSync(file)) throw new Error('输出文件已存在：' + file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  return { width, height, zoom, frameCount: Math.round(seconds * FPS), cool: mode === '1',
    run, output, ready, trace, click, hideSidebar, sidebarOnly };
}

function writeJSON(file, value) {
  const part = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(part, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(part, file);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

function fitSurface({ width, height, zoom }, workArea) {
  // Window bounds use desktop DIPs. The offscreen compositor has its own pixel density.
  // Keep the same phone layout even on a display shorter than 1280 DIPs.
  const layoutScale = height > width ? 1.5 : 1;
  const minimumDensity = Math.max(layoutScale, width / workArea.width, height / workArea.height);
  let density = layoutScale;
  if (density < minimumDensity || !Number.isInteger(width / density) || !Number.isInteger(height / density)) {
    density = Math.ceil(minimumDensity);
  }
  const windowWidth = Math.ceil(width / density);
  const windowHeight = Math.ceil(height / density);
  return { windowWidth, windowHeight, density, pageZoom: zoom * layoutScale / density,
    bitmapWidth: windowWidth * density, bitmapHeight: windowHeight * density };
}

// Runs in the page's main world so selection, theme and sound use the same paths as the desktop app.
async function preparePage({ run, cool: isCool, surface, collect, hideSidebar, sidebarOnly }) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = performance.now() + 10000;
  const viewportReady = () => Math.abs(innerWidth * surface.pageZoom - surface.windowWidth) <= surface.pageZoom &&
    Math.abs(innerHeight * surface.pageZoom - surface.windowHeight) <= surface.pageZoom;
  while ((!knownRunsReady || busy || !viewportReady()) && performance.now() < until) await sleep(20);
  if (!viewportReady()) throw new Error('录制视口未就绪：实际界面 ' + innerWidth + 'x' + innerHeight +
    ' CSS 像素，计划窗口 ' + surface.windowWidth + 'x' + surface.windowHeight + '，页面缩放 ' + surface.pageZoom);
  if (!knownRunsReady || busy) throw new Error('指挥台任务列表未就绪');
  if (run && !(await api.listRuns()).some((r) => r.id === run)) throw new Error('找不到录制任务：' + run);
  if (run) { followLatest = false; selected = run; }
  document.documentElement.classList.toggle('promo-hide-sidebar', hideSidebar);
  document.documentElement.classList.toggle('promo-sidebar-only', sidebarOnly);
  cool = isCool;
  soundOn = true;
  typeSoundOn = false;
  applyCool();
  await tick();
  if (run && currentRun?.id !== run) throw new Error('录制任务未显示');
  if (isCool && document.hidden) throw new Error('录制窗口不可见，逐字动画未激活');
  if (isCool) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) window.__promoLostVisibility = true;
    });
  }
  await document.fonts.ready;
  if (!collect) return;

  const states = [], sounds = [], activity = [];
  const clock = () => performance.timeOrigin + performance.now();
  const pixelsPerCssPixel = surface.density * surface.pageZoom;
  function rect(node) {
    if (!node || !node.getClientRects().length) return null;
    const box = node.getBoundingClientRect();
    return Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Math.round(box[k] * pixelsPerCssPixel)]));
  }
  let lastState = '', lastActivity = 0;
  function sample() {
    const at = clock();
    const cards = [...document.querySelectorAll('#wall > .tile')];
    const state = {
      run: currentRun?.id || null,
      sidebar: rect(document.querySelector('#sidebar')),
      header: { title: rect(document.querySelector('.mission-title')), controls: rect(document.querySelector('.switches')) },
      projects: [...document.querySelectorAll('#runs .proj')].map((p) => ({
        name: p.querySelector('.p-name')?.textContent || '', rect: rect(p),
      })),
      folded: { rect: rect(document.querySelector('#folded')), names: [...document.querySelectorAll('[data-unfold]')].map((e) => e.dataset.unfold) },
      tiles: cards.map((el) => {
        const agent = currentRun?.agents.find((a) => a.name === el.dataset.name);
        return { name: el.dataset.name, status: agent?.status, tokens: agent?.tokens ?? null, rect: rect(el),
          choices: [...el.querySelectorAll('button[data-choose]')].map((b) => ({
            text: b.textContent, full: b.dataset.full, active: b.matches(':active'), rect: rect(b),
          })) };
      }),
    };
    const signature = JSON.stringify(state);
    if (signature !== lastState) { states.push({ at, ...state }); lastState = signature; }
    if (at - lastActivity >= 240) {
      activity.push({ at, tiles: cards.map((el) => ({
        name: el.dataset.name, length: el.querySelector('.t-term').textContent.length, typing: Boolean(el._typing),
      })) });
      lastActivity = at;
    }
  }
  const originalPlay = window.consoleSound.play;
  window.consoleSound.play = function (name) {
    sounds.push({ at: clock(), name });
    return originalPlay.call(this, name);
  };
  sample();
  const interval = setInterval(sample, 100);
  window.__finishPromoCapture = () => {
    clearInterval(interval);
    sample();
    return { states, sounds, activity };
  };
}

function relativeTimes(entries, startedAt, duration, includeInitial) {
  const rows = entries.filter(({ at }) => at >= startedAt && at < startedAt + duration * 1000);
  if (includeInitial) {
    const initial = entries.filter(({ at }) => at <= startedAt).at(-1);
    if (initial && !rows.includes(initial)) rows.unshift(initial);
  }
  return rows.map(({ at, ...data }) => ({ t: Math.max(0, Math.round(at - startedAt) / 1000), ...data }));
}

// Runs in the renderer. Measure the actual native controls and log input received by Chromium.
function observeChoice({ run, name, surface }) {
  const clicks = [];
  const clock = () => performance.timeOrigin + performance.now();
  let visibleSince = null;
  function hitTest(button) {
    const r = button.getBoundingClientRect();
    if (button.disabled || r.width < 4 || r.height < 4 ||
        r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
    // The choices tray can itself scroll. Test all four corners inside the rounded border.
    const inset = Math.min(7, r.width / 4, r.height / 4);
    return [r.left + inset, r.right - inset].every(x => [r.top + inset, r.bottom - inset].every(y =>
      button.contains(document.elementFromPoint(x, y))));
  }
  window.__promoChoicePoint = () => {
    const buttons = [...document.querySelectorAll('#wall button[data-choose]')];
    if (currentRun?.id !== run || currentRun.agents.find(a => a.name === name)?.status !== 'question' ||
        buttons.length !== 3 || !buttons.every((b, i) => b.dataset.name === name && b.dataset.choose === String(i) && hitTest(b))) {
      visibleSince = null;
      return null;
    }
    const now = clock();
    if (visibleSince === null) visibleSince = now;
    if (now - visibleSince < 2200) return null;
    const last = buttons[2], r = last.getBoundingClientRect();
    // sendInputEvent takes host DIPs, while DOM boxes use CSS pixels. OSR density only affects the movie.
    return { x: Math.round((r.x + r.width / 2) * surface.pageZoom),
      y: Math.round((r.y + r.height / 2) * surface.pageZoom), text: last.dataset.full };
  };
  function log(type, b) {
    const box = b.getBoundingClientRect(), scale = surface.density * surface.pageZoom;
    const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.round(box[k] * scale)]));
    clicks.push({ at: clock(), type, index: Number(b.dataset.choose), name: b.dataset.name, text: b.dataset.full, rect });
  }
  for (const type of ['mousedown', 'mouseup', 'click']) {
    document.addEventListener(type, e => {
      const button = e.target.closest?.('#wall button[data-choose="2"]');
      if (!e.isTrusted || !button || button.dataset.name !== name || currentRun?.id !== run || e.button !== 0) {
        // No other control may act on the automated input, even if the window layout changes mid-click.
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      log(type, button);
      if (type === 'mousedown') requestAnimationFrame(() => {
        if (button.matches(':active')) log('active', button);
      });
    }, true);
  }
  window.__promoChoiceActive = () => clicks.some(c => c.type === 'active');
  window.__promoChoiceClicks = () => clicks;
}

function choiceInput(config, surface) {
  let point = null, nextCheck = 0, released = false, confirmed = false;
  return {
    async install(wc) {
      await wc.executeJavaScript('(' + observeChoice.toString() + ')(' +
        JSON.stringify({ run: choiceRun, name: choiceAgent, surface }) + ')');
    },
    async step(wc) {
      const now = performance.now();
      if (released || now < nextCheck) return;
      if (point) {
        if (!await wc.executeJavaScript('window.__promoChoiceActive()')) throw new Error('第三个按钮未进入真实按下状态');
        released = true;
        wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        return;
      }
      nextCheck = now + 100;
      point = await wc.executeJavaScript('window.__promoChoicePoint()');
      if (!point) return;
      wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
      wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', modifiers: ['leftButtonDown'], clickCount: 1 });
      nextCheck = performance.now() + 360;
    },
    reply(run, name, text) {
      if (confirmed || !released || run !== choiceRun || name !== choiceAgent || text !== '我选第 3 个：' + point?.text) {
        throw new Error('录制窗口收到不匹配的选项回复');
      }
      writeJSON(config.click, { at: Date.now(), run, name, text, index: 2 });
      confirmed = true;
      return true;
    },
    async finish(wc) {
      const received = await wc.executeJavaScript('window.__promoChoiceClicks()');
      if (!confirmed || received.map(c => c.type).join(',') !== 'mousedown,active,mouseup,click') {
        throw new Error('录制未收到第三项完整的原生点击与回复');
      }
      return received;
    },
  };
}

function configure(app) {
  const config = settings();
  // The launcher also puts --no-sandbox on Electron's command line, before Windows starts Chromium.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const profile = env('_PROFILE') ? path.resolve(env('_PROFILE')) : fs.mkdtempSync(path.join(os.tmpdir(), 'aiconsole-record-'));
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);

  let surface, choice;
  return {
    reply(run, name, text) {
      // Recording the original button goes through the real UI and preload. Only the local replay consumes it.
      if (!choice) throw new Error('本次录制没有安排回复');
      return choice.reply(run, name, text);
    },
    windowOptions(base, workArea) {
      surface = fitSurface(config, workArea);
      return { ...base, x: workArea.x, y: workArea.y, width: surface.windowWidth, height: surface.windowHeight,
        minWidth: 1, minHeight: 1,
        show: false, frame: false, useContentSize: true, enableLargerThanScreen: true,
        paintWhenInitiallyHidden: true, webPreferences: { ...base.webPreferences,
          offscreen: { deviceScaleFactor: surface.density }, backgroundThrottling: false, partition: 'promo-recording' } };
    },
    async record(win, page) {
      const wc = win.webContents;
      wc.setFrameRate(FPS);
      // Muting suppresses monitor playback. The renderer still receives and plays its native cues.
      wc.setAudioMuted(true);
      await win.loadFile(page);
      wc.setZoomFactor(surface.pageZoom);
      await wc.executeJavaScript('(' + preparePage.toString() + ')(' + JSON.stringify({
        run: config.run, cool: config.cool, surface, collect: Boolean(config.trace),
        hideSidebar: config.hideSidebar, sidebarOnly: config.sidebarOnly,
      }) + ')', true);
      if (config.click) {
        choice = choiceInput(config, surface);
        await choice.install(wc);
      }
      await delay(120);
      await capture(wc, config, surface, choice);
    },
  };
}

async function capture(wc, { width, height, frameCount, zoom, output, ready, trace }, surface, choice) {
  const { bitmapWidth, bitmapHeight } = surface;
  async function grab() {
    const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    // Electron 45 capturePage wraps the full compositor bitmap in a 1x NativeImage.
    const size = image.getSize(1);
    if (image.isEmpty() || size.width !== bitmapWidth || size.height !== bitmapHeight) {
      throw new Error('窗口帧尺寸不符：' + JSON.stringify(size) + '，需要 ' + bitmapWidth + 'x' + bitmapHeight +
        '（窗口 ' + surface.windowWidth + 'x' + surface.windowHeight + '，离屏倍率 ' + surface.density + '）');
    }
    const data = image.toBitmap({ scaleFactor: 1 });
    if (data.length !== bitmapWidth * bitmapHeight * 4) throw new Error('窗口未返回完整 BGRA 像素');
    return data;
  }
  const first = await grab();
  const part = output + '.' + randomUUID() + '.tmp.mp4';
  // A custom output not divisible by the density may have a few surplus pixels at the far edges.
  const crop = bitmapWidth === width && bitmapHeight === height ? '' : 'crop=' + width + ':' + height + ':0:0,';
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
    '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', bitmapWidth + 'x' + bitmapHeight,
    '-framerate', String(FPS), '-i', 'pipe:0', '-an', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '16', '-vf', crop + 'scale=out_color_matrix=bt709', '-pix_fmt', 'yuv420p',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-movflags', '+faststart', part], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let encoderError, stderr = '';
  ff.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  ff.stdin.on('error', (e) => { encoderError = e; });
  ff.on('error', (e) => { encoderError = e; });
  const closed = new Promise((resolve) => ff.once('close', (code) => {
    if (code !== 0) encoderError = new Error(stderr.trim() || 'ffmpeg 退出码 ' + code, { cause: encoderError });
    resolve(code);
  }));
  let framesWritten = 0, heldFrames = 0, consecutiveHeld = 0, maxHeld = 0, maxQueuedBytes = 0;
  function write(frame, repeated) {
    if (encoderError) throw encoderError;
    maxQueuedBytes = Math.max(maxQueuedBytes, ff.stdin.writableLength);
    if (ff.stdin.writableLength > first.length * 16) throw new Error('编码器跟不上实时录制，待写帧超过 16 帧');
    ff.stdin.write(frame);
    framesWritten++;
    if (repeated) { heldFrames++; consecutiveHeld++; } else { consecutiveHeld = 0; }
    maxHeld = Math.max(maxHeld, consecutiveHeld);
  }
  try {
    const startedAt = Date.now(), start = performance.now();
    const duration = frameCount / FPS;
    write(first, false);
    if (ready) writeJSON(ready, { startedAt, width, height, fps: FPS, frameCount });
    let previous = first;
    // Schedule *requests* on the 30 Hz clock. Assigning frames by their completion time instead
    // would drop alternating slots when copying the pixels takes just over half a frame.
    while (framesWritten < frameCount) {
      const wait = start + framesWritten * 1000 / FPS - performance.now();
      if (wait > 0) await delay(wait);
      if (choice) await choice.step(wc);
      const slot = Math.min(frameCount, Math.floor((performance.now() - start) * FPS / 1000));
      while (framesWritten < slot) write(previous, true);
      if (framesWritten < frameCount) {
        previous = await grab();
        write(previous, false);
      }
    }
    const tail = start + duration * 1000 - performance.now();
    if (tail > 0) await delay(tail);
    ff.stdin.end();
    await wc.executeJavaScript("if (window.__promoLostVisibility || (document.body.classList.contains('cool') && document.hidden)) throw new Error('录制过程中窗口不可见，逐字动画已暂停')");
    const observed = trace && await wc.executeJavaScript('window.__finishPromoCapture()');
    const clicks = choice ? await choice.finish(wc) : [];
    await closed;
    if (encoderError) throw encoderError;
    if (observed) {
      writeJSON(trace, { startedAt, width, height, fps: FPS, frameCount, zoom, surface,
        states: relativeTimes(observed.states, startedAt, duration, true),
        sounds: relativeTimes(observed.sounds, startedAt, duration, false),
        clicks: relativeTimes(clicks, startedAt, duration, false),
        activity: relativeTimes(observed.activity, startedAt, duration, true),
        capture: { framesWritten, heldFrames, maxConsecutiveHeld: maxHeld, maxQueuedBytes } });
    }
    fs.renameSync(part, output);
  } finally {
    if (ff.exitCode === null && ff.signalCode === null) ff.kill();
    await closed;
    fs.rmSync(part, { force: true });
  }
}

module.exports = { configure };
