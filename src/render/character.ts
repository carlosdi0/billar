import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type CharacterAction = 'idle' | 'walk' | 'run' | 'sit' | 'drink' | 'lean' | 'wave';
export type CharacterHand = 'L' | 'R';
export type CharacterQuality = 'low' | 'high';

export interface CharacterLook {
  skin: string;
  shirt: string;
  vest: string;
  pants: string;
  hat: 'cowboy' | 'bowler' | 'none';
  hatColor: string;
  bandana?: string;
  mustache?: boolean;
  dress?: boolean;
  name?: string;
  hair?: string;
  boots?: string;
  beard?: boolean;
  handlebar?: boolean;
  holster?: boolean;
  poncho?: boolean;
  apron?: boolean;
  badge?: boolean;
  sleeves?: 'long' | 'rolled';
}

const BONES = ['pelvis', 'spine', 'head', 'armL', 'foreL', 'armR', 'foreR', 'thighL', 'shinL', 'thighR', 'shinR'] as const;
export type CharacterBone = (typeof BONES)[number];

/** Runs after the action pose is evaluated and blended; overwrite or add to any channel. */
export type PoseDriver = (pose: CharacterPose, time: number, dt: number) => void;

export interface Character {
  readonly object: THREE.Group;
  readonly height: number;
  readonly headAnchor: THREE.Object3D;
  readonly action: CharacterAction;
  /** `immediate` skips the blend (spawning, teleports). */
  setAction(action: CharacterAction, immediate?: boolean): void;
  setSpeed(metersPerSecond: number): void;
  setFace(texture: THREE.Texture | null): void;
  setLook(look: CharacterLook): void;
  update(dt: number, time: number): void;
  dispose(): void;
  /** Seat surface height above the floor used by `sit` (chair 0.48, bar stool 0.76). */
  setSeatHeight(height: number): void;
  /** Palm anchor: +Y points out of the top of the fist, +X towards the body midline. */
  hand(side: CharacterHand): THREE.Object3D;
  setPoseDriver(driver: PoseDriver | null): void;
  setCastShadow(enabled: boolean): void;
}

export interface CharacterOptions {
  quality?: CharacterQuality;
  /** Uniform scale applied to `object`; `height` accounts for it. */
  scale?: number;
  /** Emissive boost on the face photo so it reads in the dim saloon (0..1). */
  faceGlow?: number;
  /** Seed for the idle/look-around variation. */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Skeleton (metres, faces +Z, the character's left hand is on +X)
// ---------------------------------------------------------------------------

type V3 = readonly [number, number, number];
const NB = BONES.length;
const BI = Object.fromEntries(BONES.map((b, i) => [b, i])) as Record<CharacterBone, number>;

const PARENT: Record<CharacterBone, CharacterBone | null> = {
  pelvis: null,
  spine: 'pelvis',
  head: 'spine',
  armL: 'spine',
  foreL: 'armL',
  armR: 'spine',
  foreR: 'armR',
  thighL: 'pelvis',
  shinL: 'thighL',
  thighR: 'pelvis',
  shinR: 'thighR',
};

const PELVIS_Y = 0.95;
const PIVOT: Record<CharacterBone, V3> = {
  pelvis: [0, PELVIS_Y, 0],
  spine: [0, 0.08, 0],
  head: [0, 0.46, 0],
  armL: [0.2, 0.4, 0],
  foreL: [0, -0.3, 0],
  armR: [-0.2, 0.4, 0],
  foreR: [0, -0.3, 0],
  thighL: [0.095, -0.03, 0],
  shinL: [0, -0.42, 0],
  thighR: [-0.095, -0.03, 0],
  shinR: [0, -0.42, 0],
};

const BIND: Record<CharacterBone, V3> = (() => {
  const out = {} as Record<CharacterBone, V3>;
  for (const b of BONES) {
    const p = PARENT[b];
    const base = p ? out[p] : ([0, 0, 0] as const);
    out[b] = [base[0] + PIVOT[b][0], base[1] + PIVOT[b][1], base[2] + PIVOT[b][2]];
  }
  return out;
})();

const BONE_INVERSES = BONES.map((b) => new THREE.Matrix4().makeTranslation(-BIND[b][0], -BIND[b][1], -BIND[b][2]));
const IDENTITY = new THREE.Matrix4();
const HAND_Y = -0.3;
const LEG_LENGTH = 0.92;

// Head: a superellipsoid, flatter at the front so a photo reads well.
const HEAD = { y: 0.145, z: 0.012, a: 0.118, b: 0.138, c: 0.122 } as const;
const CROWN = BIND.head[1] + HEAD.y + HEAD.b;
// The photo square spans `size`; the visible oval covers rx/ry of it (a centred selfie face).
const FACE = { size: 0.31, y: 0.14, rx: 0.34, ry: 0.44, lift: 0.0035 } as const;

// ---------------------------------------------------------------------------
// Pose buffer
// ---------------------------------------------------------------------------

const POSE_LEN = NB * 3 + 3;
const PELVIS_POS = NB * 3;

export class CharacterPose {
  readonly data = new Float32Array(POSE_LEN);

  set(bone: CharacterBone, x: number, y: number, z: number): void {
    const i = BI[bone] * 3;
    this.data[i] = x;
    this.data[i + 1] = y;
    this.data[i + 2] = z;
  }

  add(bone: CharacterBone, x: number, y: number, z: number): void {
    const i = BI[bone] * 3;
    this.data[i] += x;
    this.data[i + 1] += y;
    this.data[i + 2] += z;
  }

  get(bone: CharacterBone, axis: 0 | 1 | 2): number {
    return this.data[BI[bone] * 3 + axis];
  }

  mix(bone: CharacterBone, a: V3, b: V3, w: number, dx = 0, dy = 0, dz = 0): void {
    this.set(bone, a[0] + (b[0] - a[0]) * w + dx, a[1] + (b[1] - a[1]) * w + dy, a[2] + (b[2] - a[2]) * w + dz);
  }

  /** Pelvis position relative to the feet origin (rest: 0, 0.95, 0). */
  setPelvis(x: number, y: number, z: number): void {
    this.data[PELVIS_POS] = x;
    this.data[PELVIS_POS + 1] = y;
    this.data[PELVIS_POS + 2] = z;
  }

  addPelvis(x: number, y: number, z: number): void {
    this.data[PELVIS_POS] += x;
    this.data[PELVIS_POS + 1] += y;
    this.data[PELVIS_POS + 2] += z;
  }

  copy(other: CharacterPose): void {
    this.data.set(other.data);
  }

  lerp(from: CharacterPose, to: CharacterPose, w: number): void {
    const a = from.data;
    const b = to.data;
    const d = this.data;
    for (let i = 0; i < POSE_LEN; i++) d[i] = a[i] + (b[i] - a[i]) * w;
  }
}

// ---------------------------------------------------------------------------
// Palette (one 16x1 texel row per look; geometry UVs point at slots)
// ---------------------------------------------------------------------------

const SLOTS = ['skin', 'skinShade', 'shirt', 'vest', 'pants', 'hat', 'band', 'boots', 'hair', 'belt', 'metal', 'eye', 'white', 'bandana', 'lace', 'cloth'] as const;
type Slot = (typeof SLOTS)[number];
const PALETTE_W = SLOTS.length;
const SLOT_U = Object.fromEntries(SLOTS.map((s, i) => [s, (i + 0.5) / PALETTE_W])) as Record<Slot, number>;

const tmpColor = new THREE.Color();
const tmpRGB = { r: 0, g: 0, b: 0 };

function writePalette(data: Uint8Array, look: CharacterLook): void {
  const put = (slot: Slot, css: string, k = 1, kr = k): void => {
    tmpColor.set(css).getRGB(tmpRGB, THREE.SRGBColorSpace);
    const i = SLOTS.indexOf(slot) * 4;
    data[i] = THREE.MathUtils.clamp(tmpRGB.r * kr * 255, 0, 255);
    data[i + 1] = THREE.MathUtils.clamp(tmpRGB.g * k * 255, 0, 255);
    data[i + 2] = THREE.MathUtils.clamp(tmpRGB.b * k * 255, 0, 255);
    data[i + 3] = 255;
  };
  put('skin', look.skin);
  put('skinShade', look.skin, 0.72, 0.84);
  put('shirt', look.shirt);
  put('vest', look.vest);
  put('pants', look.pants);
  put('hat', look.hatColor);
  put('band', look.hatColor, 0.45);
  put('boots', look.boots ?? '#34231a');
  put('hair', look.hair ?? '#2a1e16');
  put('belt', '#2c1e15');
  put('metal', '#b08e52');
  put('eye', '#140e0a');
  put('white', '#e6ddcc');
  put('bandana', look.bandana ?? '#7a2a22');
  put('lace', '#ddd3bd');
  put('cloth', '#d8d2c2');
}

function paletteKey(look: CharacterLook): string {
  return [look.skin, look.shirt, look.vest, look.pants, look.hatColor, look.boots, look.hair, look.bandana].join('|');
}

interface SharedMaterial {
  material: THREE.MeshStandardMaterial;
  refs: number;
}

const materialCache = new Map<string, SharedMaterial>();

function acquireMaterial(look: CharacterLook): THREE.MeshStandardMaterial {
  const key = paletteKey(look);
  const cached = materialCache.get(key);
  if (cached) {
    cached.refs++;
    return cached.material;
  }
  const data = new Uint8Array(PALETTE_W * 4);
  writePalette(data, look);
  const map = new THREE.DataTexture(data, PALETTE_W, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.86, metalness: 0, envMapIntensity: 0.35 });
  material.name = `character-${key}`;
  materialCache.set(key, { material, refs: 1 });
  return material;
}

function releaseMaterial(material: THREE.MeshStandardMaterial): void {
  for (const [key, entry] of materialCache) {
    if (entry.material !== material) continue;
    if (--entry.refs > 0) return;
    entry.material.map?.dispose();
    entry.material.dispose();
    materialCache.delete(key);
    return;
  }
}

// ---------------------------------------------------------------------------
// Part builders
// ---------------------------------------------------------------------------

interface Detail {
  radial: number;
  sw: number;
  sh: number;
  brim: number;
  headW: number;
  headH: number;
  face: number;
}

const DETAIL: Record<CharacterQuality, Detail> = {
  high: { radial: 10, sw: 12, sh: 8, brim: 20, headW: 26, headH: 18, face: 18 },
  low: { radial: 7, sw: 8, sh: 6, brim: 12, headW: 16, headH: 11, face: 10 },
};

const PI = Math.PI;
const TAU = PI * 2;

function paint(g: THREE.BufferGeometry, slot: Slot): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const count = g.getAttribute('position').count;
  const uv = new Float32Array(count * 2);
  const u = SLOT_U[slot];
  for (let i = 0; i < count; i++) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = 0.5;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const cyl = (rt: number, rb: number, h: number, radial: number, y: number, slot: Slot): THREE.BufferGeometry =>
  paint(new THREE.CylinderGeometry(rt, rb, h, radial).translate(0, y, 0), slot);

const ball = (r: number, d: Detail, x: number, y: number, z: number, slot: Slot, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry =>
  paint(new THREE.SphereGeometry(r, d.sw, d.sh).scale(sx, sy, sz).translate(x, y, z), slot);

const cube = (w: number, h: number, depth: number, x: number, y: number, z: number, slot: Slot, rz = 0, ry = 0): THREE.BufferGeometry =>
  paint(new THREE.BoxGeometry(w, h, depth).rotateZ(rz).rotateY(ry).translate(x, y, z), slot);

function lathe(points: readonly (readonly [number, number])[], radial: number, slot: Slot, sz = 1): THREE.BufferGeometry {
  const profile = points.map(([r, y]) => new THREE.Vector2(r, y));
  if (profile[0].y > profile[profile.length - 1].y) profile.reverse();
  return paint(new THREE.LatheGeometry(profile, radial).scale(1, 1, sz), slot);
}

function curlBrim(g: THREE.BufferGeometry, radius: number, curl: number, stretchZ: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) / radius;
    const z = pos.getZ(i) / radius;
    pos.setY(i, pos.getY(i) + curl * x * x - 0.012 * Math.max(0, z));
    pos.setZ(i, pos.getZ(i) * stretchZ);
  }
  g.computeVertexNormals();
  return g;
}

function pinchCrown(g: THREE.BufferGeometry, top: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp((y - top * 0.45) / (top * 0.55), 0, 1);
    pos.setX(i, pos.getX(i) * (1 - 0.14 * t));
    if (pos.getZ(i) > 0) pos.setY(i, y - 0.02 * t * (pos.getZ(i) / 0.11));
  }
  g.computeVertexNormals();
  return g;
}

// --- Head shape ---------------------------------------------------------------

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function headMetric(x: number, y: number, z: number): number {
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return 0;
  const n = 2 + 0.7 * smooth01((z / len + 0.1) / 0.6);
  const s = Math.pow(Math.abs(x) / HEAD.a, n) + Math.pow(Math.abs(y) / HEAD.b, n) + Math.pow(Math.abs(z) / HEAD.c, n);
  return Math.pow(s, 1 / n);
}

/** Front surface depth of the skull at (x, y) relative to its centre, or -1 outside the silhouette. */
function headFrontZ(x: number, y: number): number {
  if (headMetric(x, y, 0) >= 1) return -1;
  let lo = 0;
  let hi = HEAD.c * 1.05;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (headMetric(x, y, mid) < 1) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Projects unit-sphere geometry onto the skull; a vertex's length scales its distance from the surface. */
function onHead(g: THREE.BufferGeometry, inflate: number, dz = 0): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const m = headMetric(x, y, z);
    const k = m > 1e-9 ? (inflate * Math.hypot(x, y, z)) / m : 0;
    pos.setXYZ(i, x * k, y * k + HEAD.y, z * k + HEAD.z + dz);
  }
  g.computeVertexNormals();
  return g;
}

/** Places a feature on the face surface, tilted to follow its curvature. */
function onFace(g: THREE.BufferGeometry, x: number, y: number, out: number): THREE.BufferGeometry {
  const z = Math.max(0, headFrontZ(x, y));
  const e = 0.004;
  const dzdx = (Math.max(0, headFrontZ(x + e, y)) - Math.max(0, headFrontZ(x - e, y))) / (2 * e);
  const dzdy = (Math.max(0, headFrontZ(x, y + e)) - Math.max(0, headFrontZ(x, y - e))) / (2 * e);
  g.rotateX(Math.atan(dzdy));
  g.rotateY(Math.atan(-dzdx));
  return g.translate(x, y + HEAD.y, z + HEAD.z + out);
}

type HairStyle = 'short' | 'bun';

/** Whether the hair covers the skull in unit direction (x, y, z); uncovered vertices sink under the skin. */
function hairCovers(x: number, y: number, z: number, style: HairStyle, photo: boolean): boolean {
  const nape = style === 'bun' ? -0.85 : -0.72;
  if (z < -0.12 + 0.25 * Math.max(0, y) && y > nape + 0.25 * Math.max(0, z + 0.5)) return true;
  if (Math.abs(x) > 0.8 && y > -0.25 && y < 0.5 && z < (photo ? -0.05 : 0.12)) return true;
  return y > (photo ? 0.8 : 0.52) && z < (photo ? 0.3 : 0.72);
}

function hairCap(style: HairStyle, photo: boolean, d: Detail): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, d.headW, d.headH);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = hairCovers(x, y, z, style, photo) ? 1 : 0.9;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  return onHead(g, 1.045, -0.003);
}

function hairParts(style: HairStyle, photo: boolean, d: Detail, look: CharacterLook): THREE.BufferGeometry[] {
  const parts = [paint(hairCap(style, photo, d), 'hair')];
  if (style === 'bun') {
    parts.push(
      ball(0.068, d, 0, HEAD.y + 0.1, -0.1, 'hair'),
      ball(0.045, d, 0.104, HEAD.y - 0.015, -0.035, 'hair', 0.8, 1.1, 1),
      ball(0.045, d, -0.104, HEAD.y - 0.015, -0.035, 'hair', 0.8, 1.1, 1),
    );
    if (look.bandana) {
      parts.push(
        paint(new THREE.ConeGeometry(0.022, 0.22, 5).rotateZ(-0.5).translate(0.08, HEAD.y + 0.2, -0.07), 'bandana'),
        ball(0.028, d, 0.075, HEAD.y + 0.1, -0.03, 'bandana'),
      );
    }
  }
  return parts;
}

function hatParts(hat: CharacterLook['hat'], d: Detail): THREE.BufferGeometry[] {
  if (hat === 'cowboy') {
    const k = 1.12;
    const tilt = new THREE.Matrix4().makeRotationX(-0.12).setPosition(0, HEAD.y + 0.075, HEAD.z - 0.004);
    const top = 0.14;
    return [
      paint(curlBrim(new THREE.CylinderGeometry(0.2 * k, 0.2 * k, 0.012, d.brim), 0.2 * k, 0.06, 1.12), 'hat'),
      pinchCrown(lathe([[0.104 * k, 0], [0.106 * k, 0.034], [0.096 * k, 0.11], [0.074 * k, top], [0.036 * k, top - 0.008], [0, top - 0.014]], d.brim, 'hat'), top),
      cyl(0.106 * k, 0.108 * k, 0.028, d.brim, 0.022, 'band'),
    ].map((g) => g.applyMatrix4(tilt));
  }
  if (hat === 'bowler') {
    const y = HEAD.y + 0.078;
    return [
      paint(new THREE.SphereGeometry(0.112, d.brim, d.sh, 0, TAU, 0, PI / 2).scale(1, 0.95, 1.05).translate(0, y, HEAD.z - 0.004), 'hat'),
      paint(curlBrim(new THREE.CylinderGeometry(0.15, 0.15, 0.01, d.brim), 0.15, 0.032, 1.08).translate(0, y, HEAD.z - 0.004), 'hat'),
      cyl(0.113, 0.113, 0.022, d.brim, y + 0.012, 'band').translate(0, 0, HEAD.z - 0.004),
    ];
  }
  return [];
}

function faceParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  const lady = look.dress === true;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const ex = s * 0.042;
    parts.push(
      paint(onFace(new THREE.SphereGeometry(0.018, d.sw, d.sh).scale(1.15, lady ? 0.85 : 0.75, 0.45), ex, 0.018, -0.001), 'white'),
      paint(onFace(new THREE.SphereGeometry(0.0095, d.sw, d.sh).scale(1, 1, 0.6), ex, 0.017, 0.0035), 'eye'),
      paint(onFace(new THREE.BoxGeometry(0.038, lady ? 0.006 : 0.01, 0.01).rotateZ(-s * 0.12), ex, 0.046, 0.001), 'hair'),
    );
    if (lady) parts.push(paint(onFace(new THREE.BoxGeometry(0.03, 0.003, 0.008).rotateZ(-s * 0.2), ex + s * 0.004, 0.029, 0.002), 'eye'));
  }
  parts.push(paint(onFace(new THREE.SphereGeometry(0.019, d.sw, d.sh).scale(0.85, 1.15, 1), 0, -0.008, 0.004), 'skin'));
  parts.push(paint(onFace(new THREE.BoxGeometry(lady ? 0.036 : 0.042, lady ? 0.011 : 0.007, 0.01), 0, -0.052, 0.0), lady ? 'bandana' : 'skinShade'));
  if (look.mustache || look.handlebar) {
    for (const s of [-1, 1]) {
      parts.push(paint(onFace(new THREE.BoxGeometry(0.046, 0.017, 0.02).rotateZ(-s * 0.35), s * 0.022, -0.036, 0.003), 'hair'));
      if (look.handlebar) parts.push(paint(onFace(new THREE.BoxGeometry(0.03, 0.012, 0.016).rotateZ(s * 0.75), s * 0.055, -0.028, 0.0), 'hair'));
    }
  }
  if (look.beard) parts.push(ball(0.085, d, 0, HEAD.y - 0.07, HEAD.z + 0.03, 'hair', 1.05, 0.85, 1));
  return parts;
}

function headParts(look: CharacterLook, photo: boolean, d: Detail): THREE.BufferGeometry[] {
  const parts = [
    paint(onHead(new THREE.SphereGeometry(1, d.headW, d.headH), 1), 'skin'),
    ball(0.024, d, HEAD.a * 0.96, HEAD.y - 0.004, HEAD.z - 0.01, 'skin', 0.55, 1.15, 0.8),
    ball(0.024, d, -HEAD.a * 0.96, HEAD.y - 0.004, HEAD.z - 0.01, 'skin', 0.55, 1.15, 0.8),
  ];
  parts.push(...hairParts(look.dress ? 'bun' : 'short', photo, d, look));
  parts.push(...hatParts(look.hat, d));
  if (!photo) parts.push(...faceParts(look, d));
  return parts;
}

// --- Body --------------------------------------------------------------------

type Outfit = 'vest' | 'poncho' | 'dress';
const outfitOf = (look: CharacterLook): Outfit => (look.dress ? 'dress' : look.poncho ? 'poncho' : 'vest');

const TORSO_PROFILE = [[0, -0.03], [0.14, -0.03], [0.15, 0.08], [0.17, 0.22], [0.172, 0.31], [0.15, 0.39], [0.1, 0.44], [0, 0.45]] as const;
const TORSO_DEPTH = 0.62;

function torsoParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  const outfit = outfitOf(look);
  const neck = cyl(0.047, 0.052, 0.12, d.radial, 0.49, 'skin');
  if (outfit === 'dress') {
    const parts = [
      lathe([[0, -0.03], [0.12, -0.03], [0.125, 0.06], [0.15, 0.2], [0.155, 0.27], [0.14, 0.33], [0, 0.33]], d.radial, 'vest', TORSO_DEPTH),
      lathe([[0.137, 0.33], [0.13, 0.38], [0.09, 0.44], [0, 0.45]], d.radial, 'skin', TORSO_DEPTH),
      ball(0.058, d, 0.052, 0.245, 0.068, 'vest', 1, 0.9, 0.8),
      ball(0.058, d, -0.052, 0.245, 0.068, 'vest', 1, 0.9, 0.8),
      paint(new THREE.TorusGeometry(0.138, 0.011, 4, d.radial * 2).rotateX(PI / 2).scale(1, 1, TORSO_DEPTH + 0.04).translate(0, 0.33, 0), 'lace'),
      paint(new THREE.CylinderGeometry(0.05, 0.05, 0.34, d.radial).rotateZ(PI / 2).translate(0, 0.395, 0), 'skin'),
      neck,
    ];
    if (look.bandana) parts.push(cyl(0.053, 0.054, 0.022, d.radial, 0.47, 'bandana'));
    return parts;
  }
  const parts = [
    lathe(TORSO_PROFILE, d.radial, outfit === 'poncho' ? 'shirt' : 'vest', TORSO_DEPTH),
    paint(new THREE.CylinderGeometry(0.055, 0.055, 0.36, d.radial).rotateZ(PI / 2).translate(0, 0.395, 0), 'shirt'),
    neck,
  ];
  if (outfit === 'poncho') {
    const sz = 0.78;
    parts.push(
      lathe([[0.065, 0.48], [0.2, 0.455], [0.29, 0.38], [0.305, 0.28]], d.radial + 2, 'vest', sz),
      lathe([[0.3, 0.28], [0.315, 0.235]], d.radial + 2, 'bandana', sz),
      lathe([[0.315, 0.235], [0.33, 0.16], [0.335, 0.12]], d.radial + 2, 'vest', sz),
      lathe([[0.335, 0.12], [0.337, 0.1]], d.radial + 2, 'bandana', sz),
    );
    return parts;
  }
  parts.push(cube(0.075, 0.34, 0.02, 0, 0.26, 0.1, 'shirt'));
  if (look.apron) {
    parts.push(cube(0.042, 0.03, 0.02, 0.022, 0.43, 0.075, 'eye', 0.2), cube(0.042, 0.03, 0.02, -0.022, 0.43, 0.075, 'eye', -0.2));
  } else if (look.bandana) {
    parts.push(
      paint(new THREE.ConeGeometry(0.1, 0.15, 3).rotateZ(PI).rotateY(PI / 6).scale(1, 1, 0.35).translate(0, 0.4, 0.085), 'bandana'),
      cyl(0.058, 0.064, 0.04, d.radial, 0.455, 'bandana'),
    );
  } else {
    parts.push(
      paint(new THREE.ConeGeometry(0.075, 0.13, 4).rotateZ(PI).scale(1, 1, 0.45).translate(0, 0.39, 0.095), 'eye'),
      cyl(0.056, 0.06, 0.035, d.radial, 0.455, 'shirt'),
    );
  }
  if (look.badge) {
    parts.push(paint(new THREE.CylinderGeometry(0.024, 0.024, 0.006, 5).rotateX(PI / 2).translate(0.085, 0.3, 0.1), 'metal'));
  }
  return parts;
}

function pelvisParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  if (look.dress) {
    return [
      lathe([[0, 0.1], [0.13, 0.1], [0.15, 0.02], [0.2, -0.15], [0.27, -0.45], [0.33, -0.72], [0.35, -0.8], [0, -0.8]], d.radial + 4, 'pants', 0.85),
      paint(new THREE.CylinderGeometry(0.355, 0.372, 0.07, d.radial + 4).scale(1, 1, 0.86).translate(0, -0.79, 0), 'lace'),
      paint(new THREE.CylinderGeometry(0.142, 0.15, 0.06, d.radial).scale(1, 1, 0.76).translate(0, 0.075, 0), 'belt'),
    ];
  }
  const parts = [
    lathe([[0, -0.15], [0.14, -0.15], [0.16, -0.07], [0.155, 0.04], [0.145, 0.1], [0, 0.1]], d.radial, 'pants', 0.72),
    paint(new THREE.CylinderGeometry(0.153, 0.157, 0.05, d.radial).scale(1, 1, 0.74).translate(0, 0.065, 0), 'belt'),
    cube(0.055, 0.038, 0.012, 0, 0.065, 0.118, 'metal'),
  ];
  if (look.holster) parts.push(cube(0.05, 0.16, 0.085, -0.18, -0.07, 0, 'belt'), cube(0.03, 0.075, 0.035, -0.182, 0.035, -0.02, 'eye', 0.15));
  if (look.apron) parts.push(cube(0.33, 0.58, 0.012, 0, -0.22, 0.12, 'cloth'));
  return parts;
}

function upperArmParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  const outfit = outfitOf(look);
  if (outfit === 'dress') return [ball(0.07, d, 0, -0.02, 0, 'vest'), cyl(0.042, 0.037, 0.3, d.radial, -0.15, 'skin')];
  if (outfit === 'poncho') return [cyl(0.045, 0.043, 0.3, d.radial, -0.15, 'shirt')];
  const parts = [ball(0.06, d, 0, 0, 0, 'shirt'), cyl(0.052, 0.045, 0.3, d.radial, -0.15, 'shirt')];
  if (look.apron) parts.push(paint(new THREE.TorusGeometry(0.051, 0.008, 4, d.radial).rotateX(PI / 2).translate(0, -0.1, 0), 'bandana'));
  return parts;
}

function forearmParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  const dress = look.dress === true;
  const rolled = !dress && (look.sleeves === 'rolled' || look.apron === true);
  const sleeve: Slot = dress ? 'belt' : rolled ? 'skin' : 'shirt';
  const hand: Slot = dress ? 'belt' : 'skin';
  const slim = dress ? 0.85 : 1;
  const parts = [
    ball(0.046 * slim, d, 0, 0, 0, rolled ? 'shirt' : sleeve),
    cyl(0.045 * slim, 0.037 * slim, 0.24, d.radial, -0.12, sleeve),
    cube(0.03, 0.085, 0.065, 0, -0.29, 0.005, hand),
    cube(0.02, 0.045, 0.022, 0, -0.262, 0.042, hand),
  ];
  if (rolled) parts.push(cyl(0.053, 0.05, 0.05, d.radial, -0.025, 'shirt'));
  return parts;
}

function thighParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  if (look.dress) return [];
  return [ball(0.075, d, 0, 0, 0, 'pants'), cyl(0.074, 0.06, 0.42, d.radial, -0.21, 'pants')];
}

function shinParts(look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  const parts = [
    ball(0.058, d, 0, 0, 0, 'pants'),
    cyl(0.058, 0.05, 0.22, d.radial, -0.11, look.dress ? 'eye' : 'pants'),
    cyl(0.063, 0.057, 0.24, d.radial, -0.3, 'boots'),
    cube(0.09, 0.07, 0.22, 0, -0.465, 0.045, 'boots'),
  ];
  if (!look.dress) parts.push(paint(new THREE.TorusGeometry(0.02, 0.005, 4, 8).rotateY(PI / 2).translate(0, -0.455, -0.075), 'metal'));
  return parts;
}

function boneParts(bone: CharacterBone, look: CharacterLook, d: Detail): THREE.BufferGeometry[] {
  switch (bone) {
    case 'pelvis':
      return pelvisParts(look, d);
    case 'spine':
      return torsoParts(look, d);
    case 'head':
      return [];
    case 'armL':
    case 'armR':
      return upperArmParts(look, d);
    case 'foreL':
    case 'foreR':
      return forearmParts(look, d);
    case 'thighL':
    case 'thighR':
      return thighParts(look, d);
    case 'shinL':
    case 'shinR':
      return shinParts(look, d);
  }
}

// --- Cached geometry -----------------------------------------------------------

const geometryCache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometryCache.get(key);
  if (!g) {
    g = build();
    geometryCache.set(key, g);
  }
  return g;
}

function merge(parts: THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error(`Character: failed to merge ${label}`);
  merged.computeBoundingSphere();
  return merged;
}

function bodyKey(look: CharacterLook, q: CharacterQuality): string {
  return ['body', q, outfitOf(look), !!look.apron, !!look.holster, !!look.badge, !!look.bandana, look.sleeves ?? 'long'].join('|');
}

function bodyGeometry(look: CharacterLook, q: CharacterQuality): THREE.BufferGeometry {
  return cached(bodyKey(look, q), () => {
    const d = DETAIL[q];
    const parts: THREE.BufferGeometry[] = [];
    BONES.forEach((bone, index) => {
      const [bx, by, bz] = BIND[bone];
      for (const g of boneParts(bone, look, d)) {
        g.translate(bx, by, bz);
        const count = g.getAttribute('position').count;
        const skinIndex = new Uint16Array(count * 4);
        const skinWeight = new Float32Array(count * 4);
        for (let i = 0; i < count; i++) {
          skinIndex[i * 4] = index;
          skinWeight[i * 4] = 1;
        }
        g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
        g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
        parts.push(g);
      }
    });
    return merge(parts, 'body');
  });
}

function headGeometry(look: CharacterLook, photo: boolean, q: CharacterQuality): THREE.BufferGeometry {
  const face = photo ? 'photo' : [look.mustache, look.handlebar, look.beard].map((v) => (v ? 1 : 0)).join('');
  const key = ['head', q, look.hat, look.dress ? 'bun' : 'short', look.dress && look.bandana ? 'feather' : '', face].join('|');
  return cached(key, () => merge(headParts(look, photo, DETAIL[q]), 'head'));
}

function facePlateGeometry(q: CharacterQuality): THREE.BufferGeometry {
  return cached(`face|${q}`, () => {
    const n = DETAIL[q].face;
    const g = new THREE.PlaneGeometry(FACE.size, FACE.size, n, n);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i) + FACE.y - HEAD.y;
      const nx = x / (FACE.size * FACE.rx);
      const ny = y / (FACE.size * FACE.ry);
      const r = Math.hypot(nx, ny);
      let fx = x;
      let fy = y;
      if (r > 1) {
        fx /= r;
        fy /= r;
      }
      const z = Math.max(0, headFrontZ(fx * 0.999, fy * 0.999));
      pos.setXYZ(i, x, y + HEAD.y, z + HEAD.z + FACE.lift);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  });
}

let ovalMask: THREE.CanvasTexture | null = null;

function faceMask(): THREE.CanvasTexture {
  if (ovalMask) return ovalMask;
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5;
      const v = 0.5 - (y + 0.5) / S;
      const a = 1 - smooth01((Math.hypot(u / FACE.rx, v / FACE.ry) - 0.78) / 0.22);
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = a * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  ovalMask = new THREE.CanvasTexture(canvas);
  ovalMask.colorSpace = THREE.NoColorSpace;
  ovalMask.name = 'character-face-mask';
  return ovalMask;
}

// --- Hand props ------------------------------------------------------------------

export type HandPropKind = 'mug' | 'whisky' | 'glass' | 'cards' | 'rag';

function tint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new THREE.Color(hex);
  const count = g.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) c.toArray(data, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return g;
}

/** Converts geometry authored in forearm space (hand at the origin) into palm-anchor space. */
const FOREARM_TO_ANCHOR = new THREE.Matrix4().makeRotationX(-PI / 2);

function propGeometry(kind: HandPropKind, q: CharacterQuality): THREE.BufferGeometry {
  return cached(`prop|${kind}|${q}`, () => {
    const radial = q === 'high' ? 12 : 8;
    let parts: THREE.BufferGeometry[];
    if (kind === 'mug') {
      parts = [
        tint(new THREE.CylinderGeometry(0.04, 0.038, 0.13, radial), '#9a5812'),
        tint(new THREE.CylinderGeometry(0.041, 0.041, 0.016, radial).translate(0, -0.058, 0), '#c49048'),
        tint(new THREE.CylinderGeometry(0.0415, 0.0405, 0.026, radial).translate(0, 0.072, 0), '#efe6d2'),
        tint(new THREE.SphereGeometry(0.041, radial, 3, 0, TAU, 0, PI / 2).scale(1, 0.35, 1).translate(0, 0.085, 0), '#f4ecdc'),
        tint(new THREE.TorusGeometry(0.032, 0.009, 5, 8, PI).rotateZ(PI / 2).translate(-0.04, 0, 0), '#b8802e'),
      ].map((g) => g.translate(0.06, 0, 0));
    } else if (kind === 'whisky') {
      parts = [
        tint(new THREE.CylinderGeometry(0.031, 0.03, 0.036, radial).translate(0.045, -0.024, 0), '#8a4a12'),
        tint(new THREE.CylinderGeometry(0.034, 0.031, 0.05, radial).translate(0.045, 0.019, 0), '#8f9a98'),
      ];
    } else if (kind === 'glass') {
      parts = [tint(new THREE.CylinderGeometry(0.034, 0.03, 0.085, radial).translate(0.045, 0, 0), '#a6b0ae')];
    } else if (kind === 'cards') {
      parts = [-0.3, 0, 0.3].map((a) =>
        tint(new THREE.BoxGeometry(0.052, 0.074, 0.003).rotateZ(a).translate(0, -0.05, 0.04 + a * 0.004).applyMatrix4(FOREARM_TO_ANCHOR), '#ddd3bd'),
      );
    } else {
      parts = [
        tint(new THREE.BoxGeometry(0.035, 0.15, 0.1).rotateZ(0.2).translate(0, -0.04, 0).applyMatrix4(FOREARM_TO_ANCHOR), '#d2c9b4'),
        tint(new THREE.BoxGeometry(0.02, 0.09, 0.085).rotateZ(-0.15).translate(0.015, -0.13, -0.01).applyMatrix4(FOREARM_TO_ANCHOR), '#d2c9b4'),
      ];
    }
    return merge(parts, `prop ${kind}`);
  });
}

let glossyMaterial: THREE.MeshStandardMaterial | null = null;
let matteMaterial: THREE.MeshStandardMaterial | null = null;

/** Shared prop mesh for `Character.hand()`; geometry and material are shared, never dispose them. */
export function createHandProp(kind: HandPropKind, quality: CharacterQuality = 'high'): THREE.Mesh {
  const soft = kind === 'cards' || kind === 'rag';
  if (soft && !matteMaterial) {
    matteMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.3 });
    matteMaterial.name = 'character-prop-matte';
  }
  if (!soft && !glossyMaterial) {
    glossyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0, envMapIntensity: 1.3 });
    glossyMaterial.name = 'character-glassware';
  }
  const mesh = new THREE.Mesh(propGeometry(kind, quality), (soft ? matteMaterial : glossyMaterial) as THREE.MeshStandardMaterial);
  mesh.name = `prop-${kind}`;
  return mesh;
}

/** Centre-crops any image to a square sRGB texture suitable for `setFace`. */
export function createFaceTexture(source: CanvasImageSource & { width: number; height: number }, size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const w = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const h = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  const side = Math.min(w, h);
  ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.name = 'character-face';
  return texture;
}

// ---------------------------------------------------------------------------
// Action poses
// ---------------------------------------------------------------------------

interface PoseContext {
  t: number;
  phase: number;
  speed: number;
  seat: number;
  seed: number;
}

const clamp = THREE.MathUtils.clamp;

function standBase(p: CharacterPose, c: PoseContext, shiftAmount: number): number {
  const t = c.t;
  const sh = clamp(Math.sin(t * 0.33 + c.seed) * 1.8, -1, 1) * shiftAmount;
  const breath = Math.sin(t * 1.45 + c.seed * 2);
  const freeL = Math.max(0, -sh);
  const freeR = Math.max(0, sh);
  p.setPelvis(0.022 * sh, PELVIS_Y - 0.006 * Math.abs(sh) + 0.002 * breath, 0);
  p.set('pelvis', 0, 0.04 * sh, 0.035 * sh);
  p.set('thighL', -0.08 * freeL, 0, -0.035 * sh + 0.015);
  p.set('thighR', -0.08 * freeR, 0, -0.035 * sh - 0.015);
  p.set('shinL', 0.17 * freeL, 0, 0);
  p.set('shinR', 0.17 * freeR, 0, 0);
  p.set('spine', 0.02 + 0.012 * breath, -0.03 * sh, -0.03 * sh);
  p.set('armL', 0.03, 0, 0.08 + 0.01 * breath);
  p.set('armR', 0.03, 0, -0.08 - 0.01 * breath);
  p.set('foreL', -0.18, 0, 0);
  p.set('foreR', -0.18, 0, 0);
  p.set('head', 0.02 * Math.sin(t * 0.23 + c.seed), 0.28 * (0.6 * Math.sin(t * 0.19 + c.seed * 3) + 0.4 * Math.sin(t * 0.47 + c.seed)), 0.02 * Math.sin(t * 0.31));
  return breath;
}

function walkAmplitude(speed: number): number {
  const cycle = clamp(0.55 + 0.7 * speed, 0.7, 1.75);
  return Math.asin(Math.min(0.9, cycle / (4 * LEG_LENGTH))) * smooth01(speed / 0.3);
}

function cycleLength(action: CharacterAction, speed: number): number {
  return action === 'run' ? clamp(1.2 + 0.45 * speed, 1.8, 3.4) : clamp(0.55 + 0.7 * speed, 0.7, 1.75);
}

function poseWalk(p: CharacterPose, c: PoseContext): void {
  const A = walkAmplitude(c.speed);
  const g = A / 0.42;
  const s = Math.sin(c.phase);
  const co = Math.cos(c.phase);
  const kneeL = Math.max(0, co);
  const kneeR = Math.max(0, -co);
  p.setPelvis(0, PELVIS_Y - 0.012 * g + 0.02 * g * Math.cos(2 * c.phase), 0);
  p.set('pelvis', 0.03 * g, 0.09 * g * s, 0.025 * g * co);
  p.set('thighL', -A * s, 0, 0.02);
  p.set('thighR', A * s, 0, -0.02);
  p.set('shinL', 0.08 * g + 1.7 * A * kneeL * kneeL, 0, 0);
  p.set('shinR', 0.08 * g + 1.7 * A * kneeR * kneeR, 0, 0);
  p.set('spine', 0.04 * g, -0.12 * g * s, -0.02 * g * co);
  const armA = 0.4 * g;
  p.set('armL', armA * s, 0, 0.08);
  p.set('armR', -armA * s, 0, -0.08);
  p.set('foreL', -0.22 - 0.3 * g * Math.max(0, -s), 0, 0);
  p.set('foreR', -0.22 - 0.3 * g * Math.max(0, s), 0, 0);
  p.set('head', -0.03 * g * co, 0.03 * g * s + 0.1 * Math.sin(c.t * 0.21 + c.seed), 0);
}

function poseRun(p: CharacterPose, c: PoseContext): void {
  const ramp = smooth01(c.speed / 0.8);
  const A = (0.55 + 0.12 * clamp((c.speed - 2) / 3, 0, 1)) * ramp;
  const s = Math.sin(c.phase);
  const co = Math.cos(c.phase);
  const kneeL = Math.max(0, co);
  const kneeR = Math.max(0, -co);
  p.setPelvis(0, PELVIS_Y - 0.035 * ramp - 0.03 * ramp * Math.cos(2 * c.phase), 0);
  p.set('pelvis', 0.08 * ramp, 0.12 * ramp * s, 0.03 * ramp * co);
  p.set('thighL', -0.12 * ramp - A * s, 0, 0.02);
  p.set('thighR', -0.12 * ramp + A * s, 0, -0.02);
  p.set('shinL', 0.25 * ramp + 1.45 * ramp * Math.pow(kneeL, 1.5), 0, 0);
  p.set('shinR', 0.25 * ramp + 1.45 * ramp * Math.pow(kneeR, 1.5), 0, 0);
  p.set('spine', 0.16 * ramp, -0.2 * ramp * s, 0);
  p.set('armL', -0.1 * ramp + 0.75 * ramp * s, 0, 0.12);
  p.set('armR', -0.1 * ramp - 0.75 * ramp * s, 0, -0.12);
  p.set('foreL', -1.45 * ramp - 0.2 + 0.2 * s, 0, 0);
  p.set('foreR', -1.45 * ramp - 0.2 - 0.2 * s, 0, 0);
  p.set('head', -0.2 * ramp - 0.04 * co, 0.05 * s, 0);
}

const SEAT_THIGH_R = 0.074;
const SHIN_LENGTH = 0.5;

function poseSit(p: CharacterPose, c: PoseContext): void {
  const t = c.t;
  const h = c.seat;
  const k = clamp((h - 0.48) / 0.28, 0, 1);
  const breath = Math.sin(t * 1.45 + c.seed * 2);
  const pelvisY = h + SEAT_THIGH_R + 0.03;
  const hipY = pelvisY - 0.03;
  const thigh = -1.5 + 0.3 * k;
  const kneeY = hipY - 0.42 * Math.cos(-thigh);
  const footY = h > 0.62 ? 0.28 : 0.02;
  const drop = clamp((kneeY - footY) / SHIN_LENGTH, -1, 1);
  const shinWorld = Math.acos(drop);
  p.setPelvis(0, pelvisY + 0.002 * breath, -0.05 + 0.03 * k);
  p.set('pelvis', 0, 0, 0);
  const spread = 0.08 + 0.06 * k;
  p.set('thighL', thigh, 0, spread);
  p.set('thighR', thigh, 0, -spread);
  p.set('shinL', -thigh + shinWorld, 0, -spread * 0.6);
  p.set('shinR', -thigh + shinWorld, 0, spread * 0.6);
  p.set('spine', 0.08 + 0.012 * breath, 0, 0);
  p.set('armL', -0.42, -0.1, 0.1);
  p.set('armR', -0.42, 0.1, -0.1);
  p.set('foreL', -0.95, 0, 0);
  p.set('foreR', -0.95, 0, 0);
  p.set('head', 0.04 + 0.03 * Math.sin(t * 0.27 + c.seed), 0.3 * (0.6 * Math.sin(t * 0.17 + c.seed * 3) + 0.4 * Math.sin(t * 0.43 + c.seed)), 0);
}

const DRINK_PERIOD = 5.2;
const MUG_REST: { arm: V3; fore: V3 } = { arm: [-0.3, 0.12, -0.16], fore: [-1.45, 0, 0] };
const MUG_SIP: { arm: V3; fore: V3 } = { arm: [-0.95, 0.5, 0.05], fore: [-2.15, 0, 0] };

function envelope(t: number, rise: number, hold: number, fall: number): number {
  if (t <= 0) return 0;
  if (t < rise) return smooth01(t / rise);
  t -= rise;
  if (t < hold) return 1;
  t -= hold;
  return t < fall ? 1 - smooth01(t / fall) : 0;
}

function poseDrink(p: CharacterPose, c: PoseContext): void {
  standBase(p, c, 0.6);
  const cycle = (c.t + c.seed * 1.7) % DRINK_PERIOD;
  const w = envelope(cycle - 0.6, 0.9, 1.5, 0.9);
  const sip = w * 0.05 * Math.sin(c.t * 5);
  p.mix('armR', MUG_REST.arm, MUG_SIP.arm, w);
  p.mix('foreR', MUG_REST.fore, MUG_SIP.fore, w, sip);
  p.add('spine', -0.05 * w, 0, 0);
  p.set('head', -0.32 * w + 0.03, 0.12 * (1 - w) * Math.sin(c.t * 0.3 + c.seed), 0);
}

function poseLean(p: CharacterPose, c: PoseContext): void {
  const t = c.t;
  const breath = Math.sin(t * 1.45 + c.seed * 2);
  const sh = clamp(Math.sin(t * 0.3 + c.seed) * 1.8, -1, 1);
  const freeL = Math.max(0, -sh);
  const freeR = Math.max(0, sh);
  p.setPelvis(0.012 * sh, PELVIS_Y - 0.012, -0.055);
  p.set('pelvis', 0.1, 0.03 * sh, 0.025 * sh);
  p.set('thighL', -0.155 - 0.06 * freeL, 0, 0.04 - 0.025 * sh);
  p.set('thighR', -0.155 - 0.06 * freeR, 0, -0.04 - 0.025 * sh);
  p.set('shinL', 0.12 * freeL, 0, 0);
  p.set('shinR', 0.12 * freeR, 0, 0);
  p.set('spine', 0.3 + 0.012 * breath, -0.02 * sh, 0);
  p.set('armL', -0.74 - 0.006 * breath, 0, 0.1);
  p.set('armR', -0.74 - 0.006 * breath, 0, -0.1);
  p.set('foreL', -0.12, 0, 0);
  p.set('foreR', -0.12, 0, 0);
  p.set('head', -0.24 + 0.04 * Math.sin(t * 0.21 + c.seed), 0.25 * Math.sin(t * 0.16 + c.seed * 2), 0);
}

function poseWave(p: CharacterPose, c: PoseContext): void {
  standBase(p, c, 0.4);
  const w = Math.sin(c.t * 8.5);
  p.set('armR', 0, 0.12, -1.3 + 0.04 * w);
  p.set('foreR', 0, 0, -1.5 + 0.42 * w);
  p.set('spine', 0.01, 0, 0.05);
  p.set('head', 0, 0.1, 0.06);
}

function evaluate(action: CharacterAction, p: CharacterPose, c: PoseContext): void {
  switch (action) {
    case 'idle':
      standBase(p, c, 1);
      return;
    case 'walk':
      poseWalk(p, c);
      return;
    case 'run':
      poseRun(p, c);
      return;
    case 'sit':
      poseSit(p, c);
      return;
    case 'drink':
      poseDrink(p, c);
      return;
    case 'lean':
      poseLean(p, c);
      return;
    case 'wave':
      poseWave(p, c);
      return;
  }
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

const BLEND_TIME = 0.2;
let seedCounter = 0;

class CharacterImpl implements Character {
  readonly object = new THREE.Group();
  readonly height: number;
  readonly headAnchor: THREE.Object3D;
  action: CharacterAction = 'idle';

  private readonly quality: CharacterQuality;
  private readonly bones: Record<CharacterBone, THREE.Bone>;
  private readonly body: THREE.SkinnedMesh;
  private readonly head: THREE.Mesh;
  private readonly facePlate: THREE.Mesh;
  private readonly faceMaterial: THREE.MeshStandardMaterial;
  private readonly hands: Record<CharacterHand, THREE.Object3D>;
  private readonly mug: THREE.Mesh;
  private material: THREE.MeshStandardMaterial;
  private look: CharacterLook;
  private face: THREE.Texture | null = null;
  private driver: PoseDriver | null = null;

  private readonly out = new CharacterPose();
  private readonly from = new CharacterPose();
  private readonly target = new CharacterPose();
  private readonly ctx: PoseContext;
  private previous: CharacterAction = 'idle';
  private blend = 1;

  constructor(look: CharacterLook, opts: CharacterOptions) {
    this.quality = opts.quality ?? 'high';
    this.look = { ...look };
    const scale = opts.scale ?? 1;
    this.height = CROWN * scale;
    this.ctx = { t: 0, phase: 0, speed: 0, seat: 0.48, seed: opts.seed ?? (seedCounter++ * 2.399) % TAU };
    this.object.name = `character${look.name ? `-${look.name}` : ''}`;
    this.object.scale.setScalar(scale);

    const bones = {} as Record<CharacterBone, THREE.Bone>;
    for (const b of BONES) {
      const bone = new THREE.Bone();
      bone.name = b;
      bone.position.set(...PIVOT[b]);
      bones[b] = bone;
      const parent = PARENT[b];
      (parent ? bones[parent] : this.object).add(bone);
    }
    this.bones = bones;
    this.headAnchor = bones.head;

    this.material = acquireMaterial(this.look);
    this.body = new THREE.SkinnedMesh(bodyGeometry(this.look, this.quality), this.material);
    this.body.name = 'character-body';
    this.object.add(this.body);
    this.body.bind(new THREE.Skeleton(BONES.map((b) => bones[b]), BONE_INVERSES), IDENTITY);
    this.body.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3);

    this.head = new THREE.Mesh(headGeometry(this.look, false, this.quality), this.material);
    this.head.name = 'character-head';
    bones.head.add(this.head);

    this.faceMaterial = new THREE.MeshStandardMaterial({
      alphaMap: faceMask(),
      transparent: true,
      alphaTest: 0.02,
      roughness: 0.75,
      metalness: 0,
      envMapIntensity: 0.25,
      emissive: new THREE.Color().setScalar(opts.faceGlow ?? 0.22),
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.faceMaterial.name = 'character-face';
    this.facePlate = new THREE.Mesh(facePlateGeometry(this.quality), this.faceMaterial);
    this.facePlate.name = 'character-face';
    this.facePlate.visible = false;
    bones.head.add(this.facePlate);

    const handL = new THREE.Object3D();
    handL.position.set(0, HAND_Y, 0);
    handL.rotation.set(PI / 2, PI, 0);
    const handR = new THREE.Object3D();
    handR.position.set(0, HAND_Y, 0);
    handR.rotation.set(PI / 2, 0, 0);
    bones.foreL.add(handL);
    bones.foreR.add(handR);
    this.hands = { L: handL, R: handR };
    this.mug = createHandProp('mug', this.quality);
    this.mug.visible = false;
    handR.add(this.mug);

    this.setCastShadow(false);
    this.evaluateInto(this.out);
    this.apply();
  }

  setAction(action: CharacterAction, immediate = false): void {
    if (action === this.action && !immediate) return;
    this.from.copy(this.out);
    this.previous = this.action;
    this.action = action;
    this.blend = immediate ? 1 : 0;
    if (immediate) {
      this.evaluateInto(this.out);
      this.apply();
    }
  }

  setSpeed(metersPerSecond: number): void {
    this.ctx.speed = Math.max(0, metersPerSecond);
  }

  setSeatHeight(height: number): void {
    this.ctx.seat = height;
  }

  setFace(texture: THREE.Texture | null): void {
    if (texture === this.face) return;
    const photoChanged = (texture === null) !== (this.face === null);
    this.face = texture;
    this.faceMaterial.map = texture;
    this.faceMaterial.emissiveMap = texture;
    this.faceMaterial.needsUpdate = true;
    this.facePlate.visible = texture !== null;
    if (photoChanged) this.head.geometry = headGeometry(this.look, texture !== null, this.quality);
  }

  setLook(look: CharacterLook): void {
    const next = { ...look };
    if (paletteKey(next) !== paletteKey(this.look)) {
      const material = acquireMaterial(next);
      releaseMaterial(this.material);
      this.material = material;
      this.body.material = material;
      this.head.material = material;
    }
    this.look = next;
    this.body.geometry = bodyGeometry(next, this.quality);
    this.head.geometry = headGeometry(next, this.face !== null, this.quality);
  }

  hand(side: CharacterHand): THREE.Object3D {
    return this.hands[side];
  }

  setPoseDriver(driver: PoseDriver | null): void {
    this.driver = driver;
  }

  setCastShadow(enabled: boolean): void {
    this.object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = enabled;
    });
  }

  update(dt: number, time: number): void {
    const step = clamp(dt, 0, 0.1);
    const c = this.ctx;
    c.t = time;
    if (this.action === 'walk' || this.action === 'run') {
      c.phase = (c.phase + (TAU * c.speed * step) / cycleLength(this.action, c.speed)) % (TAU * 64);
    }
    this.evaluateInto(this.target);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + step / BLEND_TIME);
      this.out.lerp(this.from, this.target, smooth01(this.blend));
    } else {
      this.out.copy(this.target);
    }
    this.driver?.(this.out, time, step);
    this.apply();
    const w = smooth01(this.blend);
    this.mug.visible = this.action === 'drink' ? w > 0.35 : this.previous === 'drink' && w < 0.65;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.body.skeleton.dispose();
    releaseMaterial(this.material);
    this.faceMaterial.dispose();
    this.driver = null;
  }

  private evaluateInto(pose: CharacterPose): void {
    evaluate(this.action, pose, this.ctx);
  }

  private apply(): void {
    const d = this.out.data;
    for (let i = 0; i < NB; i++) this.bones[BONES[i]].rotation.set(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]);
    this.bones.pelvis.position.set(d[PELVIS_POS], d[PELVIS_POS + 1], d[PELVIS_POS + 2]);
  }
}

export function createCharacter(look: CharacterLook, opts?: CharacterOptions): Character {
  return new CharacterImpl(look, opts ?? {});
}

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export const DEFAULT_LOOKS: CharacterLook[] = [
  { name: 'Forastero', skin: '#c08a64', shirt: '#b8a888', vest: '#4a3426', pants: '#4a4c55', hat: 'cowboy', hatColor: '#5a4330', bandana: '#8e2a20', mustache: true, holster: true },
  { name: 'Sheriff', skin: '#d0a07a', shirt: '#e0d6bf', vest: '#6e5234', pants: '#3a3a40', hat: 'cowboy', hatColor: '#c8b08a', mustache: true, badge: true, holster: true, hair: '#6a4a2a' },
  { name: 'Ranchera', skin: '#e0b494', shirt: '#7a2e28', vest: '#2e2622', pants: '#4a5e78', hat: 'cowboy', hatColor: '#8a6a44', bandana: '#d8b84a', sleeves: 'rolled', hair: '#8a4a22' },
  { name: 'Tahúr', skin: '#b88462', shirt: '#d8d0bc', vest: '#1e1b1c', pants: '#2c2a2c', hat: 'bowler', hatColor: '#1c1a18', handlebar: true, hair: '#1a1410' },
  { name: 'Vaquero', skin: '#94664a', shirt: '#b0a080', vest: '#6a4a2e', pants: '#3c3834', hat: 'cowboy', hatColor: '#7a6446', bandana: '#b04a24', poncho: true, mustache: true, hair: '#15100c' },
  { name: 'Buscador', skin: '#c49474', shirt: '#56606a', vest: '#6a5638', pants: '#4e4232', hat: 'cowboy', hatColor: '#3a3028', beard: true, hair: '#8a8278', sleeves: 'rolled' },
  { name: 'Cantante', skin: '#dcae8e', shirt: '#dcd0b8', vest: '#7a2432', pants: '#6a1e2a', hat: 'none', hatColor: '#2a2030', bandana: '#2a2030', dress: true, hair: '#5a3220', boots: '#1c1412' },
  { name: 'Pistolera', skin: '#8a5a3e', shirt: '#3e4a5a', vest: '#5a3a26', pants: '#6a5640', hat: 'cowboy', hatColor: '#221d1a', bandana: '#2e4a6a', holster: true, hair: '#140e0a' },
];
