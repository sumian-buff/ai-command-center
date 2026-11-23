// AI指挥台 · 提示音：现场合成，不需要音频文件
// 三种声音在音高走向、音色、长短上都不一样：
//   done      某个助手完成一项：短促清脆，两个音往上走
//   attention 某个助手卡住 / 等你选择 / 可能跑偏：低沉，两个音往下走，稍长
//   celebrate 全部完成：一串往上走的琶音，加一点闪光尾音
(function () {
  let ctx = null;
  const audio = () => {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  // 一个音：频率、开始时间、时长、音色、音量
  function tone(freq, at, dur, type, gain) {
    const c = audio();
    const t0 = c.currentTime + at;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const SOUNDS = {
    // 叮～咚（往上走，正弦波，清脆）
    done() {
      tone(1046.5, 0, 0.16, 'sine', 0.16);   // C6
      tone(1318.5, 0.09, 0.26, 'sine', 0.14); // E6
    },
    // 咚…咚（往下走，三角波，低沉稍长）
    attention() {
      tone(493.9, 0, 0.32, 'triangle', 0.22);   // B4
      tone(392.0, 0.22, 0.45, 'triangle', 0.22); // G4
    },
    // 大功告成：C-E-G-C 琶音 + 高音闪光
    celebrate() {
      const notes = [523.3, 659.3, 784.0, 1046.5];
      notes.forEach((f, i) => tone(f, i * 0.09, 0.42, 'triangle', 0.15));
      tone(1046.5, 0.36, 0.7, 'sine', 0.12);
      [2093, 2637, 3136].forEach((f, i) => tone(f, 0.46 + i * 0.07, 0.25, 'sine', 0.05));
    },
  };

  // 打字声：很轻、很短的「哒」，音高略有随机，像机械键盘。每秒最多十几下，不会连成噪音
  let keyAcc = 0, lastKey = 0;
  function keyClick() {
    const c = audio();
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const filt = c.createBiquadFilter();
    const g = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1600 + Math.random() * 900, t0);
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(2400 + Math.random() * 800, t0);
    filt.Q.value = 1.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.035, t0 + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.028);
    osc.connect(filt).connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + 0.04);
  }

  window.consoleSound = {
    play(name) { try { (SOUNDS[name] || SOUNDS.done)(); } catch {} },
    // 打出了 n 个字：大约每 3 个字响一下，两下之间至少隔 60 毫秒
    key(n) {
      keyAcc = Math.min(keyAcc + n, 12);
      const now = performance.now();
      if (keyAcc >= 3 && now - lastKey > 60) {
        keyAcc -= 3;
        lastKey = now;
        try { keyClick(); } catch {}
      }
    },
  };
})();
