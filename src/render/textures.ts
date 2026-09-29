import * as THREE from 'three';

export const BALL_COLORS: Record<number, string> = {
  1: '#dfa71e',
  2: '#1e3b86',
  3: '#b0271d',
  4: '#4a2866',
  5: '#cf621c',
  6: '#1d6337',
  7: '#6a1e1a',
  8: '#151210',
  9: '#dfa71e',
  10: '#1e3b86',
  11: '#b0271d',
  12: '#4a2866',
  13: '#cf621c',
  14: '#1d6337',
  15: '#6a1e1a',
};

/**
 * Recommended `repeat` for the felt maps when the cloth UVs span 0..1 over a
 * 2.5 x 1.4 m surface (one tile ≈ 0.42 m). Already applied to the returned textures.
 */
export const FELT_REPEAT = { x: 6, y: 3.36 } as const;

type RGB = readonly [number, number, number];
type WoodKind = 'rail' | 'floor' | 'wall' | 'cue' | 'dark';
export interface MapPair {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
}

const IVORY = '#f0e6cc';
const IVORY_RGB: RGB = [243, 234, 211];
const INK_RGB: RGB = [22, 17, 14];
const CUE_DOT_RGB: RGB = [168, 36, 28];
const MAX_ANISOTROPY = 8;

const ballCache = new Map<number, THREE.CanvasTexture>();
const woodCache = new Map<WoodKind, MapPair>();
let feltCache: MapPair | null = null;
let leatherCache: THREE.CanvasTexture | null = null;
let grimeCanvas: HTMLCanvasElement | null = null;

// ---------------------------------------------------------------------------
// Noise helpers (all tileable so textures can use RepeatWrapping seamlessly)
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Value noise in [0,1], periodic with (px, py) lattice cells. */
function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const x0 = mod(xi, px);
  const x1 = mod(xi + 1, px);
  const y0 = mod(yi, py);
  const y1 = mod(yi + 1, py);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in [0,1]; (nx, ny) are normalized tile coords in [0,1). */
function fbm(nx: number, ny: number, px: number, py: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = px;
  let fy = py;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(nx * fx, ny * fy, fx, fy, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

function toTexture(canvas: HTMLCanvasElement, color: boolean, wrapS = true, wrapT = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = wrapS ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = wrapT ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = MAX_ANISOTROPY;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Draws a shape at every wrapped offset so strokes near the edges tile. */
function drawWrapped(w: number, h: number, x: number, y: number, pad: number, draw: (ox: number, oy: number) => void): void {
  const xs = [0];
  const ys = [0];
  if (x < pad) xs.push(w);
  if (x > w - pad) xs.push(-w);
  if (y < pad) ys.push(h);
  if (y > h - pad) ys.push(-h);
  for (const ox of xs) for (const oy of ys) draw(ox, oy);
}

// ---------------------------------------------------------------------------
// Balls
// ---------------------------------------------------------------------------

const BALL_W = 1024;
const BALL_H = 512;
const NUMBER_DISC_RADIUS = 0.4; // radians of arc on the sphere
const GLYPH_SIZE = 256;

type V3 = [number, number, number];

function norm3(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Direction on the unit sphere for a canvas pixel, matching THREE.SphereGeometry UVs. */
function pixelDirection(px: number, py: number): V3 {
  const phi = ((px + 0.5) / BALL_W) * Math.PI * 2;
  const theta = ((py + 0.5) / BALL_H) * Math.PI;
  const s = Math.sin(theta);
  return [-Math.cos(phi) * s, Math.cos(theta), Math.sin(phi) * s];
}

function getGrimeCanvas(): HTMLCanvasElement {
  if (grimeCanvas) return grimeCanvas;
  const [canvas, ctx] = makeCanvas(BALL_W, BALL_H);
  const img = ctx.createImageData(BALL_W, BALL_H);
  const d = img.data;
  for (let y = 0; y < BALL_H; y++) {
    for (let x = 0; x < BALL_W; x++) {
      const n = fbm(x / BALL_W, y / BALL_H, 8, 4, 91, 4);
      const speck = hash2(x, y, 7) > 0.997 ? 0.9 : 1;
      const k = (0.93 + 0.07 * n) * speck;
      const i = (y * BALL_W + x) * 4;
      d[i] = 255 * k;
      d[i + 1] = 250 * k;
      d[i + 2] = 238 * k;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  grimeCanvas = canvas;
  return canvas;
}

function createGlyph(num: number): Float32Array {
  const [, ctx] = makeCanvas(GLYPH_SIZE, GLYPH_SIZE);
  const text = String(num);
  const fontSize = GLYPH_SIZE * 0.62;
  ctx.font = `bold ${fontSize}px Georgia, "Times New Roman", "DejaVu Serif", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(text);
  const ascent = m.actualBoundingBoxAscent || fontSize * 0.7;
  const descent = m.actualBoundingBoxDescent || 0;
  const maxWidth = GLYPH_SIZE * 0.72;
  const sx = m.width > maxWidth ? maxWidth / m.width : 1;
  const underline = num === 6 || num === 9;
  const lift = underline ? GLYPH_SIZE * 0.04 : 0;
  const baseline = GLYPH_SIZE / 2 + (ascent - descent) / 2 - lift;
  ctx.fillStyle = '#000';
  ctx.save();
  ctx.translate(GLYPH_SIZE / 2, baseline);
  ctx.scale(sx, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  if (underline) {
    const w = GLYPH_SIZE * 0.3;
    ctx.fillRect(GLYPH_SIZE / 2 - w / 2, baseline + GLYPH_SIZE * 0.05, w, GLYPH_SIZE * 0.04);
  }
  const data = ctx.getImageData(0, 0, GLYPH_SIZE, GLYPH_SIZE).data;
  const alpha = new Float32Array(GLYPH_SIZE * GLYPH_SIZE);
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3] / 255;
  return alpha;
}

function sampleBilinear(a: Float32Array, size: number, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (ix: number, iy: number): number =>
    ix < 0 || iy < 0 || ix >= size || iy >= size ? 0 : a[iy * size + ix];
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/**
 * Paints a true spherical disc (round once wrapped on the ball) and optionally a
 * number glyph projected gnomonically onto it, so it has no equirectangular stretch.
 */
function paintSphericalDisc(
  ctx: CanvasRenderingContext2D,
  center: V3,
  radius: number,
  color: RGB,
  glyph: Float32Array | null,
): void {
  const c = norm3(center);
  const worldUp: V3 = Math.abs(c[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0];
  const right = norm3(cross3(worldUp, c));
  const up = cross3(c, right);
  const theta0 = Math.acos(c[1]);
  const phi0 = mod(Math.atan2(c[2], -c[0]), Math.PI * 2);
  const margin = radius + 0.02;
  const pxAngle = Math.PI / BALL_H;

  const py0 = Math.max(0, Math.floor(((theta0 - margin) / Math.PI) * BALL_H));
  const py1 = Math.min(BALL_H, Math.ceil(((theta0 + margin) / Math.PI) * BALL_H));
  const minSin = Math.max(0.05, Math.min(Math.sin(Math.max(0, theta0 - margin)), Math.sin(Math.min(Math.PI, theta0 + margin))));
  const phiSpan = margin / minSin;
  let px0 = 0;
  let px1 = BALL_W;
  if (phiSpan < Math.PI * 0.9 && theta0 - margin > 0 && theta0 + margin < Math.PI) {
    px0 = Math.max(0, Math.floor(((phi0 - phiSpan) / (Math.PI * 2)) * BALL_W));
    px1 = Math.min(BALL_W, Math.ceil(((phi0 + phiSpan) / (Math.PI * 2)) * BALL_W));
  }
  const w = px1 - px0;
  const h = py1 - py0;
  if (w <= 0 || h <= 0) return;

  const img = ctx.getImageData(px0, py0, w, h);
  const d = img.data;
  const tanR = Math.tan(radius);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pixelDirection(px0 + x, py0 + y);
      const cosA = p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
      if (cosA <= 0) continue;
      const ang = Math.acos(Math.min(1, cosA));
      const cover = clamp01((radius - ang) / pxAngle + 0.5);
      if (cover <= 0) continue;
      const i = (y * w + x) * 4;
      d[i] += (color[0] - d[i]) * cover;
      d[i + 1] += (color[1] - d[i + 1]) * cover;
      d[i + 2] += (color[2] - d[i + 2]) * cover;
      if (!glyph) continue;
      const lx = (p[0] * right[0] + p[1] * right[1] + p[2] * right[2]) / cosA;
      const ly = (p[0] * up[0] + p[1] * up[1] + p[2] * up[2]) / cosA;
      const gx = (lx / tanR * 0.5 + 0.5) * GLYPH_SIZE;
      const gy = (0.5 - ly / tanR * 0.5) * GLYPH_SIZE;
      const ink = sampleBilinear(glyph, GLYPH_SIZE, gx, gy) * cover;
      if (ink <= 0) continue;
      d[i] += (INK_RGB[0] - d[i]) * ink;
      d[i + 1] += (INK_RGB[1] - d[i + 1]) * ink;
      d[i + 2] += (INK_RGB[2] - d[i + 2]) * ink;
    }
  }
  ctx.putImageData(img, px0, py0);
}

export function createBallTexture(num: number): THREE.CanvasTexture {
  const cached = ballCache.get(num);
  if (cached) return cached;

  const [canvas, ctx] = makeCanvas(BALL_W, BALL_H);
  const striped = num >= 9 && num <= 15;
  const color = BALL_COLORS[num] ?? IVORY;

  ctx.fillStyle = num === 0 || striped ? IVORY : color;
  ctx.fillRect(0, 0, BALL_W, BALL_H);
  if (striped) {
    ctx.fillStyle = color;
    ctx.fillRect(0, BALL_H * 0.28, BALL_W, BALL_H * 0.44);
  }
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(getGrimeCanvas(), 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  if (num === 0) {
    paintSphericalDisc(ctx, [0.3, 0.45, 0.84], 0.055, CUE_DOT_RGB, null);
    paintSphericalDisc(ctx, [-0.6, -0.3, -0.74], 0.055, CUE_DOT_RGB, null);
  } else {
    const glyph = createGlyph(num);
    paintSphericalDisc(ctx, [0, 0, 1], NUMBER_DISC_RADIUS, IVORY_RGB, glyph);
    paintSphericalDisc(ctx, [0, 0, -1], NUMBER_DISC_RADIUS, IVORY_RGB, glyph);
  }

  const tex = toTexture(canvas, true, true, false);
  tex.name = `ball-${num}`;
  ballCache.set(num, tex);
  return tex;
}

// ---------------------------------------------------------------------------
// Felt
// ---------------------------------------------------------------------------

export function createFeltTexture(): MapPair {
  if (feltCache) return feltCache;
  const S = 512;
  const [mapCanvas, mctx] = makeCanvas(S, S);
  const [bumpCanvas, bctx] = makeCanvas(S, S);
  const mapImg = mctx.createImageData(S, S);
  const bumpImg = bctx.createImageData(S, S);
  const md = mapImg.data;
  const bd = bumpImg.data;
  const base: RGB = [30, 90, 56];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = x / S;
      const ny = y / S;
      const low = fbm(nx, ny, 3, 3, 11, 3);
      const fine = tileNoise(nx * 170, ny * 170, 170, 170, 12);
      const nap = tileNoise(nx * 24, ny * 220, 24, 220, 13);
      const shade = 0.93 + 0.1 * (low - 0.5) + 0.07 * (fine - 0.5) + 0.06 * (nap - 0.5);
      const i = (y * S + x) * 4;
      md[i] = base[0] * shade;
      md[i + 1] = base[1] * shade;
      md[i + 2] = base[2] * shade;
      md[i + 3] = 255;
      const b = 128 + 70 * (fine - 0.5) + 50 * (nap - 0.5);
      bd[i] = bd[i + 1] = bd[i + 2] = b;
      bd[i + 3] = 255;
    }
  }
  mctx.putImageData(mapImg, 0, 0);
  bctx.putImageData(bumpImg, 0, 0);

  const rand = mulberry32(4242);
  mctx.lineWidth = 0.7;
  bctx.lineWidth = 0.7;
  for (let f = 0; f < 3200; f++) {
    const x = rand() * S;
    const y = rand() * S;
    const len = 2 + rand() * 7;
    const a = rand() * Math.PI * 2;
    const bend = (rand() - 0.5) * 4;
    const light = rand() > 0.5;
    mctx.strokeStyle = light ? 'rgba(90,150,110,0.10)' : 'rgba(5,25,14,0.12)';
    bctx.strokeStyle = light ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
    drawWrapped(S, S, x, y, 10, (ox, oy) => {
      for (const c of [mctx, bctx]) {
        c.beginPath();
        c.moveTo(x + ox, y + oy);
        c.quadraticCurveTo(
          x + ox + Math.cos(a) * len * 0.5 + bend,
          y + oy + Math.sin(a) * len * 0.5 - bend,
          x + ox + Math.cos(a) * len,
          y + oy + Math.sin(a) * len,
        );
        c.stroke();
      }
    });
  }

  const map = toTexture(mapCanvas, true);
  const bumpMap = toTexture(bumpCanvas, false);
  for (const t of [map, bumpMap]) t.repeat.set(FELT_REPEAT.x, FELT_REPEAT.y);
  map.name = 'felt';
  bumpMap.name = 'felt-bump';
  feltCache = { map, bumpMap };
  return feltCache;
}

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

interface WoodSpec {
  width: number;
  height: number;
  vertical: boolean;
  light: RGB;
  dark: RGB;
  rings: number;
  warp: number;
  planks: number;
  endJoints: number;
  wear: number;
  knots: number;
  seed: number;
}

const WOOD_SPECS: Record<WoodKind, WoodSpec> = {
  rail: { width: 1024, height: 256, vertical: false, light: [118, 44, 26], dark: [52, 16, 9], rings: 7, warp: 1.6, planks: 0, endJoints: 0, wear: 0, knots: 0, seed: 101 },
  floor: { width: 1024, height: 1024, vertical: false, light: [112, 84, 58], dark: [52, 36, 24], rings: 3, warp: 1.2, planks: 10, endJoints: 2, wear: 1, knots: 7, seed: 202 },
  wall: { width: 512, height: 1024, vertical: true, light: [96, 64, 40], dark: [40, 25, 15], rings: 4, warp: 1.5, planks: 8, endJoints: 0, wear: 0.5, knots: 10, seed: 303 },
  cue: { width: 1024, height: 128, vertical: false, light: [226, 196, 150], dark: [176, 134, 86], rings: 4, warp: 0.9, planks: 0, endJoints: 0, wear: 0, knots: 0, seed: 404 },
  dark: { width: 512, height: 512, vertical: false, light: [48, 31, 20], dark: [16, 9, 6], rings: 8, warp: 1.4, planks: 0, endJoints: 0, wear: 0, knots: 0, seed: 505 },
};

/** Smooth tileable field sampled on a coarse grid and bilinearly interpolated (much cheaper than per-pixel fbm). */
function coarseField(cellsA: number, cellsB: number, fn: (a: number, b: number) => number): (a: number, b: number) => number {
  const stride = cellsA + 1;
  const data = new Float32Array(stride * (cellsB + 1));
  for (let j = 0; j <= cellsB; j++) for (let i = 0; i <= cellsA; i++) data[j * stride + i] = fn(i / cellsA, j / cellsB);
  return (a, b) => {
    const fa = a * cellsA;
    const fb = b * cellsB;
    const i = Math.min(cellsA - 1, Math.floor(fa));
    const j = Math.min(cellsB - 1, Math.floor(fb));
    const ta = fa - i;
    const tb = fb - j;
    const k = j * stride + i;
    const top = data[k] + (data[k + 1] - data[k]) * ta;
    const bottom = data[k + stride] + (data[k + stride + 1] - data[k + stride]) * ta;
    return top + (bottom - top) * tb;
  };
}

function jointPositions(spec: WoodSpec, plank: number): number[] {
  const out: number[] = [];
  for (let j = 0; j < spec.endJoints; j++) {
    out.push((j + 0.15 + 0.7 * hash2(plank, j, spec.seed + 1)) / spec.endJoints);
  }
  return out;
}

export function createWoodTexture(kind: WoodKind): MapPair {
  const cached = woodCache.get(kind);
  if (cached) return cached;
  const spec = WOOD_SPECS[kind];
  const W = spec.width;
  const H = spec.height;
  const [mapCanvas, mctx] = makeCanvas(W, H);
  const [bumpCanvas, bctx] = makeCanvas(W, H);
  const mapImg = mctx.createImageData(W, H);
  const bumpImg = bctx.createImageData(W, H);
  const md = mapImg.data;
  const bd = bumpImg.data;

  const alongPx = spec.vertical ? H : W;
  const acrossPx = spec.vertical ? W : H;
  const plankPx = spec.planks > 0 ? acrossPx / spec.planks : acrossPx;
  const joints = Array.from({ length: Math.max(1, spec.planks) }, (_, k) => jointPositions(spec, k));
  const acrossCells = Math.max(4, spec.planks || 6);
  const fiberAcross = Math.round(acrossPx / 3);
  const gridA = Math.round(alongPx / 4);
  const gridB = Math.round(acrossPx / 4);
  const warpField = coarseField(gridA, gridB, (a, b) => fbm(a, b, 3, acrossCells, spec.seed + 5, 3));
  const lowField = coarseField(gridA, gridB, (a, b) => fbm(a, b, 2, 2, spec.seed + 13, 2));
  const wearField = spec.wear > 0 ? coarseField(gridA, gridB, (a, b) => fbm(a, b, 3, 3, spec.seed + 21, 3)) : null;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = (spec.vertical ? y : x) / alongPx;
      const b = (spec.vertical ? x : y) / acrossPx;
      let local = b;
      let plankId = 0;
      let segment = 0;
      let edge = 1;
      if (spec.planks > 0) {
        const pb = b * spec.planks;
        plankId = Math.floor(pb);
        local = pb - plankId;
        edge = Math.min(local, 1 - local) * plankPx;
        const js = joints[plankId];
        for (let j = 0; j < js.length; j++) if (a >= js[j]) segment = j + 1;
        if (segment === js.length) segment = 0;
        for (const jp of js) {
          const dj = Math.abs(a - jp) * alongPx;
          edge = Math.min(edge, dj);
        }
      }
      const pSeed = hash2(plankId, segment, spec.seed);
      const pTint = spec.planks > 0 ? (pSeed - 0.5) * 0.28 : 0;
      const warp = warpField(a, b);
      const t = (spec.planks > 0 ? local : b) * spec.rings + warp * spec.warp * spec.rings * 0.35 + pSeed * 10;
      const ring = 0.5 + 0.5 * Math.cos(t * Math.PI * 2);
      const grain = Math.pow(ring, 7) * 0.7 + ring * ring * 0.25;
      const fiber = tileNoise(a * 5, b * fiberAcross, 5, fiberAcross, spec.seed + 9);
      const low = lowField(a, b);

      let k = clamp01(grain * 0.6 + fiber * 0.3 + 0.1);
      k = clamp01(k + pTint);
      let lum = 0.88 + 0.24 * (low - 0.5) + pTint * 0.3;
      let height = 0.62 - grain * 0.22 - fiber * 0.12;

      if (spec.planks > 0 || spec.endJoints > 0) {
        const gap = 1 - smoothstep(0.6, 2.2, edge);
        const bevel = 1 - smoothstep(1.5, 6, edge);
        lum *= 1 - gap * 0.8 - bevel * 0.15;
        height = height * (1 - gap) - bevel * 0.1;
      }
      if (wearField) {
        const worn = smoothstep(0.55, 0.85, wearField(a, b));
        lum *= 1 + worn * 0.12 * spec.wear;
        k *= 1 - worn * 0.3 * spec.wear;
      }

      const i = (y * W + x) * 4;
      md[i] = (spec.light[0] + (spec.dark[0] - spec.light[0]) * k) * lum;
      md[i + 1] = (spec.light[1] + (spec.dark[1] - spec.light[1]) * k) * lum;
      md[i + 2] = (spec.light[2] + (spec.dark[2] - spec.light[2]) * k) * lum;
      md[i + 3] = 255;
      const hb = clamp01(height) * 255;
      bd[i] = bd[i + 1] = bd[i + 2] = hb;
      bd[i + 3] = 255;
    }
  }
  mctx.putImageData(mapImg, 0, 0);
  bctx.putImageData(bumpImg, 0, 0);

  const rand = mulberry32(spec.seed * 7 + 3);
  const toXY = (along: number, across: number): [number, number] =>
    spec.vertical ? [across * W, along * H] : [along * W, across * H];

  for (let n = 0; n < spec.knots; n++) {
    const [kx, ky] = toXY(rand(), rand());
    const r = 5 + rand() * 9;
    const sa = spec.vertical ? 1 : 2.4;
    const sb = spec.vertical ? 2.4 : 1;
    drawWrapped(W, H, kx, ky, r * 3, (ox, oy) => {
      for (let ring = 3; ring >= 0; ring--) {
        const rr = r * (1 + ring * 0.55);
        mctx.fillStyle = `rgba(${spec.dark[0] * 0.6},${spec.dark[1] * 0.6},${spec.dark[2] * 0.6},${0.12 + (3 - ring) * 0.12})`;
        mctx.beginPath();
        mctx.ellipse(kx + ox, ky + oy, rr * sa, rr * sb, 0, 0, Math.PI * 2);
        mctx.fill();
      }
      bctx.fillStyle = 'rgba(0,0,0,0.35)';
      bctx.beginPath();
      bctx.ellipse(kx + ox, ky + oy, r * sa, r * sb, 0, 0, Math.PI * 2);
      bctx.fill();
    });
  }

  if (spec.planks > 0) {
    mctx.fillStyle = 'rgba(12,8,5,0.85)';
    bctx.fillStyle = 'rgba(0,0,0,0.9)';
    for (let p = 0; p < spec.planks; p++) {
      const ends = joints[p].length ? joints[p] : [0.02];
      for (const jp of ends) {
        for (const side of [-1, 1]) {
          for (const across of [0.25, 0.75]) {
            const [nx, ny] = toXY(jp + side * (6 / alongPx), (p + across) / spec.planks);
            for (const c of [mctx, bctx]) {
              c.beginPath();
              c.arc(mod(nx, W), mod(ny, H), 1.8, 0, Math.PI * 2);
              c.fill();
            }
          }
        }
      }
    }
  }

  if (spec.wear > 0) {
    for (let s = 0; s < 260 * spec.wear; s++) {
      const x = rand() * W;
      const y = rand() * H;
      const len = 6 + rand() * 40;
      const ang = (spec.vertical ? Math.PI / 2 : 0) + (rand() - 0.5) * 0.5;
      mctx.strokeStyle = rand() > 0.4 ? 'rgba(170,140,105,0.10)' : 'rgba(20,12,6,0.14)';
      mctx.lineWidth = 0.6 + rand();
      drawWrapped(W, H, x, y, len + 2, (ox, oy) => {
        mctx.beginPath();
        mctx.moveTo(x + ox, y + oy);
        mctx.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len);
        mctx.stroke();
      });
    }
  }

  const map = toTexture(mapCanvas, true);
  const bumpMap = toTexture(bumpCanvas, false);
  map.name = `wood-${kind}`;
  bumpMap.name = `wood-${kind}-bump`;
  const pair = { map, bumpMap };
  woodCache.set(kind, pair);
  return pair;
}

// ---------------------------------------------------------------------------
// Leather
// ---------------------------------------------------------------------------

export function createLeatherTexture(): THREE.CanvasTexture {
  if (leatherCache) return leatherCache;
  const S = 512;
  const CELLS = 36;
  const [canvas, ctx] = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const base: RGB = [66, 38, 22];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const cx = (x / S) * CELLS;
      const cy = (y / S) * CELLS;
      const ix = Math.floor(cx);
      const iy = Math.floor(cy);
      let f1 = 9;
      let f2 = 9;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = ix + ox;
          const gy = iy + oy;
          const wx = mod(gx, CELLS);
          const wy = mod(gy, CELLS);
          const fx = gx + hash2(wx, wy, 31);
          const fy = gy + hash2(wx, wy, 32);
          const dist = Math.hypot(cx - fx, cy - fy);
          if (dist < f1) {
            f2 = f1;
            f1 = dist;
          } else if (dist < f2) {
            f2 = dist;
          }
        }
      }
      const pebble = smoothstep(0.02, 0.22, f2 - f1);
      const low = fbm(x / S, y / S, 3, 3, 33, 3);
      const crease = 1 - 0.35 * (1 - smoothstep(0.0, 0.035, Math.abs(fbm(x / S, y / S, 2, 2, 34, 3) - 0.5)));
      const k = (0.7 + 0.32 * pebble) * (0.85 + 0.3 * (low - 0.5)) * crease;
      const i = (y * S + x) * 4;
      d[i] = base[0] * k;
      d[i + 1] = base[1] * k;
      d[i + 2] = base[2] * k;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  leatherCache = toTexture(canvas, true);
  leatherCache.name = 'leather';
  return leatherCache;
}
