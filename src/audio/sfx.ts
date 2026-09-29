import { Music } from './music';

type Kind = 'ball' | 'cushion' | 'pocket' | 'cue' | 'ui' | 'misc';

const MUTE_KEY = 'billar.muted';
const MUSIC_KEY = 'billar.music';
const MAX_VOICES = 10;
const MIN_GAP = 0.012;
const MIN_INTENSITY = 0.03;
const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private ambBus!: GainNode;
  private musicBus!: GainNode;
  private music: Music | null = null;
  private _musicOn = true;
  private _ducked = false;
  private noise!: AudioBuffer;
  private rollGain: GainNode | null = null;
  private voices = 0;
  private last: Record<Kind, { t: number; i: number }> = {
    ball: { t: -1, i: 0 },
    cushion: { t: -1, i: 0 },
    pocket: { t: -1, i: 0 },
    cue: { t: -1, i: 0 },
    ui: { t: -1, i: 0 },
    misc: { t: -1, i: 0 },
  };
  private _muted = false;
  private ambientWanted = false;
  private ambientNodes: AudioNode[] = [];
  private ambientTimer: number | null = null;
  private creakTimer: number | null = null;
  private nextBeat = 0;
  private beat = 0;

  constructor() {
    try {
      this._muted = localStorage.getItem(MUTE_KEY) === '1';
      this._musicOn = localStorage.getItem(MUSIC_KEY) !== '0';
    } catch {
      /* storage unavailable */
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  get musicOn(): boolean {
    return this._musicOn;
  }

  setMusic(on: boolean): void {
    this._musicOn = on;
    try {
      localStorage.setItem(MUSIC_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.syncMusic();
  }

  /** Silence all in-game music (generative songs and the ambient piano) without touching the saved preference. */
  setDucked(ducked: boolean): void {
    this._ducked = ducked;
    this.syncMusic();
  }

  private syncMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this._musicOn && !this._muted && !this._ducked) {
      this.music ??= new Music(ctx, this.musicBus);
      this.music.start();
    } else {
      this.music?.stop();
    }
  }

  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
      } catch {
        return;
      }
      this.build(this.ctx);
    }
    const ctx = this.ctx;
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
    if (this.ambientWanted) this.startAmbient();
    this.syncMusic();
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.02);
    this.syncMusic();
  }

  private build(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(ctx.destination);
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0.35;
    this.ambBus.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(this.master);

    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // iOS unlock: play an empty buffer inside the gesture
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    s.connect(ctx.destination);
    s.start();

    const roll = ctx.createBufferSource();
    roll.buffer = this.noise;
    roll.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 50;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    roll.connect(lp).connect(hp).connect(this.rollGain).connect(this.sfxBus);
    roll.start();
  }

  private ready(): AudioContext | null {
    const c = this.ctx;
    return c && c.state === 'running' ? c : null;
  }

  private allow(kind: Kind, intensity: number): AudioContext | null {
    const ctx = this.ready();
    if (!ctx || intensity < MIN_INTENSITY) return null;
    if (this.voices >= MAX_VOICES) return null;
    const l = this.last[kind];
    if (ctx.currentTime - l.t < MIN_GAP && intensity < l.i + 0.25) return null;
    l.t = ctx.currentTime;
    l.i = intensity;
    return ctx;
  }

  private track(src: AudioScheduledSourceNode, nodes: AudioNode[], counted = true): void {
    if (counted) this.voices++;
    src.onended = () => {
      if (counted) this.voices = Math.max(0, this.voices - 1);
      src.disconnect();
      for (const n of nodes) n.disconnect();
    };
  }

  private out(ctx: AudioContext, pan: number, dest: AudioNode = this.sfxBus): AudioNode {
    if (!ctx.createStereoPanner || pan === 0) return dest;
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    p.connect(dest);
    return p;
  }

  private burst(
    ctx: AudioContext, t: number, dur: number, type: BiquadFilterType, freq: number, q: number,
    gain: number, dest: AudioNode, counted = true,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, rand(0, 1.4), dur + 0.02);
    this.track(src, [f, g], counted);
  }

  private tone(
    ctx: AudioContext, t: number, type: OscillatorType, f0: number, f1: number, dur: number,
    gain: number, dest: AudioNode, counted = true,
  ): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
    this.track(o, [g], counted);
  }

  ballHit(intensity: number, pan = 0): void {
    const ctx = this.allow('ball', intensity);
    if (!ctx) return;
    const i = clamp(intensity, 0, 1);
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    const vol = 0.15 + 0.85 * i;
    this.burst(ctx, t, 0.012 + 0.01 * i, 'highpass', 2500 + 2500 * i, 0.7, 0.9 * vol, dest);
    this.tone(ctx, t, 'sine', rand(2900, 3300) + 900 * i, rand(2600, 3000), 0.05, 0.35 * vol, dest, false);
    this.tone(ctx, t, 'triangle', 1100 + 400 * i, 800, 0.03, 0.3 * vol, dest, false);
  }

  cushionHit(intensity: number, pan = 0): void {
    const ctx = this.allow('cushion', intensity);
    if (!ctx) return;
    const i = clamp(intensity, 0, 1);
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    const vol = 0.15 + 0.85 * i;
    this.tone(ctx, t, 'sine', 130 + 40 * i, 55, 0.14, 0.9 * vol, dest);
    this.burst(ctx, t, 0.05, 'lowpass', 500 + 400 * i, 0.5, 0.5 * vol, dest, false);
  }

  pocket(intensity: number, pan = 0): void {
    const ctx = this.allow('pocket', intensity);
    if (!ctx) return;
    const i = clamp(intensity, 0.2, 1);
    const t = ctx.currentTime;
    const dest = this.out(ctx, pan);
    this.tone(ctx, t, 'sine', 160, 50, 0.22, 0.8 * i, dest);
    this.burst(ctx, t, 0.08, 'lowpass', 700, 0.6, 0.5 * i, dest, false);
    let rt = t + 0.1;
    for (let k = 0; k < 4; k++) {
      this.burst(ctx, rt, 0.03, 'bandpass', rand(900, 1800), 2, 0.22 * i * (1 - k * 0.2), dest, false);
      rt += rand(0.05, 0.1);
    }
  }

  cueStrike(intensity: number): void {
    const ctx = this.allow('cue', Math.max(intensity, 0.05));
    if (!ctx) return;
    const i = clamp(intensity, 0.1, 1);
    const t = ctx.currentTime;
    const vol = 0.25 + 0.75 * i;
    this.tone(ctx, t, 'sine', 240, 120, 0.07, 0.8 * vol, this.sfxBus);
    this.tone(ctx, t, 'triangle', 720, 500, 0.035, 0.35 * vol, this.sfxBus, false);
    this.burst(ctx, t, 0.01, 'lowpass', 3000, 0.7, 0.6 * vol, this.sfxBus, false);
  }

  setRolling(level: number): void {
    if (!this.ctx || !this.rollGain) return;
    const l = clamp(level, 0, 1);
    this.rollGain.gain.setTargetAtTime(l * l * 0.35, this.ctx.currentTime, 0.08);
  }

  uiClick(): void {
    const ctx = this.allow('ui', 1);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, t, 'square', 1500, 900, 0.03, 0.12, this.sfxBus);
    this.burst(ctx, t, 0.01, 'highpass', 3500, 0.7, 0.15, this.sfxBus, false);
  }

  /** Glass set on the bar, a gulp, and the empty glass slammed back down. */
  shot(): void {
    const ctx = this.ready();
    if (!ctx) return;
    const t = ctx.currentTime;
    const bus = this.sfxBus;
    this.tone(ctx, t, 'sine', 2650, 2500, 0.18, 0.12, bus, false);
    this.tone(ctx, t, 'sine', 4300, 4200, 0.08, 0.05, bus, false);
    this.burst(ctx, t, 0.03, 'lowpass', 900, 0.6, 0.25, bus, false);
    for (let k = 0; k < 2; k++) {
      const g = t + 0.85 + k * 0.28;
      this.tone(ctx, g, 'sine', 210, 95, 0.16, 0.45, bus, false);
      this.burst(ctx, g, 0.12, 'bandpass', 420, 3, 0.25, bus, false);
    }
    this.burst(ctx, t + 1.55, 0.45, 'bandpass', 1400, 0.8, 0.12, bus, false);
    const slam = t + 2.15;
    this.tone(ctx, slam, 'sine', 150, 60, 0.12, 0.7, bus, false);
    this.tone(ctx, slam, 'sine', 2400, 2250, 0.12, 0.1, bus, false);
    this.burst(ctx, slam, 0.05, 'lowpass', 1200, 0.6, 0.45, bus, false);
  }

  private piano(dest: AudioNode, midi: number, t: number, vel: number, dur: number, spread: number, counted: boolean): void {
    const ctx = this.ctx!;
    const f = midiToHz(midi);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1200 + 2600 * vel;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32 * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(dest);
    const layers: [OscillatorType, number, number, number][] = [
      ['triangle', 1, -spread, 1],
      ['triangle', 1, spread, 1],
      ['sine', 2, 0, 0.25],
    ];
    layers.forEach(([type, mult, cents, amp], idx) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      o.detune.value = cents;
      const a = ctx.createGain();
      a.gain.value = amp * 0.5;
      o.connect(a).connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
      this.track(o, [a], counted && idx === 0);
      if (idx === 0) {
        const prev = o.onended;
        o.onended = (e) => {
          prev?.call(o, e);
          lp.disconnect();
          g.disconnect();
        };
      }
    });
  }

  foul(): void {
    const ctx = this.allow('misc', 1);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.piano(this.sfxBus, 63, t, 0.9, 0.7, 22, true);
    this.piano(this.sfxBus, 56, t + 0.22, 0.95, 1.1, 30, true);
    this.piano(this.sfxBus, 44, t + 0.22, 0.8, 1.1, 25, true);
  }

  win(): void {
    const ctx = this.allow('misc', 1);
    if (!ctx) return;
    const t = ctx.currentTime;
    const seq: [number, number, number][] = [
      [60, 0, 0.3], [64, 0.18, 0.3], [67, 0.36, 0.3], [72, 0.54, 0.5],
      [67, 0.9, 0.25], [72, 1.1, 0.25], [76, 1.3, 0.6],
    ];
    for (const [m, dt, d] of seq) this.piano(this.sfxBus, m, t + dt, 0.8, d + 0.5, 9, false);
    for (const m of [48, 60, 64, 67, 72]) this.piano(this.sfxBus, m, t + 1.9, 0.85, 1.6, 10, false);
    this.piano(this.sfxBus, 36, t + 1.9, 0.9, 1.6, 8, false);
  }

  turnChange(): void {
    const ctx = this.allow('misc', 1);
    if (!ctx) return;
    const t = ctx.currentTime;
    this.tone(ctx, t, 'sine', 660, 660, 0.18, 0.12, this.sfxBus);
    this.tone(ctx, t + 0.12, 'sine', 880, 880, 0.25, 0.1, this.sfxBus);
  }

  setAmbient(on: boolean): void {
    this.ambientWanted = on;
    if (on) {
      if (this.ctx) this.startAmbient();
    } else {
      this.stopAmbient();
    }
  }

  private startAmbient(): void {
    const ctx = this.ctx;
    if (!ctx || this.ambientNodes.length) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.07;
    const lfoF = ctx.createGain();
    lfoF.gain.value = 150;
    lfo.connect(lfoAmt).connect(g.gain);
    lfo.connect(lfoF).connect(bp.frequency);
    src.connect(bp).connect(g).connect(this.ambBus);
    src.start();
    lfo.start();
    this.ambientNodes = [src, bp, g, lfo, lfoAmt, lfoF];

    this.nextBeat = ctx.currentTime + 0.5;
    this.beat = 0;
    this.ambientTimer = window.setInterval(() => this.scheduleMusic(), 250);
    const creak = () => {
      this.creak();
      this.creakTimer = window.setTimeout(creak, rand(7000, 18000));
    };
    this.creakTimer = window.setTimeout(creak, rand(3000, 8000));
  }

  private stopAmbient(): void {
    if (this.ambientTimer !== null) clearInterval(this.ambientTimer);
    if (this.creakTimer !== null) clearTimeout(this.creakTimer);
    this.ambientTimer = this.creakTimer = null;
    for (const n of this.ambientNodes) {
      if (n instanceof AudioScheduledSourceNode) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
      }
      n.disconnect();
    }
    this.ambientNodes = [];
  }

  private creak(): void {
    const ctx = this.ready();
    if (!ctx || document.hidden) return;
    const t = ctx.currentTime;
    const dur = rand(0.25, 0.6);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f = rand(70, 130);
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * rand(0.7, 1.4), t + dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = rand(350, 700);
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(g).connect(this.ambBus);
    o.start(t);
    o.stop(t + dur + 0.02);
    this.track(o, [bp, g], false);
  }

  private scheduleMusic(): void {
    const ctx = this.ready();
    if (!ctx) return;
    if (document.hidden || this._musicOn || this._ducked) {
      this.nextBeat = ctx.currentTime + 0.5;
      return;
    }
    const beatLen = 0.75;
    const roots = [48, 53, 48, 55]; // C F C G
    const music = this.ambBus;
    while (this.nextBeat < ctx.currentTime + 0.6) {
      const bar = Math.floor(this.beat / 4) % roots.length;
      const b = this.beat % 4;
      const root = roots[bar]!;
      const t = this.nextBeat + rand(0, 0.02);
      if (Math.random() >= 0.12) {
        if (b === 0) this.piano(music, root - 12, t, 0.55, 1.2, 14, false);
        else if (b === 2) this.piano(music, root - 5, t, 0.5, 1.0, 14, false);
        else for (const iv of [0, 4, 7]) this.piano(music, root + 12 + iv, t, 0.4, 0.9, 14, false);
        if (Math.random() < 0.3) {
          const pent = [0, 2, 4, 7, 9, 12];
          const n = root + 24 + pent[Math.floor(Math.random() * pent.length)]!;
          this.piano(music, n, t + beatLen * 0.5, 0.35, 0.8, 18, false);
        }
      }
      this.nextBeat += beatLen;
      this.beat++;
    }
  }
}
