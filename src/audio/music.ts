const KS_RATE = 32000;
const LOOKAHEAD = 0.15;
const TICK_MS = 30;
const MAX_VOICES = 40;
const CACHE_MAX = 80;
const OUT_LEVEL = 1;
const LEAD_LO = 62;
const LEAD_HI = 79;
const GTR_GAIN = 0.2;
const BJO_GAIN = 0.2;
const BASS_GAIN = 0.62;
const PERC_GAIN = { tick: 0.1, snap: 0.28, swish: 0.11 };

const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const pcOf = (m: number) => ((m % 12) + 12) % 12;

interface Chord {
  root: number;
  strings: readonly (number | null)[];
}

const CHORDS: Record<string, Chord> = {
  G: { root: 7, strings: [43, 47, 50, 55, 59, 67] },
  G7: { root: 7, strings: [43, 47, 50, 55, 59, 65] },
  C: { root: 0, strings: [null, 48, 52, 55, 60, 64] },
  C7: { root: 0, strings: [null, 48, 52, 58, 60, 64] },
  D: { root: 2, strings: [null, null, 50, 57, 62, 66] },
  D7: { root: 2, strings: [null, null, 50, 57, 60, 66] },
  Dm: { root: 2, strings: [null, null, 50, 57, 62, 65] },
  E: { root: 4, strings: [40, 47, 52, 56, 59, 64] },
  E7: { root: 4, strings: [40, 47, 50, 56, 59, 64] },
  Em: { root: 4, strings: [40, 47, 52, 55, 59, 64] },
  F: { root: 5, strings: [41, 48, 53, 57, 60, 65] },
  'F#m': { root: 6, strings: [42, 49, 54, 57, 61, 66] },
  A: { root: 9, strings: [null, 45, 52, 57, 61, 64] },
  A7: { root: 9, strings: [null, 45, 52, 55, 61, 64] },
  Am: { root: 9, strings: [null, 45, 52, 57, 60, 64] },
  B7: { root: 11, strings: [null, 47, 51, 57, 59, 66] },
  Bm: { root: 11, strings: [null, 47, 54, 59, 62, 66] },
};

type Degree = 'I' | 'IV' | 'V' | 'V7' | 'vi' | 'ii' | 'II' | 'I7';

interface Key {
  tonic: number;
  chords: Record<Degree, string>;
}

const KEYS: readonly Key[] = [
  { tonic: 7, chords: { I: 'G', IV: 'C', V: 'D', V7: 'D7', vi: 'Em', ii: 'Am', II: 'A7', I7: 'G7' } },
  { tonic: 2, chords: { I: 'D', IV: 'G', V: 'A', V7: 'A7', vi: 'Bm', ii: 'Em', II: 'E7', I7: 'D7' } },
  { tonic: 0, chords: { I: 'C', IV: 'F', V: 'G', V7: 'G7', vi: 'Am', ii: 'Dm', II: 'D7', I7: 'C7' } },
  { tonic: 9, chords: { I: 'A', IV: 'D', V: 'E', V7: 'E7', vi: 'F#m', ii: 'Bm', II: 'B7', I7: 'A7' } },
];

const INTROS = [
  ['I', 'IV', 'I', 'V7'],
  ['I', 'I', 'V7', 'V7'],
  ['IV', 'I', 'V7', 'V7'],
];
const VERSES = [
  ['I', 'I', 'IV', 'I', 'V7', 'V7', 'I', 'I'],
  ['I', 'IV', 'I', 'V', 'I', 'IV', 'V7', 'I'],
  ['I', 'I', 'IV', 'IV', 'I', 'I', 'V7', 'I'],
  ['I', 'V', 'vi', 'IV', 'I', 'V', 'IV V7', 'I'],
  ['I', 'vi', 'IV', 'V', 'I', 'vi', 'IV V7', 'I'],
  ['I', 'I7', 'IV', 'IV', 'I', 'II', 'V7', 'I'],
];
const BRIDGES = [
  ['IV', 'IV', 'I', 'I', 'V', 'V', 'I', 'V7'],
  ['vi', 'vi', 'IV', 'IV', 'I', 'I', 'V', 'V7'],
  ['IV', 'I', 'IV', 'I', 'II', 'II', 'V', 'V7'],
  ['V', 'V', 'I', 'I', 'IV', 'IV', 'V7', 'V7'],
  ['vi', 'IV', 'I', 'V', 'vi', 'IV', 'V', 'V7'],
];

// D/d down, C upper-strings down, U/u up, c muted chick, B/b bass string root/fifth
const STRUMS = ['D.dU.UdU', 'B.CUb.CU', 'D.DUD.DU', 'B.cUb.cU', 'D.dUdUdU', 'B.CUbUCU'];

// banjo roll roles: 0 L, 1 M, 2 H, 3 drone, 4 low
const ROLLS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 1, 2, 3, 2],
  [2, 1, 3, 2, 1, 3, 2, 1],
  [0, 1, 2, 3, 2, 1, 0, 2],
  [0, 2, 4, 2, 1, 2, 3, 2],
];

const PHRASES = [
  'x-x-x-xxx-------',
  'x-xxx-x-x-x-x---',
  '..xxx-x-x---x---',
  'x--xx-x-x-----..',
  'xxx-x-x-xxx-x---',
  '.xx-x-x-x-xx----',
  'x-x-xxx-x---..xx',
];
const CADENCES = ['x-x-x-x-x-------', 'xxx-x-x-x-------', 'x-xxx-x-x-------', '..x-x-xxx-------'];

const PENT = [0, 2, 4, 7, 9];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

type LeadKind = 'fiddle' | 'harp';

interface LeadTone {
  wave: OscillatorType;
  detune: number;
  lp: number;
  q: number;
  f1: number;
  g1: number;
  f2: number;
  g2: number;
  breath: number;
  breathF: number;
  scoop: number;
  vibRate: number;
  vibDepth: number;
  attack: number;
  release: number;
  level: number;
}

const LEAD: Record<LeadKind, LeadTone> = {
  fiddle: {
    wave: 'sawtooth', detune: 1.004, lp: 3400, q: 0.7, f1: 520, g1: 4, f2: 2600, g2: 5,
    breath: 0.05, breathF: 3200, scoop: 0.972, vibRate: 5.6, vibDepth: 16, attack: 0.05, release: 0.09, level: 0.1,
  },
  harp: {
    wave: 'square', detune: 1.003, lp: 2300, q: 1.1, f1: 1050, g1: 6, f2: 2900, g2: 3,
    breath: 0.1, breathF: 1800, scoop: 0.945, vibRate: 4.6, vibDepth: 10, attack: 0.03, release: 0.07, level: 0.07,
  },
};

type PluckKind = 'gtr' | 'bjo' | 'bass';

interface PluckSpec {
  dur: number;
  t60: number;
  loop: number;
  bright: number;
  tri: number;
  pick: number;
  variants: number;
}

const PLUCK: Record<PluckKind, PluckSpec> = {
  gtr: { dur: 1.8, t60: 2.8, loop: 0.14, bright: 0.5, tri: 0.3, pick: 0.16, variants: 2 },
  bjo: { dur: 1.0, t60: 0.9, loop: 0.06, bright: 0.9, tri: 0.15, pick: 0.09, variants: 2 },
  bass: { dur: 1.4, t60: 1.6, loop: 0.5, bright: 0.12, tri: 0.8, pick: 0.3, variants: 1 },
};

interface Pluck {
  buffer: AudioBuffer;
  rate: number;
}

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

interface LeadNote {
  midi: number;
  len: number;
  vel: number;
  tie: boolean;
}

type SectionKind = 'intro' | 'verse' | 'bridge' | 'outro';
type PercStyle = 'none' | 'light' | 'brush' | 'train';

interface Section {
  kind: SectionKind;
  bars: Chord[][];
  strums: string[];
  lead: Map<number, LeadNote>;
  banjo: number;
  guitar: number;
  perc: PercStyle;
  walk: boolean;
}

interface Song {
  key: Key;
  bpm: number;
  beat: number;
  swing: number;
  strum: string;
  lead: LeadKind;
  drone: number;
  rolls: readonly (readonly number[])[];
  walkUps: number;
  sections: Section[];
}

function tonesIn(pcs: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) if (pcs.includes(pcOf(m))) out.push(m);
  return out;
}

function nearest(list: readonly number[], target: number): number {
  let best = list[0]!;
  for (const m of list) if (Math.abs(m - target) < Math.abs(best - target)) best = m;
  return best;
}

const chordPcs = (c: Chord): number[] => [...new Set(c.strings.filter((m): m is number => m !== null).map(pcOf))];
const scalePcs = (key: Key, degrees: readonly number[]) => degrees.map((d) => pcOf(key.tonic + d));
const bassRoot = (root: number) => 33 + pcOf(root - 9);
const bassFifth = (root: number) => (bassRoot(root) + 7 <= 45 ? bassRoot(root) + 7 : bassRoot(root) - 5);

function scaleBelow(key: Key, m: number, steps: number): number {
  const scale = scalePcs(key, MAJOR);
  let x = m;
  for (let i = 0; i < steps; ) if (scale.includes(pcOf(--x))) i++;
  return x;
}

function parseRhythm(p: string): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== 'x') continue;
    let j = i + 1;
    while (j < p.length && p[j] === '-') j++;
    out.push([i * 2, (j - i) * 2]);
  }
  return out;
}

function swingPos(k: number, swing: number): number {
  const half = k >> 1;
  const start = half ? swing : 0;
  const len = half ? 1 - swing : swing;
  return start + (k & 1 ? len * 0.5 : 0);
}

function chordAt(bars: Chord[][], bar: number, step: number): Chord {
  const b = bars[bar]!;
  return b[step >= 8 && b.length > 1 ? 1 : 0]!;
}

function progression(key: Key, degrees: readonly string[]): Chord[][] {
  return degrees.map((bar) => bar.split(' ').map((d) => CHORDS[key.chords[d as Degree]]!));
}

interface MelNote {
  at: number;
  len: number;
  midi: number;
}

function composeMelody(key: Key, bars: Chord[][]): MelNote[] {
  const scale = tonesIn(scalePcs(key, PENT), LEAD_LO, LEAD_HI);
  const tonic = tonesIn([key.tonic], LEAD_LO, LEAD_HI);
  let cur = nearest(scale, (LEAD_LO + LEAD_HI) / 2);

  const invent = (startBar: number, rhythm: string, cadence: boolean): MelNote[] => {
    const r = parseRhythm(rhythm);
    let dir = pick([-1, 1]);
    return r.map(([pos, len], i) => {
      const at = startBar * 16 + pos;
      const chord = chordAt(bars, at >> 4, at % 16);
      const last = i === r.length - 1;
      let midi: number;
      if (last && cadence) midi = nearest(tonic, cur);
      else if (at % 8 === 0 || last) {
        midi = nearest(tonesIn(chordPcs(chord), LEAD_LO, LEAD_HI), cur + dir * pick([0, 2, 3, 4]));
      } else {
        let idx = scale.indexOf(nearest(scale, cur)) + dir * pick([1, 1, 1, 2]);
        if (idx < 0 || idx >= scale.length) {
          dir = -dir;
          idx = Math.min(scale.length - 1, Math.max(0, idx + dir * 2));
        }
        midi = scale[idx]!;
      }
      if (midi <= LEAD_LO + 2) dir = 1;
      else if (midi >= LEAD_HI - 2) dir = -1;
      else if (Math.random() < 0.3) dir = -dir;
      cur = midi;
      return { at, len, midi };
    });
  };

  const recall = (motif: MelNote[], shiftBars: number, cadence: boolean): MelNote[] =>
    motif.map((n, i) => {
      const at = n.at + shiftBars * 16;
      const chord = chordAt(bars, at >> 4, at % 16);
      const tones = tonesIn(chordPcs(chord), LEAD_LO, LEAD_HI);
      let cands = at % 8 === 0 ? tones : [...scale, ...tones];
      if (cadence && i === motif.length - 1) cands = tonic;
      return { at, len: n.len, midi: nearest(cands, n.midi) };
    });

  const vary = (motif: MelNote[]): MelNote[] =>
    motif.map((n, i) => {
      if (n.at % 8 === 0 || i === motif.length - 1 || Math.random() > 0.35) return n;
      const idx = scale.indexOf(nearest(scale, n.midi)) + pick([-1, 1]);
      return { ...n, midi: scale[Math.min(scale.length - 1, Math.max(0, idx))]! };
    });

  const a = invent(0, pick(PHRASES), false);
  const b = invent(4, pick(PHRASES), false);
  const c = invent(6, pick(CADENCES), true);
  return [
    ...a,
    ...recall(a, 2, false),
    ...b,
    ...c,
    ...recall(a, 8, false),
    ...vary(recall(a, 10, false)),
    ...(Math.random() < 0.5 ? recall(b, 8, false) : invent(12, pick(PHRASES), false)),
    ...recall(c, 8, true),
  ];
}

function toLeadMap(notes: MelNote[], offset = 0, vel = 1): Map<number, LeadNote> {
  const map = new Map<number, LeadNote>();
  notes.forEach((n, i) => {
    const next = notes[i + 1];
    map.set(n.at - offset, {
      midi: n.midi,
      len: n.len,
      vel: vel * (n.at % 8 === 0 ? 1 : 0.85) * rand(0.9, 1.05),
      tie: !!next && next.at === n.at + n.len,
    });
  });
  return map;
}

function makeSong(prev: Song | null): Song {
  const key = pick(KEYS.filter((k) => k !== prev?.key));
  let bpm = Math.round(rand(90, 120));
  while (prev && Math.abs(bpm - prev.bpm) < 8) bpm = Math.round(rand(90, 120));
  const beat = 60 / bpm;
  const strum = pick(STRUMS.filter((s) => s !== prev?.strum));
  const bridgeStrum = pick(STRUMS);
  const lead: LeadKind = prev ? (prev.lead === 'fiddle' ? 'harp' : 'fiddle') : pick(['fiddle', 'harp'] as const);
  const verseBars = progression(key, pick(VERSES));
  const verse16 = [...verseBars, ...verseBars];
  const melody = composeMelody(key, verse16);
  const scale = tonesIn(scalePcs(key, PENT), LEAD_LO, LEAD_HI);
  const banjoIntro = Math.random() < 0.35;
  const banjoBacking = Math.random() < 0.5;
  const bridgePad = Math.random() < 0.5;
  const train = Math.random() < 0.5;
  const walkBridge = Math.random() < 0.6;
  const tonicChord = CHORDS[key.chords.I]!;

  const introBars = progression(key, pick(INTROS));
  const intro = Math.random() < 0.4 ? [...introBars, ...introBars] : introBars;
  const introLead = new Map<number, LeadNote>();
  const first = melody[0]!;
  const fi = scale.indexOf(nearest(scale, first.midi));
  if (Math.random() < 0.7 && fi >= 3 && first.at === 0) {
    const base = (intro.length - 1) * 16;
    [10, 12, 14].forEach((pos, i) =>
      introLead.set(base + pos, { midi: scale[fi - 3 + i]!, len: 2, vel: 0.8, tie: i < 2 }),
    );
  }

  const section = (kind: SectionKind, bars: Chord[][], rest: Partial<Section>): Section => ({
    kind,
    bars,
    strums: bars.map(() => strum),
    lead: new Map(),
    banjo: 0,
    guitar: 1,
    perc: 'brush',
    walk: false,
    ...rest,
  });

  let verses = 0;
  const verse = (full: boolean): Section =>
    section('verse', full ? verse16 : verseBars, {
      lead: full ? toLeadMap(melody) : toLeadMap(melody.filter((n) => n.at >= 128), 128),
      banjo: verses++ > 0 && banjoBacking ? 0.4 : 0,
    });

  const bridge = (): Section => {
    const bars = progression(key, pick(BRIDGES));
    const lead = new Map<number, LeadNote>();
    if (bridgePad) {
      bars.forEach((b, i) => {
        const c = b[0]!;
        const third = pcOf(c.root + (chordPcs(c).includes(pcOf(c.root + 4)) ? 4 : 3));
        lead.set(i * 16, { midi: nearest(tonesIn([third], LEAD_LO, LEAD_HI), 68), len: 15, vel: 0.45, tie: false });
      });
    }
    return section('bridge', bars, {
      strums: bars.map(() => bridgeStrum),
      lead,
      banjo: 1,
      guitar: 0.8,
      perc: train ? 'train' : 'brush',
      walk: walkBridge,
    });
  };

  const sections: Section[] = [
    section('intro', intro, {
      strums: intro.map((_, i) => (i === 0 ? 'D.......' : strum)),
      lead: introLead,
      banjo: banjoIntro ? 0.7 : 0,
      guitar: 0.9,
      perc: 'light',
    }),
    verse(true),
    bridge(),
    verse(true),
  ];
  const targetBars = Math.round(rand(135, 170) / (beat * 4));
  let total = sections.reduce((s, x) => s + x.bars.length, 0) + 2;
  while (targetBars - total >= 12) {
    const full = targetBars - total >= 24;
    sections.push(bridge(), verse(full));
    total += full ? 24 : 16;
  }
  const tonic = nearest(tonesIn([key.tonic], LEAD_LO, LEAD_HI), 69);
  sections.push(
    section('outro', [[tonicChord], [tonicChord]], {
      strums: ['D.......', '........'],
      lead: new Map([[0, { midi: tonic, len: 26, vel: 0.7, tie: false }]]),
      perc: 'none',
    }),
  );

  return {
    key,
    bpm,
    beat,
    swing: rand(0.54, 0.62),
    strum,
    lead,
    drone: nearest(tonesIn([key.tonic], 65, 76), 68),
    rolls: [pick(ROLLS), pick(ROLLS)],
    walkUps: rand(0.3, 0.6),
    sections,
  };
}

function renderPluck(ctx: BaseAudioContext, midi: number, s: PluckSpec): Pluck {
  const f = midiToHz(midi);
  const n = Math.max(2, Math.round(KS_RATE / f - s.loop));
  const len = Math.floor(KS_RATE * s.dur);
  const buffer = ctx.createBuffer(1, len, KS_RATE);
  const y = buffer.getChannelData(0);
  const apex = Math.max(1, Math.round(n * s.pick));
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += s.bright * (Math.random() * 2 - 1 - lp);
    const tri = i < apex ? i / apex : (n - i) / (n - apex);
    y[i] = s.tri * tri + (1 - s.tri) * lp * 2;
  }
  for (let i = n - 1; i >= apex; i--) y[i] -= 0.6 * y[i - apex]!;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += y[i]!;
  mean /= n;
  let peak = 1e-6;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs((y[i] = y[i]! - mean)));
  for (let i = 0; i < n; i++) y[i] = y[i]! / peak;
  const rho = Math.pow(10, -3 / (f * s.t60));
  const b0 = rho * (1 - s.loop);
  const b1 = rho * s.loop;
  y[n] = b0 * y[0]!;
  for (let i = n + 1; i < len; i++) y[i] = b0 * y[i - n]! + b1 * y[i - n - 1]!;
  const fade = Math.floor(len * 0.25);
  for (let i = 0; i < fade; i++) y[len - 1 - i] = y[len - 1 - i]! * (i / fade);
  return { buffer, rate: f / (KS_RATE / (n + s.loop)) };
}

function renderHit(
  ctx: BaseAudioContext, dur: number, freq: number, q: number, attack: number, decay: number, body = 0,
): AudioBuffer {
  const len = Math.floor(KS_RATE * dur);
  const buffer = ctx.createBuffer(1, len, KS_RATE);
  const y = buffer.getChannelData(0);
  const w = (2 * Math.PI * freq) / KS_RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, peak = 1e-6;
  for (let i = 0; i < len; i++) {
    const t = i / KS_RATE;
    const x = Math.random() * 2 - 1;
    const v = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = v;
    const env = t < attack ? t / attack : Math.exp(-(t - attack) / decay);
    const s = v * env + body * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.03);
    y[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < len; i++) y[i] = (0.9 * y[i]!) / peak;
  return buffer;
}

function roomImpulse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 1.1);
  const ir = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = Math.floor(sr * 0.012); i < len; i++) {
      lp += 0.35 * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.9 * i) / sr / 0.85);
    }
    for (const ms of [17, 23, 31, 41, 53]) {
      const i = Math.floor(((ms + ch * 3) / 1000) * sr);
      d[i] = d[i]! + (Math.random() < 0.5 ? -1 : 1) * 0.3 * Math.exp(-ms / 40);
    }
  }
  return ir;
}

function softClip(): Float32Array<ArrayBuffer> {
  const n = 1025;
  const curve = new Float32Array(n);
  const k = Math.tanh(1.4);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(1.4 * ((i / (n - 1)) * 2 - 1)) / k;
  return curve;
}

function chain(...nodes: AudioNode[]): AudioNode {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!);
  return nodes[0]!;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q = 0.707, gain = 0): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  f.gain.value = gain;
  return f;
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

class LeadVoice {
  private readonly tone: LeadTone;
  private readonly oscs: OscillatorNode[];
  private readonly sources: AudioScheduledSourceNode[];
  private readonly nodes: AudioNode[];
  private readonly env: GainNode;
  private readonly vib: GainNode;
  private legato = false;

  constructor(ctx: BaseAudioContext, dest: AudioNode, kind: LeadKind, noise: AudioBuffer, at: number) {
    const tone = (this.tone = LEAD[kind]);
    this.oscs = [0, 1].map(() => {
      const o = ctx.createOscillator();
      o.type = tone.wave;
      o.frequency.value = 440;
      return o;
    });
    const mix = gainNode(ctx, 0.5);
    const breath = ctx.createBufferSource();
    breath.buffer = noise;
    breath.loop = true;
    const breathBp = biquad(ctx, 'bandpass', tone.breathF, 1);
    const breathAmt = gainNode(ctx, tone.breath);
    const p1 = biquad(ctx, 'peaking', tone.f1, 1.2, tone.g1);
    const p2 = biquad(ctx, 'peaking', tone.f2, 1.6, tone.g2);
    const lp = biquad(ctx, 'lowpass', tone.lp, tone.q);
    this.env = gainNode(ctx, 0);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = tone.vibRate;
    this.vib = gainNode(ctx, 0);
    for (const o of this.oscs) {
      o.connect(mix);
      this.vib.connect(o.detune);
    }
    lfo.connect(this.vib);
    chain(mix, p1, p2, lp, this.env, dest);
    chain(breath, breathBp, breathAmt, p1);
    this.sources = [...this.oscs, breath, lfo];
    this.nodes = [mix, breathBp, breathAmt, p1, p2, lp, this.env, this.vib];
    for (const s of this.sources) s.start(at);
    this.oscs[0]!.onended = () => {
      for (const s of this.sources) s.disconnect();
      for (const n of this.nodes) n.disconnect();
    };
  }

  play(t: number, dur: number, midi: number, vel: number, tie: boolean): void {
    const { tone, env, vib } = this;
    const f = midiToHz(midi);
    this.oscs.forEach((o, i) => {
      const target = f * (i ? tone.detune : 1);
      if (this.legato) o.frequency.setTargetAtTime(target, t, 0.018);
      else {
        o.frequency.setValueAtTime(target * tone.scoop, t);
        o.frequency.setTargetAtTime(target, t, 0.04);
      }
    });
    const peak = vel * tone.level;
    env.gain.setTargetAtTime(peak, t, tone.attack);
    env.gain.setTargetAtTime(peak * 0.7, t + tone.attack * 4, Math.max(0.1, dur * 0.6));
    const end = t + Math.max(0.06, dur - 0.03);
    env.gain.setTargetAtTime(tie ? peak * 0.4 : 0, end, tie ? 0.02 : tone.release);
    vib.gain.setTargetAtTime(0, t, 0.02);
    if (dur > 0.3) vib.gain.setTargetAtTime(tone.vibDepth, t + Math.min(0.25, dur * 0.4), 0.15);
    this.legato = tie;
  }

  hush(t: number): void {
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setTargetAtTime(0, t, 0.04);
    this.legato = false;
  }

  stop(t: number): void {
    this.hush(t);
    for (const s of this.sources) s.stop(t + 0.4);
  }
}

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly mix: GainNode;
  private readonly guitarIn: AudioNode;
  private readonly banjoIn: AudioNode;
  private readonly bassIn: AudioNode;
  private readonly leadIn: AudioNode;
  private readonly percIn: AudioNode;
  private readonly noise: AudioBuffer;
  private readonly hits: Record<keyof typeof PERC_GAIN, AudioBuffer[]>;
  private readonly cache = new Map<string, Pluck>();
  private timer: number | null = null;
  private song: Song | null = null;
  private fresh = false;
  private section = 0;
  private bar = 0;
  private step = 0;
  private barStart = 0;
  private walkUp = false;
  private paused = false;
  private voices = 0;
  private gtr: (Voice | null)[] = [];
  private bjo: (Voice | null)[] = [];
  private lead: LeadVoice | null = null;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = gainNode(ctx, 0);
    this.out.connect(destination);
    this.mix = gainNode(ctx, 1);
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClip();
    const radio = biquad(ctx, 'peaking', 1500, 0.8, 2.5);
    chain(this.mix, shaper, biquad(ctx, 'highpass', 120, 0.6), biquad(ctx, 'lowpass', 4800, 0.5), radio);
    radio.connect(gainNode(ctx, 0.85)).connect(this.out);
    const verb = ctx.createConvolver();
    verb.buffer = roomImpulse(ctx);
    chain(radio, gainNode(ctx, 0.3), verb, this.out);

    this.guitarIn = chain(
      gainNode(ctx, 1), biquad(ctx, 'highpass', 75), biquad(ctx, 'peaking', 190, 1, 3),
      biquad(ctx, 'highshelf', 3500, 0.7, -3), this.pan(-0.25),
    );
    this.banjoIn = chain(gainNode(ctx, 1), biquad(ctx, 'highpass', 180), biquad(ctx, 'peaking', 1800, 1.2, 5), this.pan(0.35));
    this.bassIn = chain(gainNode(ctx, 1), biquad(ctx, 'lowpass', 900, 0.8), this.pan(0));
    this.leadIn = this.pan(0.12);
    this.percIn = this.pan(-0.1);

    this.noise = ctx.createBuffer(1, KS_RATE, KS_RATE);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.hits = {
      tick: [0, 1].map(() => renderHit(ctx, 0.06, 6000, 0.7, 0.001, 0.012)),
      snap: [0, 1].map(() => renderHit(ctx, 0.2, 2200, 0.6, 0.002, 0.05, 0.25)),
      swish: [0, 1].map(() => renderHit(ctx, 0.32, 4200, 0.5, 0.08, 0.07)),
    };
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.begin(this.ctx.currentTime + 0.3);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.25);
    this.lead?.stop(now + 1.2);
    this.lead = null;
    this.song = null;
  }

  private begin(at: number): void {
    this.out.gain.cancelScheduledValues(at);
    this.out.gain.setTargetAtTime(OUT_LEVEL, at, 0.5);
    this.song = makeSong(null);
    this.fresh = true;
    this.section = this.bar = this.step = 0;
    this.barStart = at;
    this.paused = false;
    this.gtr = [];
    this.bjo = [];
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || !this.song) return;
    const now = ctx.currentTime;
    if (document.hidden) {
      if (!this.paused) this.lead?.hush(now);
      this.paused = true;
      return;
    }
    this.paused = false;
    this.barStart += Math.max(0, now + 0.05 - this.stepTime());
    this.pump(now + LOOKAHEAD);
  }

  private pump(until: number): void {
    while (this.song && this.stepTime() < until) {
      this.playStep(this.stepTime());
      this.advance();
    }
  }

  private stepTime(): number {
    const s = this.song!;
    return this.barStart + s.beat * ((this.step >> 2) + swingPos(this.step & 3, s.swing));
  }

  private advance(): void {
    const song = this.song!;
    if (++this.step < 16) return;
    this.step = 0;
    this.barStart += song.beat * 4;
    if (++this.bar < song.sections[this.section]!.bars.length) return;
    this.bar = 0;
    if (++this.section < song.sections.length) return;
    this.section = 0;
    this.barStart += rand(2.5, 4.5);
    this.song = makeSong(song);
    this.fresh = true;
  }

  private playStep(t: number): void {
    const song = this.song!;
    const sec = song.sections[this.section]!;
    const { bar, step } = this;
    if (this.fresh) {
      this.fresh = false;
      this.lead?.stop(t);
      this.lead = new LeadVoice(this.ctx, this.leadIn, song.lead, this.noise, t - 0.05);
    }
    const chord = chordAt(sec.bars, bar, step);
    if (!(step & 1)) {
      const ch = sec.strums[bar]![step >> 1]!;
      if (ch !== '.') this.strum(ch, chord, t, sec.guitar * (step % 8 === 0 ? 1.1 : 1));
    }
    if (!(step & 3)) this.bassStep(song, sec, chord, step >> 2, t);
    if (sec.banjo > 0) this.banjoStep(song, sec, chord, t);
    this.percStep(sec.perc, t);
    const n = sec.lead.get(bar * 16 + step);
    if (n) this.lead?.play(t, (n.len * song.beat) / 4, n.midi, n.vel, n.tie);
  }

  private strum(ch: string, chord: Chord, t: number, level: number): void {
    const idx: number[] = [];
    chord.strings.forEach((m, i) => m !== null && idx.push(i));
    const rootStr = idx.find((i) => pcOf(chord.strings[i]!) === chord.root) ?? idx[0]!;
    const fifthStr = idx.find((i) => i > rootStr && pcOf(chord.strings[i]!) === pcOf(chord.root + 7)) ?? rootStr + 1;
    let set: number[];
    let vel: number;
    let mute = false;
    switch (ch) {
      case 'd': set = idx.slice(1); vel = 0.75; break;
      case 'C': set = idx.slice(-4); vel = 0.85; break;
      case 'c': set = idx.slice(-4); vel = 0.8; mute = true; break;
      case 'U': set = idx.slice(-4).reverse(); vel = 0.55; break;
      case 'u': set = idx.slice(-3).reverse(); vel = 0.4; break;
      case 'B': set = [rootStr]; vel = 1.1; break;
      case 'b': set = [fifthStr]; vel = 1; break;
      default: set = idx; vel = 1;
    }
    const up = ch === 'U' || ch === 'u';
    const spread = up ? rand(0.006, 0.009) : rand(0.009, 0.014);
    const t0 = t + rand(-0.004, 0.004);
    set.forEach((s, i) => {
      const midi = chord.strings[s];
      if (midi == null) return;
      const tt = t0 + i * spread;
      this.choke(this.gtr[s], tt);
      const v = this.pluck('gtr', midi, tt, GTR_GAIN * level * vel * rand(0.85, 1.05), this.guitarIn);
      this.gtr[s] = v;
      if (mute) this.choke(v, tt + 0.07, 0.01);
    });
  }

  private bassStep(song: Song, sec: Section, chord: Chord, beat: number, t: number): void {
    const b = song.beat;
    if (sec.kind === 'outro') {
      if (this.bar === 0 && beat === 0) this.bassNote(bassRoot(chord.root), t, b * 3.5, 1);
      return;
    }
    const next = this.nextChord();
    const changes = !!next && next.root !== chord.root;
    const r = bassRoot(chord.root);
    if (sec.walk) {
      const third = r + (chordPcs(chord).includes(pcOf(chord.root + 4)) ? 4 : 3);
      const last = changes ? bassRoot(next!.root) - 1 : r + 9;
      this.bassNote([r, third, r + 7, last][beat]!, t, b * 0.9, beat === 0 ? 1 : 0.8);
      return;
    }
    const two = sec.bars[this.bar]!.length > 1;
    const target = next ? bassRoot(next.root) : r;
    if (beat === 0) {
      this.walkUp = !two && changes && Math.random() < song.walkUps;
      this.bassNote(r, t, b * 1.7, 1);
    } else if (beat === 2) {
      if (two) this.bassNote(r, t, b * 1.7, 0.95);
      else if (this.walkUp) this.bassNote(scaleBelow(song.key, target, 2), t, b * 0.9, 0.85);
      else this.bassNote(bassFifth(chord.root), t, b * 1.7, 0.9);
    } else if (beat === 3 && this.walkUp) {
      this.bassNote(scaleBelow(song.key, target, 1), t, b * 0.9, 0.85);
    }
  }

  private bassNote(midi: number, t: number, dur: number, vel: number): void {
    this.choke(this.pluck('bass', midi, t, BASS_GAIN * vel, this.bassIn), t + dur, 0.04);
  }

  private nextChord(): Chord | null {
    const song = this.song!;
    const sec = song.sections[this.section]!;
    if (this.bar + 1 < sec.bars.length) return sec.bars[this.bar + 1]![0]!;
    return song.sections[this.section + 1]?.bars[0]![0] ?? null;
  }

  private banjoStep(song: Song, sec: Section, chord: Chord, t: number): void {
    const pos = this.step & 7;
    const roll = song.rolls[(this.bar >> 1) % song.rolls.length]!;
    const role = roll[pos]!;
    const tones = tonesIn(chordPcs(chord), 50, 74);
    const midi = [tones[1], tones[2], tones[3] ?? tones[2], song.drone, tones[0]][role] ?? tones[0]!;
    const accent = pos === 0 || pos === 3 || pos === 6;
    this.choke(this.bjo[role], t);
    this.bjo[role] = this.pluck('bjo', midi, t, BJO_GAIN * sec.banjo * (accent ? 1 : 0.7) * rand(0.9, 1.05), this.banjoIn);
  }

  private percStep(style: PercStyle, t: number): void {
    const s = this.step;
    const beat2or4 = s === 4 || s === 12;
    switch (style) {
      case 'light':
        if (!(s & 3)) this.hit('tick', t, 0.6);
        if (beat2or4) this.hit('snap', t, 0.35);
        break;
      case 'brush':
        if (s === 0 || s === 8) this.hit('swish', t - 0.04, 0.8);
        if (beat2or4) this.hit('snap', t, 1);
        else if (!(s & 1)) this.hit('tick', t, s & 2 ? 0.8 : 0.5);
        break;
      case 'train':
        if (beat2or4) this.hit('snap', t, 1);
        else this.hit('tick', t, !(s & 3) ? 0.55 : s & 1 ? 0.4 : 0.8);
        break;
      case 'none':
        break;
    }
  }

  private hit(kind: keyof typeof PERC_GAIN, t: number, vel: number): void {
    this.voice(pick(this.hits[kind]), rand(0.96, 1.04), t, PERC_GAIN[kind] * vel * rand(0.85, 1.1), this.percIn);
  }

  private pluck(kind: PluckKind, midi: number, t: number, gain: number, dest: AudioNode): Voice | null {
    const spec = PLUCK[kind];
    const key = `${kind}${midi}.${Math.floor(Math.random() * spec.variants)}`;
    let p = this.cache.get(key);
    if (p) this.cache.delete(key);
    else p = renderPluck(this.ctx, midi, spec);
    this.cache.set(key, p);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return this.voice(p.buffer, p.rate * rand(0.998, 1.002), t, gain, dest);
  }

  private voice(buffer: AudioBuffer, rate: number, t: number, gain: number, dest: AudioNode): Voice | null {
    if (this.voices >= MAX_VOICES) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = gainNode(this.ctx, gain);
    src.connect(g).connect(dest);
    src.start(Math.max(t, this.ctx.currentTime));
    this.voices++;
    src.onended = () => {
      this.voices--;
      src.disconnect();
      g.disconnect();
    };
    return { src, gain: g };
  }

  private choke(v: Voice | null | undefined, t: number, tau = 0.012): void {
    if (!v) return;
    v.gain.gain.setTargetAtTime(0, t, tau);
    try {
      v.src.stop(t + tau * 10);
    } catch {
      /* already stopped */
    }
  }

  private pan(value: number): AudioNode {
    const ctx = this.ctx;
    if (!ctx.createStereoPanner) return this.mix;
    const p = ctx.createStereoPanner();
    p.pan.value = value;
    p.connect(this.mix);
    return p;
  }
}
