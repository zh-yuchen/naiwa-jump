/* =============================================================
 *  奶娃跳一跳  ·  game.js
 *  单指长按蓄力 → 抛物线跳跃 → 平台落点判定 → 完美连击计分
 *  纯 2D Canvas，无任何外部依赖（美术全部程序化绘制）
 * ============================================================= */
(function () {
'use strict';

/* ------------------------------------------------------------
 * 0. 基础工具
 * ---------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rr = Math.min(typeof r === 'number' ? r : 6, Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + rr, y);
    this.lineTo(x + w - rr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + rr);
    this.lineTo(x + w, y + h - rr);
    this.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    this.lineTo(x + rr, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - rr);
    this.lineTo(x, y + rr);
    this.quadraticCurveTo(x, y, x + rr, y);
    this.closePath();
    return this;
  };
}

/* ------------------------------------------------------------
 * 1. 本地存档（最高分 / 连击 / 排行榜 / 设置）
 * ---------------------------------------------------------- */
const KEY = 'naiwa.jump.v1';
const Store = {
  data: { best: 0, bestCombo: 0, board: [], aid: true, muted: false, plays: 0 },
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) Object.assign(this.data, JSON.parse(raw));
    } catch (e) { /* 隐私模式 / 无 localStorage 时静默降级 */ }
    if (!Array.isArray(this.data.board)) this.data.board = [];
  },
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch (e) {}
  },
  submit(score, combo) {
    const rec = { score, combo, at: Date.now() };
    this.data.board.push(rec);
    this.data.board.sort((a, b) => b.score - a.score || b.combo - a.combo);
    this.data.board = this.data.board.slice(0, 10);
    this.data.plays++;
    let isNew = false;
    if (score > this.data.best) { this.data.best = score; isNew = true; }
    if (combo > this.data.bestCombo) this.data.bestCombo = combo;
    this.save();
    return isNew;
  }
};
Store.load();

/* ------------------------------------------------------------
 * 2. 音效（Web Audio 实时合成，零素材依赖）+ BGM
 * ---------------------------------------------------------- */
const SFX = {
  ac: null, master: null, muted: Store.data.muted, ready: false,
  init() {
    if (this.ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ac = new AC();
      this.master = this.ac.createGain();
      this.master.gain.value = 0.85;
      this.master.connect(this.ac.destination);
      this.ready = true;
    } catch (e) { this.ready = false; }
  },
  resume() { if (this.ac && this.ac.state === 'suspended') this.ac.resume(); },
  get on() { return this.ready && !this.muted; },

  tone(o) {
    if (!this.on) return;
    const ac = this.ac, t0 = ac.currentTime + (o.delay || 0);
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    const vol = o.vol == null ? 0.22 : o.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (o.atk || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    let tail = osc;
    if (o.fc) {
      const f = ac.createBiquadFilter();
      f.type = o.filter || 'bandpass';
      f.frequency.value = o.fc; f.Q.value = o.q || 1.2;
      osc.connect(f); tail = f;
    }
    tail.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + o.dur + 0.04);
  },

  noise(dur, vol, fc, delay) {
    if (!this.on) return;
    const ac = this.ac, t0 = ac.currentTime + (delay || 0);
    const n = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource(); src.buffer = buf;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = fc || 1400;
    const g = ac.createGain(); g.gain.value = vol == null ? 0.2 : vol;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t0);
  },

  /* 合成人声「哇哦」——两个共振峰滤波的锯齿波 */
  wah() {
    if (!this.on) return;
    const ac = this.ac, t0 = ac.currentTime;
    const out = ac.createGain();
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(0.30, t0 + 0.035);
    out.gain.exponentialRampToValueAtTime(0.20, t0 + 0.16);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.52);
    out.connect(this.master);

    const f1 = ac.createBiquadFilter(); f1.type = 'bandpass'; f1.Q.value = 2.6;
    const f2 = ac.createBiquadFilter(); f2.type = 'bandpass'; f2.Q.value = 5.5;
    f1.frequency.setValueAtTime(760, t0);
    f1.frequency.linearRampToValueAtTime(1040, t0 + 0.12);
    f1.frequency.linearRampToValueAtTime(560, t0 + 0.48);
    f2.frequency.setValueAtTime(1900, t0);
    f2.frequency.linearRampToValueAtTime(2500, t0 + 0.12);
    f2.frequency.linearRampToValueAtTime(1250, t0 + 0.48);

    const o1 = ac.createOscillator(); o1.type = 'sawtooth';
    o1.frequency.setValueAtTime(430, t0);
    o1.frequency.linearRampToValueAtTime(620, t0 + 0.11);
    o1.frequency.linearRampToValueAtTime(300, t0 + 0.5);
    const o2 = ac.createOscillator(); o2.type = 'sine';
    o2.frequency.setValueAtTime(215, t0);
    o2.frequency.linearRampToValueAtTime(310, t0 + 0.11);
    o2.frequency.linearRampToValueAtTime(150, t0 + 0.5);

    const mix = ac.createGain(); mix.gain.value = 0.5;
    o1.connect(mix); o2.connect(mix);
    mix.connect(f1); mix.connect(f2);
    f1.connect(out); f2.connect(out);
    o1.start(t0); o2.start(t0);
    o1.stop(t0 + 0.6); o2.stop(t0 + 0.6);
  },

  jump(power) {
    this.tone({ type: 'triangle', f0: 180 + power * 200, f1: (180 + power * 200) * 2.6, dur: 0.18, vol: 0.16 });
    this.noise(0.06, 0.09, 2600);
  },
  tick(step) {
    this.tone({ type: 'square', f0: 520 + step * 26, dur: 0.045, vol: 0.055, fc: 1200, filter: 'bandpass' });
  },
  land() {
    this.tone({ type: 'sine', f0: 160, f1: 78, dur: 0.16, vol: 0.24 });
    this.noise(0.1, 0.14, 900);
  },
  perfect(combo) {
    this.wah();
    const base = 660 * Math.pow(1.0595, Math.min(combo, 8) * 2);
    [0, 0.075, 0.15].forEach((d, i) => {
      this.tone({ type: 'sine', f0: base * (1 + i * 0.26), f1: base * (1 + i * 0.26) * 1.5, dur: 0.24, vol: 0.16, delay: d });
    });
  },
  abstract() {
    [0, 1, 2, 3].forEach((i) => {
      this.tone({ type: 'square', f0: 300 + i * 90, f1: 240 + i * 90, dur: 0.11, vol: 0.10, delay: i * 0.075, fc: 900, filter: 'lowpass', q: 3 });
    });
  },
  fail() {
    this.tone({ type: 'sawtooth', f0: 420, f1: 82, dur: 0.7, vol: 0.24, fc: 900, filter: 'lowpass', q: 2 });
    this.tone({ type: 'sine', f0: 200, f1: 60, dur: 0.9, vol: 0.18, delay: 0.1 });
    this.noise(0.5, 0.1, 500, 0.05);
  },
  ui() { this.tone({ type: 'sine', f0: 700, f1: 1050, dur: 0.1, vol: 0.14 }); },

  bgm: null,
  bgmStart() {
    if (!this.bgm) {
      this.bgm = new Audio('assets/bgm.mp3');
      this.bgm.loop = true;
      this.bgm.volume = 0.0;
      this.bgm.preload = 'auto';
    }
    this.bgm.muted = this.muted;
    const p = this.bgm.play();
    if (p && p.catch) p.catch(() => {});
    this.fadeBgm(this.muted ? 0 : 0.32);
  },
  fadeBgm(to) {
    if (!this.bgm) return;
    const from = this.bgm.volume, t0 = performance.now(), dur = 600;
    const step = () => {
      const k = clamp((performance.now() - t0) / dur, 0, 1);
      this.bgm.volume = clamp(lerp(from, to, k), 0, 1);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  },
  toggleMute() {
    this.muted = !this.muted;
    Store.data.muted = this.muted; Store.save();
    Snd.setMuted(this.muted);
    if (this.bgm) { this.bgm.muted = this.muted; if (!this.muted) this.bgmStart(); else this.fadeBgm(0); }
    return this.muted;
  }
};

/* ------------------------------------------------------------
 * 2b. Kenney CC0 音效池
 *     做法参考 Starter-Kit-3D-Platformer 的 scripts/audio.gd：
 *     复用一组播放器 + 每次随机音高(0.9~1.1)，避免连击时听起来发死
 * ---------------------------------------------------------- */
const Snd = {
  FILES: {
    jump: 'assets/sfx/jump.mp3',
    land: 'assets/sfx/land.mp3',
    coin: 'assets/sfx/coin.mp3',
    fall: 'assets/sfx/fall.mp3',
    break: 'assets/sfx/break.mp3'
  },
  POOL: 4,
  pools: {},
  ready: false,
  volume: 0.5,
  init() {
    if (this.ready) return;
    this.ready = true;
    for (const k in this.FILES) {
      const arr = [];
      for (let i = 0; i < this.POOL; i++) {
        const a = new Audio(this.FILES[k]);
        a.preload = 'auto';
        a.volume = this.volume;
        arr.push(a);
      }
      this.pools[k] = arr;
    }
  },
  play(name, vol, rate) {
    if (Store.data.muted) return;
    this.init();
    const pool = this.pools[name];
    if (!pool) return;
    let a = null;
    for (const c of pool) { if (c.paused || c.ended) { a = c; break; } }
    if (!a) a = pool[0];
    try {
      a.currentTime = 0;
      a.playbackRate = clamp(rate || rand(0.9, 1.1), 0.5, 2);
      a.volume = clamp(vol == null ? this.volume : vol, 0, 1);
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* 音频不可用时静默 */ }
  },
  setMuted(m) { if (m) for (const k in this.pools) this.pools[k].forEach((a) => a.pause()); }
};

/* ------------------------------------------------------------
 * 3. 表情定义 + 程序化「奶娃」矢量绘制
 * ---------------------------------------------------------- */
const EXPR = [
  { key: 'happy',  name: '开心', top: '#ffc044', side: '#ffa33b', dark: '#d9835c' },
  { key: 'meh',    name: '无语', top: '#82aae3', side: '#6794d9', dark: '#5b65c3' },
  { key: 'shock',  name: '震惊', top: '#a878e8', side: '#8b5fd8', dark: '#6e49c4' },
  { key: 'broken', name: '破防', top: '#e8736e', side: '#cf534f', dark: '#9f5b41' }
];
const EXPR_INDEX = { happy: 0, meh: 1, shock: 2, broken: 3 };

/* Kenney CC0 colormap 调色板 */
const YELLOW_TOP = '#ffdd8a', YELLOW_MID = '#ffc044', YELLOW_LOW = '#ffa33b';
const CREAM = '#fde4c7', EYE_GREEN = '#61cb8b', EYE_GREEN_D = '#2c9571';
const INK = '#38383d', FOOT = '#d9835c';

/* Kenney CC0 贴图（同样来自 Starter Kit 3D Platformer）。
   加载失败就自动退回矢量绘制，不影响游戏。
   注意：主 canvas 一旦 drawImage 外部图片就会被污染，所以成绩卡
   必须继续走 buildShareCard() 里那块「纯程序化绘制」的独立 canvas。 */
const IMG = { shadow: null, particle: null, coin: null };
(function loadSprites() {
  if (typeof Image === 'undefined') return;
  const src = {
    shadow: 'assets/img/blob_shadow.png',
    particle: 'assets/img/particle.png',
    coin: 'assets/img/coin.png'
  };
  for (const k in src) {
    const im = new Image();
    im.onload = () => { IMG[k] = im; };
    im.onerror = () => { IMG[k] = null; };
    im.src = src[k];
  }
})();

/* 画「奶娃」身体。x,y = 脚底中心；h = 身高；expr = 表情 key */
function drawNaiwa(g, x, y, h, expr, opts) {
  opts = opts || {};
  const t = opts.t || 0;
  const w = h * 0.66;
  const look = opts.look == null ? 0 : clamp(opts.look, -1, 1);
  const sx = opts.sx == null ? 1 : opts.sx;
  const sy = opts.sy == null ? 1 : opts.sy;
  const blink = opts.blink || 0;

  g.save();
  g.translate(x, y);
  g.scale(sx, sy);

  /* 脚 */
  g.fillStyle = FOOT;
  [-1, 1].forEach((s) => {
    g.beginPath();
    g.ellipse(s * w * 0.26, -h * 0.018, w * 0.22, h * 0.05, 0, 0, TAU);
    g.fill();
  });

  /* 手臂 */
  g.fillStyle = FOOT;
  [-1, 1].forEach((s) => {
    const swing = opts.armSwing == null ? 0 : opts.armSwing;
    g.save();
    g.translate(s * w * 0.82, -h * 0.34 + swing * h * 0.06);
    g.rotate(s * (0.25 + swing * 0.5));
    g.beginPath();
    g.ellipse(0, 0, h * 0.075, h * 0.15, 0, 0, TAU);
    g.fill();
    g.restore();
  });

  /* 身体 */
  const bodyGrad = g.createLinearGradient(0, -h, 0, 0);
  bodyGrad.addColorStop(0, YELLOW_TOP);
  bodyGrad.addColorStop(0.45, YELLOW_MID);
  bodyGrad.addColorStop(1, YELLOW_LOW);
  g.beginPath();
  g.moveTo(0, -h * 0.99);
  g.bezierCurveTo(w * 0.70, -h * 0.97, w * 0.90, -h * 0.60, w * 0.88, -h * 0.28);
  g.bezierCurveTo(w * 0.86, -h * 0.02, w * 0.56, h * 0.02, 0, h * 0.02);
  g.bezierCurveTo(-w * 0.56, h * 0.02, -w * 0.86, -h * 0.02, -w * 0.88, -h * 0.28);
  g.bezierCurveTo(-w * 0.90, -h * 0.60, -w * 0.70, -h * 0.97, 0, -h * 0.99);
  g.closePath();
  g.fillStyle = bodyGrad;
  g.fill();
  g.lineWidth = Math.max(1, h * 0.035);
  g.strokeStyle = 'rgba(160,110,0,.30)';
  g.stroke();

  /* 肚皮 */
  g.beginPath();
  g.ellipse(0, -h * 0.28, w * 0.60, h * 0.27, 0, 0, TAU);
  g.fillStyle = 'rgba(255,250,232,.92)';
  g.fill();

  /* 高光 */
  g.beginPath();
  g.ellipse(-w * 0.42, -h * 0.72, w * 0.18, h * 0.14, -0.5, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,.35)';
  g.fill();

  /* ---- 眼睛 ---- */
  const eyeX = w * 0.35, eyeY = -h * 0.635;
  const erx = h * 0.115, ery = h * 0.125;

  [-1, 1].forEach((s) => {
    const cx = s * eyeX;
    g.save();
    g.translate(cx, eyeY);

    const blown = expr === 'shock';
    const rx = erx * (blown ? 1.28 : 1), ry = ery * (blown ? 1.32 : 1);

    if (expr === 'broken') {
      /* 破防：绿眼 + X 眼 */
      g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fillStyle = EYE_GREEN_D; g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, h * 0.055); g.lineCap = 'round';
      const d = h * 0.075;
      g.beginPath();
      g.moveTo(-d, -d); g.lineTo(d, d);
      g.moveTo(d, -d); g.lineTo(-d, d);
      g.stroke();
      /* 眼泪 */
      g.beginPath();
      g.moveTo(s * rx * 0.7, ry * 0.7);
      g.quadraticCurveTo(s * (rx * 0.7 + h * 0.06), ry + h * 0.10, s * rx * 0.55, ry + h * 0.20);
      g.quadraticCurveTo(s * (rx * 0.55 - h * 0.05), ry + h * 0.10, s * rx * 0.7, ry * 0.7);
      g.fillStyle = 'rgba(120,200,255,.9)';
      g.fill();
    } else {
      /* 眼白/绿眼 */
      g.beginPath();
      g.ellipse(0, 0, rx, ry, 0, 0, TAU);
      const eg = g.createLinearGradient(0, -ry, 0, ry);
      eg.addColorStop(0, '#a8d45e'); eg.addColorStop(1, EYE_GREEN_D);
      g.fillStyle = eg; g.fill();

      if (expr === 'happy') {
        /* 开心：弯月眼 */
        g.beginPath();
        g.arc(0, ry * 0.35, rx * 0.80, Math.PI * 1.10, Math.PI * 1.90);
        g.strokeStyle = INK; g.lineWidth = Math.max(1.2, h * 0.062); g.lineCap = 'round';
        g.stroke();
      } else {
        /* 瞳孔 */
        const px = look * rx * 0.30, py = ry * 0.10;
        const pr = (expr === 'shock' ? h * 0.035 : h * 0.058);
        g.beginPath(); g.arc(px, py, pr, 0, TAU); g.fillStyle = '#241c12'; g.fill();
        g.beginPath(); g.arc(px - pr * 0.38, py - pr * 0.42, pr * 0.36, 0, TAU);
        g.fillStyle = 'rgba(255,255,255,.95)'; g.fill();

        if (expr === 'meh') {
          /* 无语：上眼皮压下来 */
          g.beginPath();
          g.moveTo(-rx * 1.05, -ry * 0.28);
          g.quadraticCurveTo(0, -ry * 1.35, rx * 1.05, -ry * 0.28);
          g.lineTo(rx * 1.05, -ry * 1.6);
          g.lineTo(-rx * 1.05, -ry * 1.6);
          g.closePath();
          g.fillStyle = YELLOW_MID;
          g.fill();
          g.beginPath();
          g.moveTo(-rx * 1.02, -ry * 0.30);
          g.quadraticCurveTo(0, -ry * 1.30, rx * 1.02, -ry * 0.30);
          g.strokeStyle = 'rgba(160,110,0,.35)'; g.lineWidth = Math.max(1, h * 0.03);
          g.stroke();
        }
        if (blink > 0) {
          g.beginPath(); g.ellipse(0, 0, rx * 1.06, ry * 1.06, 0, 0, TAU);
          g.fillStyle = YELLOW_MID; g.fill();
        }
      }
    }
    g.restore();
  });

  /* ---- 嘴 ---- */
  const my = -h * 0.435, mw = w * 0.30;
  g.save();
  g.translate(0, my);
  g.strokeStyle = INK; g.fillStyle = INK; g.lineCap = 'round';
  if (expr === 'happy') {
    g.beginPath();
    g.moveTo(-mw, -h * 0.005);
    g.quadraticCurveTo(0, h * 0.115, mw, -h * 0.005);
    g.quadraticCurveTo(0, h * 0.005, -mw, -h * 0.005);
    g.closePath();
    g.fill();
    g.beginPath();
    g.ellipse(0, h * 0.052, mw * 0.42, h * 0.030, 0, 0, TAU);
    g.fillStyle = '#e06a86'; g.fill();
    /* 腮红 */
    g.fillStyle = 'rgba(255,140,150,.34)';
    [-1, 1].forEach((s) => { g.beginPath(); g.ellipse(s * w * 0.66, h * 0.015, w * 0.16, h * 0.055, 0, 0, TAU); g.fill(); });
  } else if (expr === 'meh') {
    g.lineWidth = Math.max(1.2, h * 0.055);
    g.beginPath(); g.moveTo(-mw * 0.85, 0); g.lineTo(mw * 0.85, 0); g.stroke();
  } else if (expr === 'shock') {
    g.beginPath(); g.ellipse(0, h * 0.015, mw * 0.44, h * 0.055, 0, 0, TAU); g.fill();
  } else {
    g.lineWidth = Math.max(1.2, h * 0.055);
    g.beginPath();
    g.moveTo(-mw * 0.8, h * 0.03);
    g.quadraticCurveTo(0, -h * 0.055, mw * 0.8, h * 0.03);
    g.stroke();
  }
  g.restore();

  g.restore();
}

/* 画一个「奶娃表情包」脑袋贴纸。x,y = 中心，r = 半径 */
function drawFace(g, x, y, r, expr, t) {
  g.save();
  g.translate(x, y);

  /* 贴纸底 */
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.97, 0, 0, TAU);
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.fill();
  g.lineWidth = Math.max(1, r * 0.09);
  g.strokeStyle = 'rgba(255,255,255,.95)';
  g.stroke();

  const hh = r * 1.7;
  g.beginPath();
  g.moveTo(0, -r * 0.92);
  g.bezierCurveTo(r * 0.78, -r * 0.90, r * 0.98, -r * 0.20, r * 0.80, r * 0.42);
  g.bezierCurveTo(r * 0.60, r * 0.92, -r * 0.60, r * 0.92, -r * 0.80, r * 0.42);
  g.bezierCurveTo(-r * 0.98, -r * 0.20, -r * 0.78, -r * 0.90, 0, -r * 0.92);
  g.closePath();
  const bg = g.createLinearGradient(0, -r, 0, r);
  bg.addColorStop(0, YELLOW_TOP); bg.addColorStop(1, YELLOW_LOW);
  g.fillStyle = bg; g.fill();

  const eyeX = r * 0.40, eyeY = -r * 0.16;
  const erx = r * 0.20, ery = r * 0.22;
  [-1, 1].forEach((s) => {
    g.save();
    g.translate(s * eyeX, eyeY);
    if (expr === 'broken') {
      g.beginPath(); g.ellipse(0, 0, erx, ery, 0, 0, TAU); g.fillStyle = EYE_GREEN_D; g.fill();
      g.strokeStyle = INK; g.lineWidth = Math.max(1, r * 0.10); g.lineCap = 'round';
      const d = r * 0.15;
      g.beginPath(); g.moveTo(-d, -d); g.lineTo(d, d); g.moveTo(d, -d); g.lineTo(-d, d); g.stroke();
    } else {
      g.beginPath(); g.ellipse(0, 0, erx * (expr === 'shock' ? 1.25 : 1), ery * (expr === 'shock' ? 1.25 : 1), 0, 0, TAU);
      g.fillStyle = EYE_GREEN; g.fill();
      if (expr === 'happy') {
        g.beginPath(); g.arc(0, ery * 0.4, erx * 0.8, Math.PI * 1.10, Math.PI * 1.90);
        g.strokeStyle = INK; g.lineWidth = Math.max(1, r * 0.11); g.lineCap = 'round'; g.stroke();
      } else {
        const pr = r * (expr === 'shock' ? 0.075 : 0.105);
        g.beginPath(); g.arc(0, 0, pr, 0, TAU); g.fillStyle = '#241c12'; g.fill();
        if (expr === 'meh') {
          g.beginPath();
          g.moveTo(-erx * 1.05, -ery * 0.05);
          g.quadraticCurveTo(0, -ery * 1.6, erx * 1.05, -ery * 0.05);
          g.lineTo(erx * 1.05, -ery * 2); g.lineTo(-erx * 1.05, -ery * 2);
          g.closePath(); g.fillStyle = YELLOW_MID; g.fill();
        }
      }
    }
    g.restore();
  });

  const mw = r * 0.42, myy = r * 0.42;
  g.save(); g.translate(0, myy);
  g.strokeStyle = INK; g.fillStyle = INK; g.lineCap = 'round';
  if (expr === 'happy') {
    g.beginPath();
    g.moveTo(-mw, -r * 0.02); g.quadraticCurveTo(0, r * 0.42, mw, -r * 0.02);
    g.quadraticCurveTo(0, r * 0.10, -mw, -r * 0.02);
    g.closePath(); g.fill();
  } else if (expr === 'meh') {
    g.lineWidth = Math.max(1, r * 0.11);
    g.beginPath(); g.moveTo(-mw * 0.9, 0); g.lineTo(mw * 0.9, 0); g.stroke();
  } else if (expr === 'shock') {
    g.beginPath(); g.ellipse(0, 0, r * 0.16, r * 0.20, 0, 0, TAU); g.fill();
  } else {
    g.lineWidth = Math.max(1, r * 0.11);
    g.beginPath(); g.moveTo(-mw * 0.8, r * 0.12); g.quadraticCurveTo(0, -r * 0.20, mw * 0.8, r * 0.12); g.stroke();
  }
  g.restore();
  g.restore();
}

/* ------------------------------------------------------------
 * 4. 舞台 / 视口
 * ---------------------------------------------------------- */
const canvas = $('stage');
const ctx = canvas.getContext('2d');

const VW = 400;                 // 虚拟世界宽度（等比缩放基准）
let VH = 711;                   // 虚拟世界高度（按屏幕比例推算）
let SCALE = 1, DPR = 1;
let GY = 470;                   // 平台顶面 y（世界坐标）
let cssW = 0, cssH = 0;

function resize() {
  const r = canvas.getBoundingClientRect();
  cssW = r.width || window.innerWidth;
  cssH = r.height || window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(cssW * DPR);
  canvas.height = Math.round(cssH * DPR);
  SCALE = cssW / VW;
  VH = cssH / SCALE;
  GY = VH * 0.645;
  if (game.state === 'idle' || game.state === 'charging') {
    game.char.y = GY;
  }
  /* 竖屏才隐藏「请竖屏」提示；横屏(比例 >= 0.92)时显示 */
  document.getElementById('rotate').classList.toggle('hidden', cssW / cssH < 0.92);
}

/* ------------------------------------------------------------
 * 5. 物理常量
 * ---------------------------------------------------------- */
const G = 1500;                 // 重力
const CHAR_H = 34;              // 奶娃身高
const CHAR_W = CHAR_H * 0.66;
const CHARGE_MS = 1200;         // 满蓄力时间
const PLAT_H_MIN = 46;
const EDGE_GRACE = 5;           // 边缘宽容（世界单位）
const MIN_POWER = 0.20;         // 轻点也有一个最小跳跃，避免瞬死

const vxOf = (p) => 40 + p * 300;
const vyOf = (p) => -(180 + p * 420);
const rangeOf = (p) => vxOf(p) * (2 * Math.abs(vyOf(p)) / G);

function powerForRange(target) {
  if (target <= rangeOf(0)) return 0;
  if (target >= rangeOf(1)) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (rangeOf(mid) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------
 * 6. 游戏状态
 * ---------------------------------------------------------- */
const game = {
  state: 'ready',               // ready | idle | charging | jumping | falling | over
  score: 0,
  combo: 0,
  maxCombo: 0,
  platforms: [],
  char: { x: 0, y: 0, vx: 0, vy: 0, expr: 'happy', sq: 0, rot: 0, sy: 1, sx: 1, spin: 0 },
  cam: 0, camTarget: 0,
  power: 0, holdStart: 0, lastTick: 0,
  shake: 0, shakeMag: 0,
  particles: [],
  popups: [],
  coins: [],
  time: 0,
  perfectFlash: 0,
  missReason: ''
};

function makePlatform(x, w, exprIdx) {
  return {
    x, w, expr: exprIdx,
    depth: rand(PLAT_H_MIN, PLAT_H_MIN + 62),
    squash: 0, wob: 0, hit: 0
  };
}

function pickExpr(exclude) {
  let i = (Math.random() * EXPR.length) | 0;
  if (i === exclude) i = (i + 1 + ((Math.random() * (EXPR.length - 1)) | 0)) % EXPR.length;
  return i;
}

function difficulty() { return clamp(game.score / 45, 0, 1); }

function spawnNext() {
  const d = difficulty();
  const prev = game.platforms[game.platforms.length - 1];
  const w = lerp(rand(66, 96), rand(42, 64), d);
  const gap = lerp(rand(14, 68), rand(58, 148), d);
  const x = prev.x + prev.w + gap;
  const lastExpr = prev ? prev.expr : -1;
  const p = makePlatform(x, w, pickExpr(lastExpr));
  p.justSpawned = 1;
  game.platforms.push(p);
  return p;
}

function resetGame() {
  game.score = 0; game.combo = 0; game.maxCombo = 0;
  game.particles.length = 0; game.popups.length = 0; game.coins.length = 0;
  game.shake = 0; game.shakeMag = 0; game.perfectFlash = 0;
  game.missReason = '';
  const first = makePlatform(60, 92, 0);
  first.landed = true;
  game.platforms = [first];
  game.char.x = first.x + first.w / 2;
  game.char.y = GY;
  game.char.vx = 0; game.char.vy = 0;
  game.char.expr = 'happy';
  game.char.sx = 1; game.char.sy = 1; game.char.rot = 0; game.char.spin = 0;
  game.cam = game.camTarget = game.char.x - VW * 0.30;
  game.power = 0;
  game.state = 'idle';
  spawnNext();
  updateHUD();
}

/* ------------------------------------------------------------
 * 7. 输入
 * ---------------------------------------------------------- */
function canPlay() { return game.state === 'idle'; }

function pressStart(e) {
  if (e && e.cancelable) e.preventDefault();
  SFX.init(); SFX.resume();
  if (!canPlay()) return;
  game.state = 'charging';
  game.holdStart = performance.now();
  game.power = 0;
  game.lastTick = 0;
  game.char.expr = 'shock';
}

function pressEnd(e) {
  if (game.state !== 'charging') return;
  if (e && e.cancelable) e.preventDefault();
  doJump(game.power);
}

function doJump(power) {
  const c = game.char;
  power = Math.max(power, MIN_POWER);
  c.vx = vxOf(power);
  c.vy = vyOf(power);
  c.sx = 0.82; c.sy = 1.24;   // 拉伸
  c.jumpFrom = c.x;
  c.tookOff = true;
  game.state = 'jumping';
  game.power = power;
  SFX.jump(power);
  Snd.play('jump', 0.42, 0.82 + power * 0.35);
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
  burst(c.x, c.y, 6, '#ffffff', 60, 1.2);
}

/* 键盘（桌面调试） */
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) { pressStart(null); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') pressEnd(null);
});

/* ------------------------------------------------------------
 * 8. 特效小工具
 * ---------------------------------------------------------- */
function burst(x, y, n, color, speed, life, sprite) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const s = speed * rand(0.4, 1.2);
    game.particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 30,
      life: 0, max: (life || 0.7) * rand(0.7, 1.3),
      size: rand(1.6, 4.2), color: color || '#ffd84d', grav: 420,
      sprite: !!sprite, rot: rand(0, TAU), spin: rand(-6, 6)
    });
  }
}

/* 完美落地时弹出的金币（Kenney coin.png） */
function popCoin(x, y) {
  game.coins.push({ x, y, life: 0, max: 0.85, spin: rand(-3.4, 3.4), rise: rand(46, 62) });
}
function popup(x, y, text, color, size) {
  game.popups.push({ x, y, text, color: color || '#fff', size: size || 20, life: 0, max: 0.95 });
}

/* ------------------------------------------------------------
 * 9. 更新
 * ---------------------------------------------------------- */
function update(dt) {
  game.time += dt;
  const c = game.char;

  /* --- 蓄力 --- */
  if (game.state === 'charging') {
    const held = performance.now() - game.holdStart;
    game.power = clamp(held / CHARGE_MS, 0, 1);
    const step = Math.floor(game.power * 14);
    if (step > game.lastTick) { game.lastTick = step; SFX.tick(step); }
    c.sx = 1 + game.power * 0.22;
    c.sy = 1 - game.power * 0.30;
    const p0 = game.platforms.find((p) => c.x >= p.x && c.x <= p.x + p.w);
    if (p0) p0.squash = Math.max(p0.squash, game.power * 0.55);
    if (game.power >= 1) {
      for (let i = 0; i < 2; i++) {
        game.particles.push({
          x: c.x + rand(-CHAR_W, CHAR_W), y: c.y - rand(0, CHAR_H),
          vx: rand(-24, 24), vy: rand(-90, -40), life: 0, max: 0.5,
          size: rand(1.5, 3), color: '#fff2a8', grav: -40
        });
      }
    }
  } else if (game.state === 'idle' && c.sx !== 1) {
    c.sx = lerp(c.sx, 1, clamp(dt * 12, 0, 1));
    c.sy = lerp(c.sy, 1, clamp(dt * 12, 0, 1));
  }

  /* --- 跳跃 / 自由落体 --- */
  if (game.state === 'jumping' || game.state === 'falling') {
    const prevY = c.y;
    c.vy += G * dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    c.sy = lerp(c.sy, 1, clamp(dt * 6, 0, 1));
    c.sx = lerp(c.sx, 1, clamp(dt * 6, 0, 1));

    if (game.state === 'falling') {
      c.rot += dt * 7 * c.spin;
      if (c.y > VH + 140) { endGame(); return; }
    } else if (c.vy > 0 && prevY <= GY && c.y >= GY) {
      c.y = GY;
      handleLanding();
    }
  }

  /* --- 平台动画 --- */
  for (const p of game.platforms) {
    if (p.squash > 0) p.squash = Math.max(0, p.squash - dt * 3.4);
    if (p.wob > 0) p.wob = Math.max(0, p.wob - dt * 2.6);
    if (p.hit > 0) p.hit = Math.max(0, p.hit - dt * 2.2);
  }

  /* --- 粒子 --- */
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const q = game.particles[i];
    q.life += dt;
    q.vy += q.grav * dt;
    q.x += q.vx * dt; q.y += q.vy * dt;
    if (q.life >= q.max) game.particles.splice(i, 1);
  }
  for (let i = game.popups.length - 1; i >= 0; i--) {
    const q = game.popups[i];
    q.life += dt;
    q.y -= dt * 46;
    if (q.life >= q.max) game.popups.splice(i, 1);
  }
  for (let i = game.coins.length - 1; i >= 0; i--) {
    const q = game.coins[i];
    q.life += dt;
    if (q.life >= q.max) game.coins.splice(i, 1);
  }

  /* --- 相机 --- */
  game.camTarget = c.x - VW * 0.30;
  game.cam += (game.camTarget - game.cam) * clamp(dt * 6.5, 0, 1);
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 3.2);
  if (game.perfectFlash > 0) game.perfectFlash = Math.max(0, game.perfectFlash - dt * 2.6);

  /* --- 清理旧平台 --- */
  while (game.platforms.length > 3 && game.platforms[0].x + game.platforms[0].w < game.cam - 60) {
    game.platforms.shift();
  }

  /* --- 记录落地平台 & 蓄力时更新 HUD --- */
  if (game.state === 'charging') updatePowerHint();
}

/* 计算「安全落点」对应的蓄力区间，画在力度条上 */
let powerSafeLo = 0, powerSafeHi = 1, powerPerfectLo = 0, powerPerfectHi = 1, powerHaveTarget = false;
function currentTarget() {
  const last = game.platforms[game.platforms.length - 1];
  if (!last) return null;
  return last.landed ? null : last;
}
function updatePowerHint() {
  const p = currentTarget();
  if (!p) { powerHaveTarget = false; return; }
  powerHaveTarget = true;
  const c = game.char;
  const lo = (p.x - EDGE_GRACE) - c.x;
  const hi = (p.x + p.w + EDGE_GRACE) - c.x;
  powerSafeLo = powerForRange(Math.max(0, lo));
  powerSafeHi = powerForRange(hi);
  const center = p.x + p.w / 2;
  const pz = perfectZone(p.w);
  powerPerfectLo = powerForRange(Math.max(0, center - pz - c.x));
  powerPerfectHi = powerForRange(center + pz - c.x);
}
const perfectZone = (w) => Math.max(6, w * 0.20);

function handleLanding() {
  const c = game.char;
  const landX = c.x;
  let hit = null;
  for (const p of game.platforms) {
    if (landX >= p.x - EDGE_GRACE && landX <= p.x + p.w + EDGE_GRACE) { hit = p; break; }
  }

  if (!hit) {
    /* 跳空 → 破防 */
    const nearEdge = game.platforms.some((p) => Math.abs(landX - p.x) < 26 || Math.abs(landX - (p.x + p.w)) < 26);
    game.missReason = nearEdge ? '就差一点点…奶娃踩空了' : '跳过头了，奶娃直接起飞';
    game.state = 'falling';
    c.expr = 'broken';
    c.spin = landX > game.platforms[game.platforms.length - 1].x ? 1 : -1;
    c.vy = 120;
    SFX.fail();
    Snd.play('fall', 0.5);
    if (navigator.vibrate) { try { navigator.vibrate([18, 60, 30]); } catch (e) {} }
    return;
  }

  /* 落地 */
  c.y = GY; c.vx = 0; c.vy = 0;
  c.rot = 0; c.spin = 0;
  c.sx = 1.30; c.sy = 0.72;
  hit.squash = 1; hit.hit = 1;

  const center = hit.x + hit.w / 2;
  const off = landX - center;
  const pz = perfectZone(hit.w);

  if (!hit.landed) {
    hit.landed = true;
    const dist = Math.abs(off);
    if (dist <= pz) {
      /* ---------- 完美 ---------- */
      game.combo++;
      game.maxCombo = Math.max(game.maxCombo, game.combo);
      const bonus = Math.min(game.combo - 1, 5);
      const gain = 2 + bonus;
      game.score += gain;
      c.expr = 'happy';
      SFX.perfect(game.combo);
      Snd.play('coin', 0.5, 1 + Math.min(game.combo, 8) * 0.045);
      if (game.combo >= 2) SFX.abstract();
      burst(landX, GY - 6, 16, '#fff0a0', 150, 0.9, true);
      burst(landX, GY - 6, 8, EXPR[hit.expr].top, 110, 1.1);
      popCoin(landX, GY - 24);
      popup(landX, GY - 58, '完美 +' + gain, '#fff8c8', 22);
      game.shake = 1; game.shakeMag = 4.5;
      game.perfectFlash = 1;
      onCombo(game.combo);
      if (navigator.vibrate) { try { navigator.vibrate([10, 24, 14]); } catch (e) {} }
      /* 完美落地 → 平台换成开心表情 */
      hit.expr = EXPR_INDEX.happy;
    } else {
      /* ---------- 普通 ---------- */
      game.combo = 0;
      game.score += 1;
      c.expr = Math.abs(off) > hit.w * 0.40 ? 'shock' : 'meh';
      SFX.land();
      Snd.play('land', 0.45, 0.95 + Math.random() * 0.12);
      burst(landX, GY - 4, 8, '#ffffff', 80, 0.6, true);
      popup(landX, GY - 54, '+1', '#ffffff', 18);
      game.shake = 1; game.shakeMag = 2;
      hit.expr = EXPR_INDEX[Math.random() < 0.5 ? 'meh' : 'shock'];
    }
    spawnNext();
    updateHUD();
  } else {
    /* 落回同一个平台：不得分、断连击 */
    game.combo = 0;
    c.expr = 'meh';
    SFX.land();
    Snd.play('land', 0.32, 0.78);
    popup(landX, GY - 52, '原地…', '#ffffff', 16);
    updateHUD();
  }

  game.state = 'idle';
  game.power = 0;
}

const COMBO_TEXT = [
  '完美！',
  '这就是奶娃！',
  '抽象！',
  '哇哦——！',
  '奶娃本娃！',
  '太奶了！',
  '整活之王！',
  '无敌奶娃！'
];
function onCombo(n) {
  if (n < 2) return;
  const text = COMBO_TEXT[Math.min(n - 2, COMBO_TEXT.length - 1)];
  const el = $('comboBanner');
  el.textContent = text + ' ×' + n;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function endGame() {
  game.state = 'over';
  game.char.y = GY;
  Snd.play('break', 0.45);
  const isNew = Store.submit(game.score, game.maxCombo);
  /* 结算后自动上榜；失败只影响榜单，不影响游戏 */
  if (window.NaiwaBoard) window.NaiwaBoard.submit(game.score, game.maxCombo);
  fillOverScreen(game.score, game.maxCombo, Store.data.best, isNew);
  show($('overScreen'));
  $('hud').classList.add('hidden');
  $('overPhoto').style.backgroundImage = 'url(' + (game.score >= 20 ? 'assets/meme-sit.jpg' : 'assets/meme-broken.jpg') + ')';
}

/* ------------------------------------------------------------
 * 10. 渲染
 * ---------------------------------------------------------- */
function drawSky() {
  const grd = ctx.createLinearGradient(0, 0, 0, VH);
  const top = game.perfectFlash > 0 ? '#ffeaa0' : '#8fd4f0';
  grd.addColorStop(0, top);
  grd.addColorStop(0.42, '#cfeaf7');
  grd.addColorStop(0.70, '#ffe6b8');
  grd.addColorStop(1, '#ffd08a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, VW, VH);

  /* 太阳 */
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.arc(VW * 0.78, VH * 0.16, 34, 0, TAU);
  ctx.fillStyle = '#fff3b0';
  ctx.fill();
  ctx.restore();

  /* 远景山丘（视差） */
  const camP = game.cam * 0.12;
  ctx.fillStyle = 'rgba(150,200,180,.55)';
  ctx.beginPath();
  ctx.moveTo(-20, GY + 10);
  for (let i = -1; i < 8; i++) {
    const bx = i * 150 - (camP % 150);
    ctx.quadraticCurveTo(bx + 40, GY - 96, bx + 78, GY + 10);
  }
  ctx.lineTo(VW + 40, GY + 40); ctx.lineTo(-20, GY + 40);
  ctx.closePath(); ctx.fill();

  /* 中景云 */
  const camC = game.cam * 0.25;
  ctx.fillStyle = 'rgba(255,255,255,.62)';
  for (let i = -1; i < 7; i++) {
    const bx = i * 170 - (camC % 170);
    const by = VH * (0.16 + ((i % 3) * 0.055));
    ctx.beginPath();
    ctx.ellipse(bx + 40, by, 34, 15, 0, 0, TAU);
    ctx.ellipse(bx + 66, by - 8, 26, 13, 0, 0, TAU);
    ctx.ellipse(bx + 18, by + 5, 22, 11, 0, 0, TAU);
    ctx.fill();
  }

  /* 近景地面色带 */
  ctx.fillStyle = 'rgba(255,214,140,.85)';
  ctx.fillRect(0, GY + 6, VW, VH - GY);
  ctx.fillStyle = 'rgba(244,186,102,.65)';
  ctx.fillRect(0, GY + 46, VW, VH - GY);
}

function drawPlatforms() {
  for (const p of game.platforms) {
    const sx = p.x - game.cam;
    if (sx > VW + 80 || sx + p.w < -80) continue;
    const e = EXPR[p.expr];
    const sq = p.squash;
    const h = p.depth * (1 - sq * 0.06);
    const yTop = GY + sq * 5;
    const wob = Math.sin(game.time * 22) * p.wob * 3;

    ctx.save();
    ctx.translate(wob, 0);

    /* 落点阴影 */
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#7a4a10';
    ctx.beginPath();
    ctx.roundRect(sx + 3, yTop + 4, p.w, h, 9);
    ctx.fill();
    ctx.restore();

    /* 柱体 */
    const g = ctx.createLinearGradient(0, yTop, 0, yTop + h);
    g.addColorStop(0, e.top);
    g.addColorStop(0.35, e.side);
    g.addColorStop(1, e.dark);
    ctx.beginPath();
    ctx.roundRect(sx, yTop, p.w, h, 9);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.stroke();

    /* 顶面高光 */
    ctx.beginPath();
    ctx.roundRect(sx + 3, yTop + 2, p.w - 6, 8, 5);
    ctx.fillStyle = 'rgba(255,255,255,.62)';
    ctx.fill();

    /* 完美区域虚线 */
    const pz = perfectZone(p.w);
    const cx = sx + p.w / 2;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath();
    ctx.moveTo(cx - pz, yTop + 1.5);
    ctx.lineTo(cx - pz, yTop + 11);
    ctx.moveTo(cx + pz, yTop + 1.5);
    ctx.lineTo(cx + pz, yTop + 11);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, yTop + 6, 1.9, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();

    /* 表情包贴纸 */
    const fr = Math.min(p.w * 0.30, 15);
    if (h > fr * 1.6) {
      drawFace(ctx, cx, yTop + Math.max(24, h * 0.55), fr, EXPR[p.expr].key, game.time);
    }

    /* 命中闪光 */
    if (p.hit > 0) {
      ctx.save();
      ctx.globalAlpha = p.hit * 0.55;
      ctx.beginPath();
      ctx.roundRect(sx - 3, yTop - 3, p.w + 6, h + 6, 11);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

function drawChar() {
  const c = game.char;
  const x = c.x - game.cam;
  const y = c.y;

  /* 地面影子 */
  if (game.state !== 'falling') {
    const air = clamp((GY - y) / 260, 0, 1);
    ctx.save();
    ctx.globalAlpha = clamp(1 - air, 0.07, 0.22);
    if (IMG.shadow) {
      const sw = CHAR_W * (2.3 + air * 1.1);
      const sh = sw * 0.40;                 // 压扁成椭圆，贴地感更强
      ctx.drawImage(IMG.shadow, x - sw / 2, GY + 4 - sh / 2, sw, sh);
    } else {
      ctx.fillStyle = '#6b3d0a';
      ctx.beginPath();
      ctx.ellipse(x, GY + 6, CHAR_W * 0.72, 5.2, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 空中拖影 */
  if (game.state === 'jumping' && Math.abs(c.vy) > 240) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    drawNaiwa(ctx, x - c.vx * 0.028, y - c.vy * 0.012, CHAR_H, c.expr, { sx: c.sx, sy: c.sy, look: 0.4 });
    ctx.restore();
  }

  const look = (() => {
    const p = currentTarget();
    if (!p) return 0.3;
    return clamp((p.x + p.w / 2 - c.x) / 140, -1, 1);
  })();

  ctx.save();
  if (game.state === 'falling') {
    ctx.translate(x, y - CHAR_H * 0.5);
    ctx.rotate(c.rot);
    ctx.translate(0, CHAR_H * 0.5);
    drawNaiwa(ctx, 0, 0, CHAR_H, c.expr, { look: 0, sx: 1, sy: 1 });
  } else {
    drawNaiwa(ctx, x, y, CHAR_H, c.expr, {
      sx: c.sx, sy: c.sy, look,
      blink: (Math.sin(game.time * 2.1) > 0.985) ? 1 : 0,
      armSwing: game.state === 'charging' ? game.power : 0
    });
  }
  ctx.restore();

  /* 蓄力时的抛物线预览点（前 3 跳教学） */
  if (game.state === 'charging' && Store.data.plays < 3 && game.score < 3) {
    const vx = vxOf(game.power), vy = vyOf(game.power);
    ctx.save();
    ctx.globalAlpha = 0.5;
    for (let i = 1; i <= 16; i++) {
      const t = i * 0.045;
      const px = c.x + vx * t - game.cam;
      const py = c.y + vy * t + 0.5 * G * t * t;
      if (py > GY + 2) break;
      ctx.beginPath();
      ctx.arc(px, py, 2.2 - i * 0.08, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fill();
    }
    ctx.restore();
  }
}

function drawFX() {
  for (const q of game.particles) {
    const k = 1 - q.life / q.max;
    ctx.save();
    ctx.globalAlpha = clamp(k, 0, 1);
    if (q.sprite && IMG.particle) {
      const s = 10 * (0.5 + k * 0.9);
      ctx.translate(q.x - game.cam, q.y);
      ctx.rotate(q.rot + q.life * q.spin);
      ctx.drawImage(IMG.particle, -s / 2, -s / 2, s, s);
    } else {
      ctx.beginPath();
      ctx.arc(q.x - game.cam, q.y, q.size * k, 0, TAU);
      ctx.fillStyle = q.color;
      ctx.fill();
    }
    ctx.restore();
  }
  for (const q of game.coins) {
    const k = clamp(1 - q.life / q.max, 0, 1);
    ctx.save();
    ctx.globalAlpha = k;
    ctx.translate(q.x - game.cam, q.y - q.rise * (1 - (1 - k) * (1 - k)));
    if (IMG.coin) {
      const s = 26 * (0.55 + (1 - k) * 0.6);
      ctx.rotate(Math.sin(q.spin) * 0.25);
      ctx.drawImage(IMG.coin, -s / 2, -s / 2, s, s);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 11 * (0.55 + (1 - k) * 0.6), 0, TAU);
      ctx.fillStyle = '#ffc044';
      ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffa33b'; ctx.stroke();
    }
    ctx.restore();
  }
  for (const q of game.popups) {
    const k = 1 - q.life / q.max;
    ctx.save();
    ctx.globalAlpha = clamp(k * 1.4, 0, 1);
    ctx.font = '400 ' + q.size + 'px "Lilita One","PingFang SC","Microsoft YaHei",sans-serif';
    ctx.textAlign = 'center';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(70,45,15,.55)';
    ctx.strokeText(q.text, q.x - game.cam, q.y);
    ctx.fillStyle = q.color;
    ctx.fillText(q.text, q.x - game.cam, q.y);
    ctx.restore();
  }
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.save();
  ctx.scale(SCALE, SCALE);

  const sh = game.shake > 0 ? game.shake * game.shakeMag : 0;
  if (sh > 0) ctx.translate(rand(-sh, sh), rand(-sh, sh));

  drawSky();
  drawPlatforms();
  drawChar();
  drawFX();

  ctx.restore();
}

/* ------------------------------------------------------------
 * 11. HUD
 * ---------------------------------------------------------- */
const powerFill = $('powerFill');
const powerSafeEl = document.querySelector('.power-safe');
function updateHUD() {
  const s = $('score');
  if (s.textContent !== String(game.score)) {
    s.textContent = game.score;
    s.classList.remove('pop'); void s.offsetWidth; s.classList.add('pop');
  }
  $('best').textContent = Store.data.best;
  $('combo').textContent = game.combo;
}
function updatePowerHintUI() {
  powerFill.style.width = (game.power * 100).toFixed(1) + '%';
  if (powerHaveTarget) {
    const lo = clamp(Math.min(powerSafeLo, powerSafeHi), 0, 1);
    const hi = clamp(Math.max(powerSafeLo, powerSafeHi), 0, 1);
    powerSafeEl.style.display = '';
    powerSafeEl.style.left = (lo * 100) + '%';
    powerSafeEl.style.width = (Math.max(1.5, (hi - lo) * 100)) + '%';
    const inSafe = game.power >= lo - 0.008 && game.power <= hi + 0.008;
    powerSafeEl.style.background = inSafe ? 'rgba(160,255,120,.45)' : 'rgba(255,255,255,.16)';
    $('powerTip').textContent = inSafe ? '松手！能站上去' : '长按屏幕蓄力';
  } else {
    powerSafeEl.style.display = 'none';
    $('powerTip').textContent = '长按屏幕蓄力';
  }
}

/* ------------------------------------------------------------
 * 12. 主循环
 * ---------------------------------------------------------- */
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  if (game.state === 'charging') updatePowerHintUI();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------
 * 13. 界面 / 覆盖层
 * ---------------------------------------------------------- */
function show(el) { el.classList.add('show'); }
function hide(el) { el.classList.remove('show'); }

const ALL_OVERLAYS = ['startScreen', 'overScreen', 'boardScreen', 'shareScreen'];
function hideAllExcept(id) {
  ALL_OVERLAYS.forEach((k) => { if (k !== id) hide($(k)); });
}

function startGame() {
  SFX.init(); SFX.resume();
  SFX.bgmStart();
  hideAllExcept(null);
  resetGame();
  $('hud').classList.remove('hidden');
  updatePowerHintUI();
}

function fillOverScreen(score, combo, best, isNew) {
  $('overScore').textContent = score;
  $('overCombo').textContent = combo;
  $('overBest').textContent = best;
  $('newRecord').classList.toggle('hidden', !isNew);
  const titles = [
    [0, '破防了，再來一局？', '这次是真的抽象…'],
    [1, '还行，但能更好', '奶娃表示有点无语'],
    [5, '有点东西！', '连续完美试试？'],
    [10, '奶娃起飞了 🚀', '这波很稳'],
    [20, '这就是奶娃！', '抽象程度拉满'],
    [35, '奶娃本娃 👑', '朋友圈可以发了']
  ];
  let pick = titles[0];
  for (const t of titles) if (score >= t[0]) pick = t;
  $('overTitle').textContent = pick[1];
  $('overSub').textContent = game.missReason ? game.missReason + '｜' + pick[2] : pick[2];
}

function renderBoard() {
  const list = $('boardList');
  list.innerHTML = '';
  const b = Store.data.board.slice(0, 10);
  if (!b.length) {
    const d = document.createElement('div');
    d.className = 'board-empty';
    d.textContent = '还没有成绩，快去跳一把！';
    list.appendChild(d);
    return;
  }
  b.forEach((r, i) => {
    const li = document.createElement('li');
    const d = new Date(r.at || Date.now());
    const md = (d.getMonth() + 1) + '/' + d.getDate();
    li.innerHTML = '<span class="rk">' + (i + 1) + '</span>' +
      '<span class="cb">' + md + ' · 连击 ' + (r.combo || 0) + '</span>' +
      '<span class="sc">' + r.score + '</span>';
    list.appendChild(li);
  });
}

/* ---------- 分享卡（纯程序化绘制，避免跨域污染） ---------- */
function buildShareCard(score, combo, best) {
  const W = 1080, H = 1440;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');

  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#ffe9a3');
  bg.addColorStop(0.55, '#ffc961');
  bg.addColorStop(1, '#ff9d4d');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  /* 光斑 */
  for (let i = 0; i < 26; i++) {
    g.beginPath();
    g.arc(Math.random() * W, Math.random() * H * 0.7, rand(20, 90), 0, TAU);
    g.fillStyle = 'rgba(255,255,255,' + rand(0.03, 0.10).toFixed(3) + ')';
    g.fill();
  }

  /* 底部平台 */
  const baseY = H * 0.78;
  [[-60, 300], [300, 240], [600, 380]].forEach(([x, w], i) => {
    const e = [EXPR[0], EXPR[2], EXPR[3]][i];
    const gg = g.createLinearGradient(0, baseY, 0, H);
    gg.addColorStop(0, e.top); gg.addColorStop(1, e.dark);
    g.beginPath(); g.roundRect(x, baseY, w, 240, 26); g.fillStyle = gg; g.fill();
    g.beginPath(); g.roundRect(x + 10, baseY + 6, w - 20, 22, 12);
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fill();
    drawFace(g, x + w / 2, baseY + 110, Math.min(w * 0.3, 90), e.key, 0);
  });

  /* 角色 */
  drawNaiwa(g, W * 0.5, baseY + 6, 300, 'happy', { look: 0.2, t: 0 });

  /* 标题 */
  g.textAlign = 'center';
  g.font = '900 86px "PingFang SC","Microsoft YaHei",sans-serif';
  g.lineWidth = 16; g.strokeStyle = '#f2b705'; g.lineJoin = 'round';
  g.strokeText('奶娃跳一跳', W / 2, 150);
  g.fillStyle = '#fff'; g.fillText('奶娃跳一跳', W / 2, 150);

  /* 分数 */
  g.font = '900 250px "PingFang SC","Microsoft YaHei",sans-serif';
  g.lineWidth = 18; g.strokeStyle = 'rgba(120,70,10,.45)';
  g.strokeText(score, W / 2, 470);
  g.fillStyle = '#fff'; g.fillText(score, W / 2, 470);
  g.font = '800 44px "PingFang SC","Microsoft YaHei",sans-serif';
  g.fillStyle = '#7a4a10'; g.fillText('本 局 得 分', W / 2, 540);

  /* 数据条 */
  const cards = [['最高连击', combo], ['历史最高', best]];
  cards.forEach((c, i) => {
    const cw = 380, ch = 170, cx = W / 2 - cw - 20 + i * (cw + 40), cy = 620;
    g.beginPath(); g.roundRect(cx, cy, cw, ch, 34);
    g.fillStyle = 'rgba(255,253,246,.95)'; g.fill();
    g.fillStyle = '#e0821a';
    g.font = '900 90px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(c[1], cx + cw / 2, cy + 100);
    g.fillStyle = '#8a7563';
    g.font = '800 32px "PingFang SC","Microsoft YaHei",sans-serif';
    g.fillText(c[0], cx + cw / 2, cy + 145);
  });

  /* 梗文案 */
  const lines = score >= 30 ? ['这就是奶娃！', '抽象程度：拉满'] :
    score >= 15 ? ['奶娃起飞了 🚀', '不服来战'] :
      score >= 5 ? ['有点东西', '再跳一次就完美了'] :
        ['破防了…', '但奶娃不服'];
  g.fillStyle = '#fff';
  g.font = '900 64px "PingFang SC","Microsoft YaHei",sans-serif';
  g.lineWidth = 12; g.strokeStyle = 'rgba(120,70,10,.4)';
  lines.forEach((t, i) => {
    g.strokeText(t, W / 2, 930 + i * 86);
    g.fillText(t, W / 2, 930 + i * 86);
  });

  /* 页脚 */
  g.font = '800 34px "PingFang SC","Microsoft YaHei",sans-serif';
  g.fillStyle = 'rgba(90,55,10,.75)';
  g.fillText('长按蓄力 · 松手起跳 · 手机浏览器直接开玩', W / 2, H - 60);

  return cv;
}

function openShare() {
  const cv = buildShareCard(game.score, game.maxCombo, Store.data.best);
  cv.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const img = $('shareImg');
    img.src = url;
    img.dataset.url = url;
    img.dataset.blob = '1';
    window.__shareBlob = blob;
    window.__shareFile = new File([blob], '奶娃跳一跳-' + game.score + '分.png', { type: 'image/png' });
  }, 'image/png');
  hideAllExcept('shareScreen');
  show($('shareScreen'));
  SFX.ui();
}

/* ------------------------------------------------------------
 * 14. 事件绑定
 * ---------------------------------------------------------- */
function bindInput() {
  const stop = (e) => { if (e.cancelable) e.preventDefault(); };

  canvas.addEventListener('pointerdown', (e) => { stop(e); pressStart(e); }, { passive: false });
  window.addEventListener('pointerup', (e) => { pressEnd(e); }, { passive: false });
  window.addEventListener('pointercancel', (e) => { pressEnd(e); }, { passive: false });
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
  document.addEventListener('contextmenu', (e) => { if (e.target === canvas) e.preventDefault(); });
  window.addEventListener('touchmove', (e) => {
    /* 排行榜列表要能滚，别把它也禁掉 */
    if (e.target && e.target.closest && e.target.closest('#boardList')) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  $('btnStart').addEventListener('click', () => { SFX.ui(); startGame(); });
  $('btnRetry').addEventListener('click', () => { SFX.ui(); startGame(); });
  $('btnHome').addEventListener('click', () => {
    SFX.ui();
    game.state = 'ready';
    hideAllExcept('startScreen');
    show($('startScreen'));
    refreshStart();
  });
  $('btnBoard').addEventListener('click', () => {
    SFX.ui();
    hideAllExcept('boardScreen');
    show($('boardScreen'));
    /* 在线榜单由 leaderboard.js 接管；没加载就退回本机记录 */
    if (window.NaiwaBoard) window.NaiwaBoard.open();
    else renderBoard();
  });
  $('btnBoardClose').addEventListener('click', () => { SFX.ui(); hideAllExcept('startScreen'); show($('startScreen')); refreshStart(); });
  $('btnShare').addEventListener('click', openShare);
  $('btnShareClose').addEventListener('click', () => {
    hideAllExcept('overScreen'); show($('overScreen'));
    if ($('shareImg').dataset.url) { URL.revokeObjectURL($('shareImg').dataset.url); $('shareImg').dataset.url = ''; }
  });
  $('btnShareDownload').addEventListener('click', async () => {
    const file = window.__shareFile;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: '奶娃跳一跳', text: '我拿了 ' + game.score + ' 分，来挑战我！' }); return; } catch (e) {}
    }
    const a = document.createElement('a');
    a.href = $('shareImg').src;
    a.download = '奶娃跳一跳-' + game.score + '分.png';
    document.body.appendChild(a); a.click(); a.remove();
    SFX.ui();
  });
  $('btnCopy').addEventListener('click', async () => {
    const b = Store.data.board[0];
    const txt = '【奶娃跳一跳】我最高 ' + Store.data.best + ' 分，最高连击 ' + Store.data.bestCombo +
      (b ? ('，上一局 ' + b.score + ' 分') : '') + '。来挑战我！';
    try {
      await navigator.clipboard.writeText(txt);
      $('btnCopy').textContent = '已复制 ✓ 去群里发吧';
    } catch (e) {
      $('btnCopy').textContent = txt.slice(0, 18) + '…';
    }
    setTimeout(() => { $('btnCopy').textContent = '复制成绩发群里'; }, 2200);
    SFX.ui();
  });
  $('btnMute').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = SFX.toggleMute();
    $('btnMute').textContent = m ? '🔇' : '🔊';
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 220));
}

/* ---------- 开始页动态插画 ---------- */
const heroCv = $('heroArt');
const heroCtx = heroCv.getContext('2d');
function drawHero(now) {
  requestAnimationFrame(drawHero);
  if (!$('startScreen').classList.contains('show')) return;
  const g = heroCtx, W = heroCv.width, H = heroCv.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  const t = now / 1000;
  /* 三个平台 */
  const plats = [
    { x: 24, y: H - 46, w: 104, e: 1 },
    { x: 148, y: H - 30, w: 92, e: 3 },
    { x: 258, y: H - 58, w: 86, e: 0 }
  ];
  plats.forEach((p, i) => {
    const e = EXPR[p.e];
    const gg = g.createLinearGradient(0, p.y, 0, p.y + 46);
    gg.addColorStop(0, e.top); gg.addColorStop(1, e.dark);
    g.beginPath(); g.roundRect(p.x, p.y, p.w, 46, 10); g.fillStyle = gg; g.fill();
    g.beginPath(); g.roundRect(p.x + 3, p.y + 2, p.w - 6, 8, 4);
    g.fillStyle = 'rgba(255,255,255,.6)'; g.fill();
    drawFace(g, p.x + p.w / 2, p.y + 26, Math.min(p.w * 0.24, 15), EXPR[p.e].key, t);
  });
  /* 跳动的奶娃 */
  const hop = Math.abs(Math.sin(t * 2.1));
  const x = 60 + Math.sin(t * 0.9) * 6;
  const y = plats[0].y - 4 - hop * 46;
  g.save();
  g.globalAlpha = 0.22;
  g.fillStyle = '#6b3d0a';
  g.beginPath(); g.ellipse(x, plats[0].y + 4, 22 * (1 - hop * 0.4), 5, 0, 0, TAU); g.fill();
  g.restore();
  drawNaiwa(g, x, y, 62, (Math.floor(t * 1.4) % 4 === 0) ? 'shock' : 'happy', {
    look: 0.4, sx: 1 + hop * 0.08, sy: 1 - hop * 0.08, armSwing: hop
  });
}

function refreshStart() {
  $('startBest').textContent = Store.data.best;
  $('startCombo').textContent = Store.data.bestCombo;
}

/* ------------------------------------------------------------
 * 15. 启动
 * ---------------------------------------------------------- */
function boot() {
  resize();
  resetGame();
  game.state = 'ready';
  refreshStart();
  /* 排行榜改成「点了才渲染」：在线榜由 leaderboard.js 负责，
     这里预渲染只会先闪一下本机记录，没必要 */
  bindInput();
  $('btnMute').textContent = Store.data.muted ? '🔇' : '🔊';
  requestAnimationFrame(drawHero);
  requestAnimationFrame(frame);
  setTimeout(() => $('boot').classList.add('gone'), 260);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'charging') pressEnd(null);
      if (SFX.bgm) SFX.bgm.pause();
    } else {
      last = performance.now();
      if (SFX.bgm && !Store.data.muted) { const p = SFX.bgm.play(); if (p && p.catch) p.catch(() => {}); }
    }
  });

  /* 首次交互解锁音频 */
  const unlock = () => {
    SFX.init(); SFX.resume();
    if (!Store.data.muted) SFX.bgmStart();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

boot();
window.__naiwa = { game, Store, SFX, Snd, IMG, resetGame, startGame, difficulty, spawnNext, powerForRange, rangeOf, buildShareCard };
})();
