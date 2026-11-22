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

  window.consoleSound = {
    play(name) { try { (SOUNDS[name] || SOUNDS.done)(); } catch {} },
  };
})();
