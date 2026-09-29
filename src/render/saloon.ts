import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TABLE } from '../config';
import { TABLE_EXTENT } from './table';
import { createLeatherTexture, createWoodTexture } from './textures';

/** Obstacle footprint on the floor plane, in world X/Z. */
export type SaloonCollider =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'box'; minX: number; maxX: number; minZ: number; maxZ: number };

export interface Saloon {
  group: THREE.Group;
  tableLight: THREE.SpotLight;
  lampFixture: THREE.Object3D;
  colliders: SaloonCollider[];
  /** Player start: inside by the doors, facing the table (yaw = rotation.y of a +Z-facing body). */
  spawn: { x: number; z: number; yaw: number };
  /** Walkable interior with a margin to the walls; the doorway is not walkable. */
  walkBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  update(time: number, dt: number): void;
}

type Quality = 'low' | 'high';
type V3 = readonly [number, number, number];
type Rect = readonly [number, number, number, number];

const FLOOR_Y = -TABLE.surfaceHeight;
const HX = 5.5;
const HZ = 4.4;
const ROOM_H = 3.4;
const CEIL_Y = FLOOR_Y + ROOM_H;
const WALL_T = 0.2;
const DOOR_HALF = 0.8;
const DOOR_H = 2.3;
const fy = (h: number): number => FLOOR_Y + h;

const TABLE_LIGHT = { color: 0xffc48a, intensity: 24, height: 1.1, angle: 1.2, penumbra: 0.45 } as const;
const LANTERN_LIGHT = { color: 0xff9448, intensity: 2.2, distance: 9 } as const;
const MOON_LIGHT = { color: 0x86a2ff, intensity: 36 } as const;
const LAMP_RIM_Y = 0.95;
const LAMP_BAR_Y = 1.32;
const SHADE_X = [-0.62, 0, 0.62] as const;

const WINDOW = { x: 2.0, halfWidth: 0.55, bottom: 1.25, top: 2.45 } as const;
const MOON_DIR: V3 = [-0.25, -1, 0.5]; // travel per metre of fall

const WALL_MARGIN = 0.3;
const TABLE_CLEARANCE = 0.05;

const PI = Math.PI;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------------------
// Geometry batching
// ---------------------------------------------------------------------------

interface PartOptions {
  color?: THREE.ColorRepresentation | THREE.Color;
  uvScale?: readonly [number, number];
  uvRect?: Rect;
  keepUV?: boolean;
}

const tmpColor = new THREE.Color();

function linear(r: number, g: number, b: number): THREE.Color {
  return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
}

function applyWorldUV(g: THREE.BufferGeometry, tileU: number, tileV: number): void {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else if (ax >= az) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = u / tileU;
    uv[i * 2 + 1] = v / tileV;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function transformUV(g: THREE.BufferGeometry, fn: (u: number, v: number) => [number, number]): void {
  const uv = g.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) {
    const [u, v] = fn(uv.getX(i), uv.getY(i));
    uv.setXY(i, u, v);
  }
}

function paintVertices(g: THREE.BufferGeometry, color: THREE.ColorRepresentation | THREE.Color): void {
  tmpColor.set(color);
  const count = g.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = tmpColor.r;
    data[i * 3 + 1] = tmpColor.g;
    data[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(data, 3));
}

function paintGradientY(g: THREE.BufferGeometry, y0: number, y1: number, c0: THREE.Color, c1: THREE.Color): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const data = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) - y0) / (y1 - y0), 0, 1);
    tmpColor.copy(c0).lerp(c1, t);
    data[i * 3] = tmpColor.r;
    data[i * 3 + 1] = tmpColor.g;
    data[i * 3 + 2] = tmpColor.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return g;
}

class Batch {
  private readonly parts: THREE.BufferGeometry[] = [];

  constructor(
    private readonly tileU: number,
    private readonly tileV: number,
    private readonly colored = false,
  ) {}

  add(geometry: THREE.BufferGeometry, options: PartOptions = {}): this {
    const g = geometry;
    for (const name of Object.keys(g.attributes)) {
      const keep = name === 'position' || name === 'normal' || name === 'uv' || (this.colored && name === 'color');
      if (!keep) g.deleteAttribute(name);
    }
    if (!g.index) g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, i) => i));
    if (options.uvRect) {
      const [u0, v0, u1, v1] = options.uvRect;
      transformUV(g, (u, v) => [u0 + u * (u1 - u0), v0 + v * (v1 - v0)]);
    } else if (options.uvScale) {
      const [su, sv] = options.uvScale;
      transformUV(g, (u, v) => [u * su, v * sv]);
    } else if (!options.keepUV) {
      applyWorldUV(g, this.tileU, this.tileV);
    }
    if (this.colored && (options.color !== undefined || !g.getAttribute('color'))) {
      paintVertices(g, options.color ?? 0xffffff);
    }
    this.parts.push(g);
    return this;
  }

  build(material: THREE.Material, name: string): THREE.Mesh | null {
    if (this.parts.length === 0) return null;
    const merged = mergeGeometries(this.parts, false) as THREE.BufferGeometry | null;
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) throw new Error(`Saloon: failed to merge batch "${name}"`);
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function at(g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  if (ry !== 0) g.rotateY(ry);
  return g.translate(x, y, z);
}

function frame(x: number, y: number, z: number, ry = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(Y_AXIS, ry),
    new THREE.Vector3(1, 1, 1),
  );
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function valueNoise1(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const h = (n: number): number => {
    const x = Math.sin((n + seed * 131.7) * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  const s = f * f * (3 - 2 * f);
  return h(i) * (1 - s) + h(i + 1) * s;
}

function flameFlicker(t: number, seed: number): number {
  return (
    0.84 +
    0.07 * Math.sin(t * 9.1 + seed * 3.7) +
    0.04 * Math.sin(t * 17.3 + seed * 1.3) +
    0.12 * (valueNoise1(t * 7 + seed * 11, seed) - 0.5) +
    0.06 * (valueNoise1(t * 1.3, seed + 3) - 0.5)
  );
}

// ---------------------------------------------------------------------------
// Canvas textures specific to the saloon
// ---------------------------------------------------------------------------

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

function canvasTexture(canvas: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function rectUV(x: number, y: number, w: number, h: number, W: number, H: number): Rect {
  return [x / W, 1 - (y + h) / H, (x + w) / W, 1 - y / H];
}

const SERIF = 'Georgia, "Times New Roman", "DejaVu Serif", serif';

interface WantedInfo {
  name: string;
  reward: string;
  crime: string;
}

const WANTED: readonly WantedInfo[] = [
  { name: 'JORGE TIJUANAS', reward: '$500', crime: 'For cheating at cards & horse thievery' },
  { name: 'BUME BUMESITO', reward: '$1,000', crime: 'For robbing the Dodge City stage' },
  { name: 'DIO GARCIA', reward: '$750', crime: 'For train robbery on the Santa Fe line' },
  { name: 'YUNG CHINASKI', reward: '$2,000', crime: 'For bank robbery & jailbreak' },
  { name: 'EL SEVILLANO', reward: '$300', crime: 'For rustling cattle in Tombstone' },
];

const POSTER_PX = { w: 380, h: 532 } as const;
const ATLAS_W = 2048;
const ATLAS_H = 1024;

interface SignAtlas {
  texture: THREE.CanvasTexture;
  posters: Rect[];
  saloon: Rect;
  whiskey: Rect;
  billiards: Rect;
}

function agePaper(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rand: () => number): void {
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(90,60,25,0.07)' : 'rgba(255,240,210,0.06)';
    ctx.fillRect(x + rand() * w, y + rand() * h, 1 + rand() * 3, 1 + rand() * 3);
  }
  for (let i = 0; i < 4; i++) {
    const sx = x + rand() * w;
    const sy = y + rand() * h;
    const r = 30 + rand() * 90;
    const g = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, r);
    g.addColorStop(0, 'rgba(120,80,35,0.16)');
    g.addColorStop(0.8, 'rgba(120,80,35,0.08)');
    g.addColorStop(1, 'rgba(120,80,35,0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  const edge = Math.min(w, h) * 0.1;
  const sides: [number, number, number, number, number, number, number, number][] = [
    [x, y, x + edge, y, x, y, edge, h],
    [x + w, y, x + w - edge, y, x + w - edge, y, edge, h],
    [x, y, x, y + edge, x, y, w, edge],
    [x, y + h, x, y + h - edge, x, y + h - edge, w, edge],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, 'rgba(60,32,12,0.6)');
    g.addColorStop(1, 'rgba(60,32,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  }
}

function drawOutlaw(ctx: CanvasRenderingContext2D, bx: number, by: number, bw: number, bh: number, rand: () => number): void {
  const cx = bx + bw / 2;
  const headW = 0.13 + rand() * 0.03;
  const hatW = 0.28 + rand() * 0.08;
  const shoulder = 0.06 + rand() * 0.06;
  ctx.fillStyle = 'rgba(70,45,22,0.18)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = 'rgba(60,35,15,0.12)';
  ctx.lineWidth = 1;
  for (let i = -bh; i < bw; i += 7) {
    ctx.beginPath();
    ctx.moveTo(bx + i, by + bh);
    ctx.lineTo(bx + i + bh, by);
    ctx.stroke();
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx, by, bw, bh);
  ctx.clip();
  ctx.fillStyle = '#2c1c10';
  ctx.beginPath();
  ctx.moveTo(bx + shoulder * bw, by + bh);
  ctx.bezierCurveTo(bx + (shoulder + 0.02) * bw, by + 0.74 * bh, bx + 0.3 * bw, by + 0.68 * bh, cx, by + 0.67 * bh);
  ctx.bezierCurveTo(bx + 0.7 * bw, by + 0.68 * bh, bx + (0.98 - shoulder) * bw, by + 0.74 * bh, bx + (1 - shoulder) * bw, by + bh);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(cx - 0.06 * bw, by + 0.52 * bh, 0.12 * bw, 0.2 * bh);
  ctx.beginPath();
  ctx.ellipse(cx, by + 0.47 * bh, headW * bw, 0.17 * bh, 0, 0, PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, by + 0.33 * bh, hatW * bw, 0.045 * bh, 0, 0, PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - 0.17 * bw, by + 0.34 * bh);
  ctx.lineTo(cx - 0.15 * bw, by + 0.13 * bh);
  ctx.quadraticCurveTo(cx, by + 0.2 * bh, cx + 0.15 * bw, by + 0.13 * bh);
  ctx.lineTo(cx + 0.17 * bw, by + 0.34 * bh);
  ctx.closePath();
  ctx.fill();
  if (rand() > 0.4) {
    ctx.fillStyle = 'rgba(120,40,25,0.55)';
    ctx.beginPath();
    ctx.moveTo(cx - 0.14 * bw, by + 0.52 * bh);
    ctx.lineTo(cx + 0.14 * bw, by + 0.52 * bh);
    ctx.lineTo(cx, by + 0.66 * bh);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = '#2a1a0e';
  ctx.lineWidth = 3;
  ctx.strokeRect(bx, by, bw, bh);
}

function drawWanted(ctx: CanvasRenderingContext2D, x: number, y: number, info: WantedInfo, seed: number): void {
  const { w, h } = POSTER_PX;
  const rand = makeRng(seed);
  const cx = x + w / 2;
  ctx.fillStyle = '#cdb485';
  ctx.fillRect(x, y, w, h);
  agePaper(ctx, x, y, w, h, rand);
  ctx.strokeStyle = '#2a1a0e';
  ctx.lineWidth = 3;
  ctx.strokeRect(x + 14, y + 14, w - 28, h - 28);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 20, y + 20, w - 40, h - 40);

  ctx.fillStyle = '#24160b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 100px ${SERIF}`;
  ctx.fillText('WANTED', cx, y + 112, w - 56);
  ctx.font = `bold 28px ${SERIF}`;
  ctx.fillText('DEAD OR ALIVE', cx, y + 148, w - 90);
  drawOutlaw(ctx, x + 72, y + 164, w - 144, 190, rand);
  ctx.fillStyle = '#24160b';
  ctx.font = `bold 34px ${SERIF}`;
  ctx.fillText(info.name, cx, y + 398, w - 50);
  ctx.font = `italic 18px ${SERIF}`;
  ctx.fillText(info.crime, cx, y + 426, w - 50);
  ctx.font = `bold 28px ${SERIF}`;
  ctx.fillText('— REWARD —', cx, y + 462, w - 80);
  ctx.font = `bold 58px ${SERIF}`;
  ctx.fillText(info.reward, cx, y + 512, w - 80);

  ctx.strokeStyle = 'rgba(70,45,20,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y + h * (0.45 + rand() * 0.1));
  ctx.lineTo(x + w, y + h * (0.45 + rand() * 0.1));
  ctx.stroke();
  ctx.fillStyle = '#1a120c';
  for (const nx of [x + 26, x + w - 26]) {
    ctx.beginPath();
    ctx.arc(nx, y + 26, 5, 0, PI * 2);
    ctx.fill();
  }
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -PI / 2 + (i * PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.42;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

function drawBoardSign(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  base: string,
  paint: string,
  title: string,
  subtitle: string,
  seed: number,
): void {
  const rand = makeRng(seed);
  const wood = createWoodTexture('dark').map.image as HTMLCanvasElement;
  ctx.fillStyle = base;
  ctx.fillRect(x, y, w, h);
  const pattern = ctx.createPattern(wood, 'repeat');
  if (pattern) {
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = pattern;
    ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(x, y + h / 2 - 2, w, 3);
  ctx.strokeStyle = paint;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(4, h * 0.03);
  ctx.strokeRect(x + h * 0.07, y + h * 0.07, w - h * 0.14, h - h * 0.14);
  ctx.globalAlpha = 1;

  const titleSize = subtitle ? h * 0.52 : h * 0.68;
  const titleY = subtitle ? y + h * 0.62 : y + h * 0.76;
  ctx.textAlign = 'center';
  ctx.font = `bold ${titleSize}px ${SERIF}`;
  ctx.fillStyle = 'rgba(10,5,2,0.8)';
  ctx.fillText(title, x + w / 2 + 5, titleY + 5, w * 0.72);
  ctx.fillStyle = paint;
  ctx.fillText(title, x + w / 2, titleY, w * 0.72);
  if (subtitle) {
    ctx.font = `bold ${h * 0.16}px ${SERIF}`;
    ctx.fillText(subtitle, x + w / 2, y + h * 0.84, w * 0.8);
  }
  drawStar(ctx, x + w * 0.08, y + h / 2, h * 0.14);
  drawStar(ctx, x + w * 0.92, y + h / 2, h * 0.14);

  ctx.fillStyle = base;
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.3 + rand() * 0.4;
    ctx.fillRect(x + rand() * w, y + rand() * h, 1 + rand() * 5, 1 + rand() * 2);
  }
  ctx.globalAlpha = 1;
}

function createSignAtlas(): SignAtlas {
  const [canvas, ctx] = makeCanvas(ATLAS_W, ATLAS_H);
  ctx.fillStyle = '#20150d';
  ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  const posters: Rect[] = [];
  WANTED.forEach((info, i) => {
    const px = 10 + i * 402;
    drawWanted(ctx, px, 10, info, 1000 + i * 77);
    posters.push(rectUV(px, 10, POSTER_PX.w, POSTER_PX.h, ATLAS_W, ATLAS_H));
  });
  drawBoardSign(ctx, 10, 560, 1300, 275, '#2b1a0f', '#e2c07a', 'SALOON', '', 7);
  ctx.font = `bold 30px ${SERIF}`;
  ctx.fillStyle = '#e2c07a';
  ctx.fillText('EST.', 10 + 1300 * 0.08, 560 + 275 * 0.78);
  ctx.fillText('1879', 10 + 1300 * 0.92, 560 + 275 * 0.78);
  drawBoardSign(ctx, 1330, 560, 700, 220, '#5a1b12', '#ead6a4', 'WHISKEY', '10¢ A SHOT', 8);
  drawBoardSign(ctx, 1330, 790, 700, 220, '#1c2e22', '#d9b86a', 'BILLIARDS', "5¢ A RACK · NO SPITTIN'", 9);
  const texture = canvasTexture(canvas);
  texture.name = 'saloon-signs';
  return {
    texture,
    posters,
    saloon: rectUV(10, 560, 1300, 275, ATLAS_W, ATLAS_H),
    whiskey: rectUV(1330, 560, 700, 220, ATLAS_W, ATLAS_H),
    billiards: rectUV(1330, 790, 700, 220, ATLAS_W, ATLAS_H),
  };
}

interface GlowAtlas {
  texture: THREE.CanvasTexture;
  window: Rect;
  outside: Rect;
}

function createGlowAtlas(): GlowAtlas {
  const W = 1024;
  const H = 512;
  const [canvas, ctx] = makeCanvas(W, H);
  const rand = makeRng(77);

  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.75);
  sky.addColorStop(0, '#060c20');
  sky.addColorStop(1, '#1c2e58');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 480, H);
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `rgba(220,230,255,${0.3 + rand() * 0.7})`;
    const s = rand() > 0.9 ? 2 : 1;
    ctx.fillRect(rand() * 480, rand() * H * 0.65, s, s);
  }
  const moonGlow = ctx.createRadialGradient(330, 120, 20, 330, 120, 170);
  moonGlow.addColorStop(0, 'rgba(190,210,255,0.55)');
  moonGlow.addColorStop(1, 'rgba(190,210,255,0)');
  ctx.fillStyle = moonGlow;
  ctx.fillRect(150, 0, 330, 300);
  ctx.fillStyle = '#eef2ff';
  ctx.beginPath();
  ctx.arc(330, 120, 40, 0, PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(120,130,160,0.18)';
  for (const [mx, my, mr] of [[318, 110, 9], [344, 132, 6], [336, 104, 4]] as const) {
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#0b1122';
  ctx.beginPath();
  ctx.moveTo(0, 380);
  ctx.lineTo(40, 380);
  ctx.lineTo(70, 330);
  ctx.lineTo(170, 330);
  ctx.lineTo(200, 375);
  ctx.lineTo(290, 372);
  ctx.lineTo(310, 350);
  ctx.lineTo(400, 350);
  ctx.lineTo(430, 385);
  ctx.lineTo(480, 385);
  ctx.lineTo(480, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#04060c';
  ctx.fillRect(0, 440, 480, H - 440);
  ctx.fillRect(98, 290, 26, 160);
  ctx.fillRect(60, 340, 20, 60);
  ctx.fillRect(60, 390, 50, 16);
  ctx.fillRect(140, 320, 18, 56);
  ctx.fillRect(112, 366, 46, 14);
  for (const [ax, ay, r] of [[111, 290, 13], [70, 340, 10], [149, 320, 9]] as const) {
    ctx.beginPath();
    ctx.arc(ax, ay, r, 0, PI * 2);
    ctx.fill();
  }

  const ox = 512;
  const sky2 = ctx.createLinearGradient(0, 0, 0, H * 0.6);
  sky2.addColorStop(0, '#050918');
  sky2.addColorStop(1, '#121d38');
  ctx.fillStyle = sky2;
  ctx.fillRect(ox, 0, 512, H);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(220,230,255,${0.2 + rand() * 0.6})`;
    ctx.fillRect(ox + rand() * 512, rand() * H * 0.35, 1, 1);
  }
  ctx.fillStyle = '#03040a';
  const fronts: [number, number, number][] = [
    [0, 110, 170],
    [110, 150, 200],
    [260, 130, 150],
    [390, 122, 185],
  ];
  for (const [bx, bw, top] of fronts) ctx.fillRect(ox + bx, top, bw, 420 - top);
  const glow = ctx.createRadialGradient(ox + 320, 280, 4, ox + 320, 280, 60);
  glow.addColorStop(0, 'rgba(230,150,70,0.5)');
  glow.addColorStop(1, 'rgba(230,150,70,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(ox + 250, 210, 140, 140);
  ctx.fillStyle = '#d99a4a';
  ctx.fillRect(ox + 305, 262, 30, 36);
  ctx.fillStyle = '#03040a';
  ctx.fillRect(ox + 318, 262, 3, 36);
  ctx.fillStyle = '#6a4424';
  ctx.fillRect(ox + 150, 300, 18, 22);
  const street = ctx.createLinearGradient(0, 400, 0, H);
  street.addColorStop(0, '#0c0e17');
  street.addColorStop(1, '#1a150e');
  ctx.fillStyle = street;
  ctx.fillRect(ox, 420, 512, H - 420);
  ctx.fillStyle = '#05060a';
  ctx.fillRect(ox + 40, 380, 8, 60);
  ctx.fillRect(ox + 150, 380, 8, 60);
  ctx.fillRect(ox + 40, 388, 118, 6);

  const texture = canvasTexture(canvas);
  texture.name = 'saloon-glow';
  return { texture, window: rectUV(0, 0, 480, H, W, H), outside: rectUV(ox, 0, 512, H, W, H) };
}

function createMirrorTexture(): THREE.CanvasTexture {
  const S = 256;
  const [canvas, ctx] = makeCanvas(S, S);
  const rand = makeRng(5);
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.75);
  g.addColorStop(0, '#a89c88');
  g.addColorStop(1, '#3e362d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 220; i++) {
    const edge = rand() < 0.5;
    const x = edge ? (rand() < 0.5 ? rand() * 30 : S - rand() * 30) : rand() * S;
    const y = rand() * S;
    ctx.fillStyle = `rgba(20,15,10,${0.2 + rand() * 0.4})`;
    ctx.beginPath();
    ctx.arc(x, y, 0.5 + rand() * (edge ? 4 : 1.5), 0, PI * 2);
    ctx.fill();
  }
  return canvasTexture(canvas);
}

function createMoonTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const [canvas, ctx] = makeCanvas(W, H);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  const ss = (e0: number, e1: number, x: number): number => {
    const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      let value: number;
      if (x < W / 2) {
        const u = (x + 0.5) / (W / 2);
        const across = Math.pow(Math.sin(u * PI), 0.7);
        value = 0.06 * across * v * v * ss(0.0, 0.3, v) * ss(1.0, 0.94, v);
      } else {
        const u = (x - W / 2 + 0.5) / (W / 2);
        const mullionU = ss(0.012, 0.03, Math.abs(u - 0.5));
        const mullionV = ss(0.012, 0.03, Math.abs(v - 0.5));
        const border = ss(0.0, 0.06, Math.min(u, 1 - u)) * ss(0.0, 0.06, Math.min(v, 1 - v));
        value = mullionU * mullionV * border;
      }
      const i = (y * W + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = value * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = canvasTexture(canvas, false);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// ---------------------------------------------------------------------------
// Dust
// ---------------------------------------------------------------------------

const DUST_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uViewH;
uniform float uSize;
uniform float uLightY;
uniform float uTanA;
uniform float uMinY;
uniform float uMaxY;
attribute vec3 seed;
varying float vAlpha;
void main() {
  vec3 p = position;
  float t = uTime;
  p.x += sin(t * (0.05 + 0.05 * seed.x) + seed.y * 6.2831) * 0.12;
  p.z += cos(t * (0.04 + 0.05 * seed.y) + seed.z * 6.2831) * 0.1;
  float range = uMaxY - uMinY;
  p.y = uMinY + mod(p.y - uMinY + sin(t * 0.07 + seed.x * 6.2831) * 0.05 - t * (0.004 + 0.01 * seed.z), range);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 0.05);
  gl_PointSize = clamp(uSize * (0.5 + seed.z) * projectionMatrix[1][1] * uViewH * 0.5 / depth, 1.0, 6.0);
  float h = max(uLightY - p.y, 0.0);
  float cone = 1.0 - smoothstep(h * uTanA * 0.55, h * uTanA, length(p.xz));
  float edge = smoothstep(0.0, 0.1, p.y - uMinY) * smoothstep(0.0, 0.12, uMaxY - p.y);
  float twinkle = 0.55 + 0.45 * sin(t * (0.6 + seed.x) + seed.y * 40.0);
  vAlpha = cone * edge * twinkle * smoothstep(0.15, 0.5, depth);
}
`;

const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = 1.0 - dot(c, c) * 4.0;
  if (d <= 0.0) discard;
  gl_FragColor = vec4(uColor * d * d * vAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function createDust(count: number): { points: THREE.Points; time: { value: number } } {
  const rand = makeRng(99);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rand() - 0.5) * 2.5;
    positions[i * 3 + 1] = 0.05 + rand() * 0.85;
    positions[i * 3 + 2] = (rand() - 0.5) * 1.4;
    seeds[i * 3] = rand();
    seeds[i * 3 + 1] = rand();
    seeds[i * 3 + 2] = rand();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  const time = { value: 0 };
  const viewH = { value: 800 };
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: time,
      uViewH: viewH,
      uSize: { value: 0.0045 },
      uLightY: { value: TABLE_LIGHT.height },
      uTanA: { value: Math.tan(0.8) },
      uMinY: { value: 0.04 },
      uMaxY: { value: 0.9 },
      uColor: { value: linear(0.32, 0.24, 0.15) },
    },
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'dust';
  points.frustumCulled = false;
  points.renderOrder = 2;
  const size = new THREE.Vector2();
  points.onBeforeRender = (renderer) => {
    viewH.value = renderer.getDrawingBufferSize(size).y;
  };
  return { points, time };
}

// ---------------------------------------------------------------------------
// Saloon
// ---------------------------------------------------------------------------

interface Lantern {
  light: THREE.PointLight | null;
  seed: number;
  level: number;
}

interface InstanceSpec {
  pos: V3;
  scale: V3;
  color?: THREE.Color;
  flip?: boolean;
  ry?: number;
}

export function createSaloon(opts: { quality: Quality }): Saloon {
  const high = opts.quality === 'high';
  const seg = high ? 20 : 12;
  const rand = makeRng(2024);
  const group = new THREE.Group();
  group.name = 'saloon';

  const floorTex = createWoodTexture('floor');
  const wallTex = createWoodTexture('wall');
  const darkTex = createWoodTexture('dark');
  const railTex = createWoodTexture('rail');
  const leatherTex = createLeatherTexture();
  const signs = createSignAtlas();
  const glow = createGlowAtlas();

  const floorMat = new THREE.MeshStandardMaterial({ map: floorTex.map, bumpMap: floorTex.bumpMap, bumpScale: 1.4, roughness: 0.8, envMapIntensity: 0.5 });
  const ceilingMat = new THREE.MeshStandardMaterial({ map: floorTex.map, bumpMap: floorTex.bumpMap, color: 0x6a5a4c, roughness: 0.95, envMapIntensity: 0.3 });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex.map, bumpMap: wallTex.bumpMap, bumpScale: 1.5, roughness: 0.88, envMapIntensity: 0.4 });
  const darkMat = new THREE.MeshStandardMaterial({ map: darkTex.map, bumpMap: darkTex.bumpMap, roughness: 0.6, envMapIntensity: 0.6 });
  const railMat = new THREE.MeshStandardMaterial({ map: railTex.map, bumpMap: railTex.bumpMap, bumpScale: 0.6, roughness: 0.34, envMapIntensity: 0.8 });
  const metalMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.75, roughness: 0.42 });
  const matteMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, envMapIntensity: 0.5 });
  const leatherMat = new THREE.MeshStandardMaterial({ map: leatherTex, roughness: 0.55, envMapIntensity: 0.6 });
  const signMat = new THREE.MeshStandardMaterial({ map: signs.texture, roughness: 0.9, envMapIntensity: 0.3 });
  const glowMat = new THREE.MeshBasicMaterial({ map: glow.texture, fog: false });
  glowMat.color.setScalar(1.25);
  const flameBase = linear(1, 1, 1);
  const flameMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mirrorMat = new THREE.MeshStandardMaterial({ map: createMirrorTexture(), metalness: 1, roughness: 0.14 });
  const bottleMat = new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.05, envMapIntensity: 1.4 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xd6dfda, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, envMapIntensity: 1.5 });
  const moonMat = new THREE.MeshBasicMaterial({ map: createMoonTexture(), color: linear(0.22, 0.3, 0.62), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });

  const floor = new Batch(2.5, 2.5);
  const ceiling = new Batch(2.5, 2.5);
  const walls = new Batch(2.4, 2.4);
  const dark = new Batch(1, 1);
  const rail = new Batch(1.6, 0.4);
  const leather = new Batch(0.5, 0.5);
  const metal = new Batch(1, 1, true);
  const matte = new Batch(1, 1, true);
  const flames = new Batch(1, 1, true);
  const signBatch = new Batch(1, 1);
  const glowBatch = new Batch(1, 1);

  const bottles: InstanceSpec[] = [];
  const glasses: InstanceSpec[] = [];
  const BOTTLE_COLORS = ['#4a2610', '#1c3319', '#6b3c14', '#1a120c', '#3a0e10', '#7a6440'].map((c) => new THREE.Color(c));
  const randomBottle = (x: number, y: number, z: number): void => {
    const s = 0.85 + rand() * 0.25;
    bottles.push({ pos: [x, y, z], scale: [s, 0.8 + rand() * 0.2, s], color: BOTTLE_COLORS[Math.floor(rand() * BOTTLE_COLORS.length)], ry: rand() * PI * 2 });
  };
  const addGlass = (x: number, y: number, z: number, flip = false, small = false): void => {
    const s = small ? 0.7 : 1;
    glasses.push({ pos: [x, y, z], scale: [s, small ? 0.65 : 1, s], flip });
  };

  const BRASS = new THREE.Color('#a9844a');
  const IRON = new THREE.Color('#2b2824');
  const BONE = new THREE.Color('#d6cab0');

  const colliders: SaloonCollider[] = [];
  const blockCircle = (x: number, z: number, r: number): void => {
    colliders.push({ kind: 'circle', x, z, r });
  };
  const blockBox = (minX: number, maxX: number, minZ: number, maxZ: number): void => {
    colliders.push({ kind: 'box', minX, maxX, minZ, maxZ });
  };
  blockBox(-TABLE_EXTENT.x - TABLE_CLEARANCE, TABLE_EXTENT.x + TABLE_CLEARANCE, -TABLE_EXTENT.z - TABLE_CLEARANCE, TABLE_EXTENT.z + TABLE_CLEARANCE);

  // --- Room shell -----------------------------------------------------------
  floor.add(new THREE.PlaneGeometry(HX * 2, HZ * 2).rotateX(-PI / 2).translate(0, FLOOR_Y, 0));
  floor.add(new THREE.PlaneGeometry(0.8, DOOR_HALF * 2).rotateX(-PI / 2).translate(HX + 0.4, FLOOR_Y, 0));
  ceiling.add(new THREE.PlaneGeometry(HX * 2, HZ * 2).rotateX(PI / 2).translate(0, CEIL_Y, 0));

  walls.add(at(box(HX * 2 + WALL_T * 2, ROOM_H, WALL_T), 0, fy(ROOM_H / 2), -HZ - WALL_T / 2));
  walls.add(at(box(HX * 2 + WALL_T * 2, ROOM_H, WALL_T), 0, fy(ROOM_H / 2), HZ + WALL_T / 2));
  walls.add(at(box(WALL_T, ROOM_H, HZ * 2), -HX - WALL_T / 2, fy(ROOM_H / 2), 0));
  const sidePiece = HZ - DOOR_HALF;
  for (const s of [-1, 1]) walls.add(at(box(WALL_T, ROOM_H, sidePiece), HX + WALL_T / 2, fy(ROOM_H / 2), s * (DOOR_HALF + sidePiece / 2)));
  walls.add(at(box(WALL_T, ROOM_H - DOOR_H, DOOR_HALF * 2), HX + WALL_T / 2, fy(DOOR_H + (ROOM_H - DOOR_H) / 2), 0));

  const trim = (height: number, y: number, depth: number): void => {
    for (const s of [-1, 1]) dark.add(at(box(HX * 2, height, depth), 0, fy(y), s * (HZ - depth / 2)));
    dark.add(at(box(depth, height, HZ * 2), -HX + depth / 2, fy(y), 0));
    for (const s of [-1, 1]) dark.add(at(box(depth, height, sidePiece - 0.1), HX - depth / 2, fy(y), s * (DOOR_HALF + 0.1 + (sidePiece - 0.1) / 2)));
  };
  trim(0.16, 0.08, 0.03);
  trim(0.05, 1.05, 0.04);

  for (const x of [-4.2, -2.5, 2.5, 4.2]) dark.add(at(box(0.2, 0.24, HZ * 2), x, CEIL_Y - 0.12, 0));
  for (const s of [-1, 1]) dark.add(at(box(HX * 2, 0.16, 0.1), 0, CEIL_Y - 0.08, s * (HZ - 0.05)));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) dark.add(at(box(0.14, ROOM_H, 0.14), sx * (HX - 0.07), fy(ROOM_H / 2), sz * (HZ - 0.07)));
  for (const x of [-3.1, 3.1]) for (const sz of [-1, 1]) dark.add(at(box(0.12, ROOM_H, 0.07), x, fy(ROOM_H / 2), sz * (HZ - 0.035)));

  // --- Bar ------------------------------------------------------------------
  const BAR_LEN = 5.4;
  blockBox(-HX, -3.74, -BAR_LEN / 2 - 0.1, BAR_LEN / 2 + 0.1);
  rail.add(at(box(0.5, 1.02, BAR_LEN), -4.2, fy(0.51), 0));
  rail.add(at(box(0.64, 0.05, BAR_LEN + 0.12), -4.19, fy(1.045), 0));
  dark.add(at(box(0.03, 0.12, BAR_LEN), -3.935, fy(0.06), 0));
  dark.add(at(box(0.03, 0.05, BAR_LEN), -3.935, fy(0.98), 0));
  for (let i = 0; i <= 6; i++) dark.add(at(box(0.04, 0.84, 0.07), -3.93, fy(0.54), -2.7 + i * 0.9));
  metal.add(new THREE.CylinderGeometry(0.024, 0.024, 5.2, 10).rotateX(PI / 2).translate(-3.78, fy(0.2), 0), { color: BRASS });
  for (const z of [-2.4, -1.2, 0, 1.2, 2.4]) {
    metal.add(new THREE.CylinderGeometry(0.011, 0.011, 0.17, 6).rotateZ(PI / 2).translate(-3.865, fy(0.2), z), { color: BRASS });
  }

  rail.add(at(box(0.48, 0.95, BAR_LEN), -5.26, fy(0.475), 0));
  rail.add(at(box(0.54, 0.04, BAR_LEN + 0.1), -5.23, fy(0.97), 0));
  for (let i = 0; i <= 6; i++) dark.add(at(box(0.03, 0.8, 0.05), -5.01, fy(0.47), -2.7 + i * 0.9));
  const SHELF_LEVELS = [1.28, 1.64, 2.0];
  for (const side of [-1, 1]) {
    const zc = side * 1.975;
    for (const level of SHELF_LEVELS) {
      dark.add(at(box(0.28, 0.03, 1.45), -5.36, fy(level), zc));
      const n = high ? 9 : 5;
      for (let i = 0; i < n; i++) {
        if (rand() < 0.12) continue;
        randomBottle(-5.37 + (rand() - 0.5) * 0.06, fy(level + 0.015), zc - 0.66 + ((i + 0.5) * 1.32) / n);
      }
    }
    for (const z of [1.25, 2.72]) dark.add(at(box(0.3, 1.36, 0.04), -5.35, fy(1.66), side * z));
  }
  dark.add(at(box(0.36, 0.08, 5.6), -5.32, fy(2.36), 0));
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(2.46, 1.32).rotateY(PI / 2).translate(-HX + 0.005, fy(1.66), 0), mirrorMat);
  mirror.name = 'bar-mirror';
  mirror.matrixAutoUpdate = false;

  const backCount = high ? 10 : 6;
  for (let i = 0; i < backCount; i++) randomBottle(-5.3 + (rand() - 0.5) * 0.08, fy(0.99), -1.05 + ((i + 0.5) * 2.1) / backCount);
  for (let i = 0; i < (high ? 8 : 4); i++) addGlass(-5.1, fy(0.99), -1.0 + i * (2.0 / (high ? 7 : 3)), true);
  for (const z of [-0.4, 0.6, 1.9]) randomBottle(-4.28, fy(1.07), z);
  for (const [z, small] of [[-0.3, true], [-0.15, false], [0.75, true], [1.75, false], [-1.6, true], [0.2, false]] as const) {
    if (!high && small) continue;
    addGlass(-4.05, fy(1.07), z, false, small);
  }

  // cash register
  metal.add(at(box(0.3, 0.22, 0.34), -4.28, fy(1.18), -2.2), { color: BRASS });
  metal.add(at(box(0.32, 0.06, 0.38), -4.28, fy(1.1), -2.2), { color: new THREE.Color('#6b5230') });
  metal.add(at(box(0.08, 0.1, 0.26), -4.36, fy(1.34), -2.2), { color: BRASS });
  matte.add(at(box(0.012, 0.05, 0.2), -4.315, fy(1.34), -2.2), { color: '#e8dcc0' });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      matte.add(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8).translate(-4.18 + j * 0.04, fy(1.3), -2.32 + i * 0.07), { color: '#e8dcc0' });
    }
  }
  // beer taps
  for (let i = 0; i < 3; i++) {
    const z = 1.2 + i * 0.14;
    metal.add(new THREE.CylinderGeometry(0.014, 0.018, 0.22, 8).translate(-4.4, fy(1.18), z), { color: BRASS });
    metal.add(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 6).rotateZ(PI / 2).translate(-4.33, fy(1.26), z), { color: BRASS });
    dark.add(new THREE.CylinderGeometry(0.012, 0.016, 0.14, 8).translate(-4.4, fy(1.36), z));
  }
  // oil lamps on the counter
  for (const z of [-1.0, 1.0]) {
    metal.add(new THREE.CylinderGeometry(0.04, 0.055, 0.07, 10).translate(-4.3, fy(1.105), z), { color: BRASS });
    flames.add(new THREE.CylinderGeometry(0.028, 0.034, 0.13, 10).translate(-4.3, fy(1.205), z), { color: linear(1.8, 0.95, 0.35) });
    metal.add(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 10).translate(-4.3, fy(1.275), z), { color: BRASS });
  }
  // spittoon
  const spittoon = new THREE.LatheGeometry(
    [[0.07, 0], [0.12, 0.04], [0.13, 0.1], [0.08, 0.17], [0.07, 0.2], [0.1, 0.23], [0.09, 0.235]].map(([x, y]) => new THREE.Vector2(x, y)),
    seg,
  );
  metal.add(spittoon.translate(-3.72, FLOOR_Y, -2.95), { color: BRASS });
  blockCircle(-3.72, -2.95, 0.15);

  // stools
  for (const z of [-2.2, -1.1, 0, 1.1, 2.2]) {
    const x = -3.55;
    blockCircle(x, z, 0.2);
    leather.add(new THREE.CylinderGeometry(0.17, 0.16, 0.06, seg).translate(x, fy(0.73), z), { uvScale: [2, 0.25] });
    for (let k = 0; k < 4; k++) {
      const a = PI / 4 + (k * PI) / 2;
      const leg = new THREE.CylinderGeometry(0.016, 0.02, 0.71, 6).rotateZ(0.1).translate(0.145, 0.355, 0).rotateY(a).translate(x, FLOOR_Y, z);
      dark.add(leg);
    }
    metal.add(new THREE.TorusGeometry(0.155, 0.009, 6, seg).rotateX(PI / 2).translate(x, fy(0.26), z), { color: IRON });
  }

  // --- Piano ----------------------------------------------------------------
  {
    const m = frame(-2.2, FLOOR_Y, HZ);
    const L = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.applyMatrix4(m);
    blockBox(-2.2 - 0.79, -2.2 + 0.79, HZ - 0.62, HZ);
    blockCircle(-2.2, HZ - 0.85, 0.2);
    rail.add(L(at(box(1.5, 1.28, 0.34), 0, 0.64, -0.17)));
    rail.add(L(at(box(1.5, 0.09, 0.26), 0, 0.7, -0.47)));
    for (const s of [-1, 1]) {
      rail.add(L(at(box(0.08, 0.66, 0.08), s * 0.7, 0.33, -0.55)));
      rail.add(L(at(box(0.1, 0.1, 0.26), s * 0.7, 0.79, -0.47)));
      dark.add(L(at(box(0.5, 0.36, 0.012), s * 0.36, 0.34, -0.345)));
    }
    rail.add(L(at(box(1.3, 0.12, 0.02), 0, 0.83, -0.35)));
    rail.add(L(at(box(0.8, 0.2, 0.02), 0, 1.0, -0.37)));
    rail.add(L(at(box(1.54, 0.03, 0.38), 0, 1.295, -0.18)));
    dark.add(L(at(box(1.56, 0.04, 0.02), 0, 1.25, -0.345)));
    matte.add(L(at(box(1.3, 0.022, 0.15), 0, 0.756, -0.5)), { color: '#e9dfc6' });
    matte.add(L(new THREE.PlaneGeometry(0.44, 0.28).rotateY(PI).translate(0, 1.03, -0.385)), { color: '#d9ccaa' });
    const keyW = 1.3 / 52;
    for (let i = 0; i < 51; i++) {
      const note = i % 7;
      if (note === 2 || note === 6) continue;
      matte.add(L(at(box(0.013, 0.014, 0.09), -0.65 + (i + 1) * keyW, 0.774, -0.47)), { color: '#15110e' });
    }
    for (const s of [-1, 1]) {
      metal.add(L(new THREE.CylinderGeometry(0.026, 0.02, 0.02, 8).translate(s * 0.62, 1.04, -0.4)), { color: BRASS });
      metal.add(L(at(box(0.012, 0.012, 0.08), s * 0.62, 1.03, -0.36)), { color: BRASS });
      matte.add(L(new THREE.CylinderGeometry(0.011, 0.012, 0.1, 8).translate(s * 0.62, 1.1, -0.4)), { color: '#e6dcc4' });
      flames.add(L(new THREE.SphereGeometry(0.011, 8, 6).scale(1, 1.9, 1).translate(s * 0.62, 1.172, -0.4)), { color: linear(3.2, 1.8, 0.6) });
    }
    randomBottle(-2.2 + 0.45, fy(1.31), HZ - 0.15);
    addGlass(-2.2 + 0.3, fy(1.31), HZ - 0.2, false, true);
    // piano stool
    leather.add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, seg).translate(-2.2, fy(0.5), HZ - 0.85), { uvScale: [2, 0.25] });
    dark.add(new THREE.CylinderGeometry(0.04, 0.05, 0.44, 8).translate(-2.2, fy(0.25), HZ - 0.85));
    for (let k = 0; k < 3; k++) {
      const a = (k * PI * 2) / 3;
      dark.add(at(box(0.04, 0.04, 0.22), 0, fy(0.03), 0.1, a).translate(-2.2, 0, HZ - 0.85));
    }
  }

  // --- Poker tables and chairs ---------------------------------------------
  const chair = (m: THREE.Matrix4): void => {
    const L = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.applyMatrix4(m);
    dark.add(L(at(box(0.42, 0.04, 0.42), 0, 0.46, 0)));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) dark.add(L(at(box(0.04, 0.46, 0.04), sx * 0.18, 0.23, sz * 0.18)));
      dark.add(L(at(box(0.04, 0.52, 0.04), sx * 0.18, 0.74, -0.18)));
    }
    dark.add(L(at(box(0.44, 0.08, 0.035), 0, 0.97, -0.18)));
    for (const y of [0.66, 0.8]) dark.add(L(at(box(0.34, 0.06, 0.02), 0, y, -0.18)));
    for (const sz of [-1, 1]) dark.add(L(at(box(0.34, 0.025, 0.025), 0, 0.15, sz * 0.18)));
  };

  const CHIP_COLORS = ['#8b1f1a', '#d8d0bc', '#1e2d55'];
  const pokerTable = (cx: number, cz: number, chairAngles: readonly number[]): void => {
    blockCircle(cx, cz, 0.52);
    rail.add(new THREE.CylinderGeometry(0.5, 0.5, 0.045, seg * 2).translate(cx, fy(0.76), cz));
    matte.add(new THREE.CylinderGeometry(0.43, 0.43, 0.006, seg * 2).translate(cx, fy(0.785), cz), { color: '#1f4630' });
    dark.add(new THREE.CylinderGeometry(0.06, 0.08, 0.72, 10).translate(cx, fy(0.38), cz));
    for (const a of [PI / 4, -PI / 4]) dark.add(at(box(0.75, 0.05, 0.08), 0, fy(0.025), 0, a).translate(cx, 0, cz));
    for (const a of chairAngles) {
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const pull = 0.72 + rand() * 0.12;
      chair(frame(cx + dx * pull, FLOOR_Y, cz + dz * pull, Math.atan2(-dx, -dz) + (rand() - 0.5) * 0.4));
      blockCircle(cx + dx * pull, cz + dz * pull, 0.27);
    }
    for (let i = 0; i < 6; i++) {
      const a = rand() * PI * 2;
      const r = rand() * 0.25;
      matte.add(at(box(0.063, 0.002, 0.088), 0, fy(0.79), 0, rand() * PI).translate(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r), { color: '#e6ddc6' });
    }
    for (let i = 0; i < 5; i++) {
      const a = rand() * PI * 2;
      const r = 0.15 + rand() * 0.2;
      const n = 2 + Math.floor(rand() * 6);
      matte.add(
        new THREE.CylinderGeometry(0.02, 0.02, 0.004 * n, 10).translate(cx + Math.cos(a) * r, fy(0.788 + 0.002 * n), cz + Math.sin(a) * r),
        { color: CHIP_COLORS[i % CHIP_COLORS.length] },
      );
    }
    randomBottle(cx + 0.12, fy(0.788), cz - 0.1);
    addGlass(cx - 0.18, fy(0.788), cz + 0.12, false, true);
    addGlass(cx + 0.2, fy(0.788), cz + 0.18, false, true);
  };
  pokerTable(3.9, 3.05, [PI * 0.1, PI * 0.75, PI * 1.3]);
  pokerTable(3.9, -3.0, [-PI * 0.2, PI * 0.6, PI * 1.05, PI * 1.45]);

  // --- Barrels and crate ----------------------------------------------------
  const BARREL_H = 0.86;
  const barrelProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    barrelProfile.push(new THREE.Vector2(0.25 + 0.045 * Math.sin(t * PI), t * BARREL_H));
  }
  const barrel = (x: number, z: number): void => {
    blockCircle(x, z, 0.31);
    const ry = rand() * PI;
    walls.add(new THREE.LatheGeometry(barrelProfile, seg).rotateY(ry).translate(x, FLOOR_Y, z), { uvScale: [0.72, 0.36] });
    walls.add(new THREE.CircleGeometry(0.25, seg).rotateX(-PI / 2).translate(x, fy(BARREL_H - 0.02), z));
    for (const t of [0.12, 0.3, 0.7, 0.88]) {
      const r = 0.25 + 0.045 * Math.sin(t * PI) + 0.004;
      metal.add(new THREE.TorusGeometry(r, 0.008, 4, seg).rotateX(PI / 2).translate(x, fy(t * BARREL_H), z), { color: IRON });
    }
  };
  barrel(-5.05, -3.95);
  barrel(-4.45, -4.02);
  barrel(-5.08, 3.95);
  barrel(5.05, -1.6);
  dark.add(at(box(0.52, 0.5, 0.52), -5.18, fy(0.25), 3.3, 0.1));
  blockBox(-HX, -5.18 + 0.3, 3.3 - 0.3, 3.3 + 0.3);
  for (const y of [0.1, 0.4]) dark.add(at(box(0.54, 0.06, 0.54), -5.18, fy(y), 3.3, 0.1));

  // --- Window and moonlight -------------------------------------------------
  const winY = (WINDOW.bottom + WINDOW.top) / 2;
  const winH = WINDOW.top - WINDOW.bottom;
  const winW = WINDOW.halfWidth * 2;
  glowBatch.add(new THREE.PlaneGeometry(winW, winH).translate(WINDOW.x, fy(winY), -HZ + 0.004), { uvRect: glow.window });
  for (const s of [-1, 1]) dark.add(at(box(0.08, winH + 0.16, 0.1), WINDOW.x + s * (WINDOW.halfWidth + 0.04), fy(winY), -HZ + 0.05));
  dark.add(at(box(winW + 0.16, 0.08, 0.1), WINDOW.x, fy(WINDOW.top + 0.04), -HZ + 0.05));
  dark.add(at(box(winW + 0.16, 0.08, 0.1), WINDOW.x, fy(WINDOW.bottom - 0.04), -HZ + 0.05));
  dark.add(at(box(winW + 0.3, 0.04, 0.18), WINDOW.x, fy(WINDOW.bottom - 0.1), -HZ + 0.09));
  dark.add(at(box(0.035, winH, 0.05), WINDOW.x, fy(winY), -HZ + 0.03));
  dark.add(at(box(winW, 0.035, 0.05), WINDOW.x, fy(winY), -HZ + 0.03));

  const moonBeam = createMoonBeamGeometry();
  const moonMesh = new THREE.Mesh(moonBeam.geometry, moonMat);
  moonMesh.name = 'moon-beam';
  moonMesh.renderOrder = 1;
  moonMesh.matrixAutoUpdate = false;

  // --- Doors and outside ----------------------------------------------------
  glowBatch.add(new THREE.PlaneGeometry(3.2, 3.0).rotateY(-PI / 2).translate(HX + 0.8, fy(1.5), 0), { uvRect: glow.outside });
  for (const s of [-1, 1]) dark.add(at(box(0.1, DOOR_H, 0.08), HX - 0.05, fy(DOOR_H / 2), s * (DOOR_HALF + 0.04)));
  dark.add(at(box(0.1, 0.1, DOOR_HALF * 2 + 0.16), HX - 0.05, fy(DOOR_H + 0.05), 0));
  const doors = createDoorLeaves(darkMat);
  const DOOR_HINGE_X = HX - 0.1;
  const doorMatrix = new THREE.Matrix4();
  const doorQuat = new THREE.Quaternion();
  const doorPos = new THREE.Vector3();
  const doorScale = new THREE.Vector3(1, 1, 1);
  const setDoors = (openLeft: number, openRight: number): void => {
    doorPos.set(DOOR_HINGE_X, fy(0.45), -DOOR_HALF + 0.02);
    doorQuat.setFromAxisAngle(Y_AXIS, -openLeft);
    doors.setMatrixAt(0, doorMatrix.compose(doorPos, doorQuat, doorScale));
    doorPos.set(DOOR_HINGE_X, fy(0.45), DOOR_HALF - 0.02);
    doorQuat.setFromAxisAngle(Y_AXIS, PI + openRight);
    doors.setMatrixAt(1, doorMatrix.compose(doorPos, doorQuat, doorScale));
    doors.instanceMatrix.needsUpdate = true;
  };
  setDoors(0.1, 0.14);
  doors.computeBoundingSphere();
  for (const s of [-1, 1]) {
    for (const y of [0.6, 1.45]) metal.add(at(box(0.03, 0.08, 0.04), DOOR_HINGE_X + 0.02, fy(y), s * (DOOR_HALF - 0.01)), { color: IRON });
  }

  // --- Posters and signs ----------------------------------------------------
  const POSTER_W = 0.46;
  const POSTER_H = 0.644;
  const posterSpots: { x: number; y: number; z: number; ry: number }[] = [
    { x: 0.2, y: 1.75, z: HZ - 0.006, ry: PI },
    { x: 1.0, y: 1.62, z: HZ - 0.006, ry: PI },
    { x: -1.5, y: 1.72, z: -HZ + 0.006, ry: 0 },
    { x: HX - 0.006, y: 1.7, z: 2.4, ry: -PI / 2 },
    { x: HX - 0.006, y: 1.66, z: -2.4, ry: -PI / 2 },
  ];
  posterSpots.forEach((p, i) => {
    const g = new THREE.PlaneGeometry(POSTER_W, POSTER_H).rotateZ((rand() - 0.5) * 0.08);
    signBatch.add(at(g, p.x, fy(p.y), p.z, p.ry), { uvRect: signs.posters[i] });
  });
  dark.add(at(box(0.04, 0.63, 2.72), -HX + 0.02, fy(2.8), 0));
  signBatch.add(at(new THREE.PlaneGeometry(2.6, 0.55), -HX + 0.042, fy(2.8), 0, PI / 2), { uvRect: signs.saloon });
  dark.add(at(box(1.16, 0.4, 0.03), -4.1, fy(2.3), -HZ + 0.015));
  signBatch.add(at(new THREE.PlaneGeometry(1.1, 0.345), -4.1, fy(2.3), -HZ + 0.032), { uvRect: signs.whiskey });
  dark.add(at(box(1.16, 0.4, 0.03), 2.4, fy(2.3), HZ - 0.015));
  signBatch.add(at(new THREE.PlaneGeometry(1.1, 0.345), 2.4, fy(2.3), HZ - 0.032, PI), { uvRect: signs.billiards });

  // --- Bull skull above the doors -------------------------------------------
  {
    const m = frame(HX - 0.08, fy(2.8), 0, -PI / 2);
    const L = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.applyMatrix4(m);
    dark.add(L(at(box(0.3, 0.42, 0.03), 0, -0.02, -0.055)));
    matte.add(L(new THREE.SphereGeometry(0.11, 14, 10).scale(1.15, 0.9, 0.75).translate(0, 0.05, 0)), { color: BONE });
    matte.add(L(new THREE.CylinderGeometry(0.075, 0.045, 0.26, 10).scale(1, 1, 0.7).translate(0, -0.1, 0.015)), { color: BONE });
    matte.add(L(new THREE.SphereGeometry(0.048, 10, 8).scale(1, 0.7, 0.8).translate(0, -0.23, 0.02)), { color: BONE });
    for (const s of [-1, 1]) {
      matte.add(L(new THREE.SphereGeometry(0.028, 10, 8).scale(1, 0.8, 0.5).translate(s * 0.058, 0.02, 0.07)), { color: '#1b140f' });
      matte.add(L(new THREE.SphereGeometry(0.01, 6, 5).translate(s * 0.02, -0.25, 0.055)), { color: '#1b140f' });
      matte.add(L(createHorn(s, high ? 20 : 12)));
    }
  }

  // --- Wall lanterns --------------------------------------------------------
  const lanterns: Lantern[] = [];
  const lanternSpots: { x: number; z: number; ry: number }[] = [
    { x: -4.0, z: HZ, ry: PI },
    { x: 4.0, z: -HZ, ry: 0 },
  ];
  lanternSpots.forEach((spot, i) => {
    const m = frame(spot.x, fy(2.05), spot.z, spot.ry);
    const L = (g: THREE.BufferGeometry): THREE.BufferGeometry => g.applyMatrix4(m);
    dark.add(L(at(box(0.14, 0.3, 0.02), 0, 0.05, 0.01)));
    metal.add(L(at(box(0.018, 0.018, 0.24), 0, 0.16, 0.12)), { color: IRON });
    metal.add(L(at(box(0.012, 0.012, 0.2).rotateX(0.75), 0, 0.09, 0.08)), { color: IRON });
    const c = 0.26;
    flames.add(L(at(box(0.1, 0.15, 0.1), 0, 0, c)), { color: linear(2.2, 1.15, 0.42) });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) metal.add(L(at(box(0.012, 0.19, 0.012), sx * 0.055, 0, c + sz * 0.055)), { color: IRON });
    metal.add(L(new THREE.ConeGeometry(0.085, 0.08, 4, 1).rotateY(PI / 4).translate(0, 0.135, c)), { color: IRON });
    metal.add(L(at(box(0.12, 0.025, 0.12), 0, -0.09, c)), { color: IRON });
    metal.add(L(new THREE.TorusGeometry(0.02, 0.004, 4, 10).translate(0, 0.19, c)), { color: IRON });
    const enabled = high || i === 0;
    let light: THREE.PointLight | null = null;
    if (enabled) {
      light = new THREE.PointLight(LANTERN_LIGHT.color, LANTERN_LIGHT.intensity, LANTERN_LIGHT.distance, 2);
      light.position.set(0, 0, c + 0.12).applyMatrix4(m);
      light.castShadow = false;
      light.name = `lantern-light-${i}`;
      group.add(light);
    }
    lanterns.push({ light, seed: i * 3.1 + 0.7, level: 1 });
  });

  // --- Table lamp -----------------------------------------------------------
  const lampFixture = createLampFixture(high, seg);
  group.add(lampFixture.object);

  const tableLight = new THREE.SpotLight(TABLE_LIGHT.color, TABLE_LIGHT.intensity, 0, TABLE_LIGHT.angle, TABLE_LIGHT.penumbra, 2);
  tableLight.name = 'table-light';
  tableLight.position.set(0, TABLE_LIGHT.height, 0);
  tableLight.target.position.set(0, 0, 0);
  tableLight.castShadow = true;
  const shadowSize = high ? 2048 : 1024;
  tableLight.shadow.mapSize.set(shadowSize, shadowSize);
  tableLight.shadow.camera.near = 0.3;
  tableLight.shadow.camera.far = 3.2;
  tableLight.shadow.focus = 0.8;
  tableLight.shadow.bias = high ? -0.0001 : -0.0002;
  tableLight.shadow.normalBias = high ? 0.0025 : 0.004;
  tableLight.shadow.radius = high ? 3 : 2;
  group.add(tableLight, tableLight.target);

  const hemi = new THREE.HemisphereLight(0x5a4030, 0x140d08, 0.5);
  hemi.name = 'ambient';
  group.add(hemi);

  const moonLight = new THREE.SpotLight(MOON_LIGHT.color, MOON_LIGHT.intensity, 0, 0.32, 0.7, 2);
  moonLight.name = 'moon-light';
  moonLight.castShadow = false;
  const winCenter = new THREE.Vector3(WINDOW.x, fy(winY), -HZ);
  const moonDir = new THREE.Vector3(...MOON_DIR);
  moonLight.target.position.copy(winCenter).addScaledVector(moonDir, winY);
  moonLight.position.copy(winCenter).addScaledVector(moonDir.clone().normalize(), -4);
  group.add(moonLight, moonLight.target);

  // --- Instanced bottles and glasses ---------------------------------------
  const bottleMesh = new THREE.InstancedMesh(createBottleGeometry(high ? 12 : 8), bottleMat, bottles.length);
  bottleMesh.name = 'bottles';
  const glassMesh = new THREE.InstancedMesh(createGlassGeometry(high ? 12 : 8), glassMat, glasses.length);
  glassMesh.name = 'glasses';
  glassMesh.renderOrder = 1;
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  bottles.forEach((b, i) => {
    q.setFromAxisAngle(Y_AXIS, b.ry ?? 0);
    bottleMesh.setMatrixAt(i, m4.compose(p.set(...b.pos), q, s.set(...b.scale)));
    bottleMesh.setColorAt(i, b.color ?? BOTTLE_COLORS[0]);
  });
  const flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), PI);
  glasses.forEach((g, i) => {
    const h = 0.09 * g.scale[1];
    p.set(g.pos[0], g.pos[1] + (g.flip ? h : 0), g.pos[2]);
    glassMesh.setMatrixAt(i, m4.compose(p, g.flip ? flipQ : q.identity(), s.set(...g.scale)));
  });
  for (const im of [bottleMesh, glassMesh]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
  }

  // --- Dust -----------------------------------------------------------------
  const dust = createDust(high ? 220 : 80);

  // --- Assemble -------------------------------------------------------------
  const floorMesh = floor.build(floorMat, 'floor');
  if (floorMesh) floorMesh.receiveShadow = true;
  const meshes = [
    floorMesh,
    ceiling.build(ceilingMat, 'ceiling'),
    walls.build(wallMat, 'walls'),
    dark.build(darkMat, 'dark-wood'),
    rail.build(railMat, 'mahogany'),
    leather.build(leatherMat, 'leather'),
    metal.build(metalMat, 'metal'),
    matte.build(matteMat, 'matte'),
    flames.build(flameMat, 'flames'),
    signBatch.build(signMat, 'signs'),
    glowBatch.build(glowMat, 'night-views'),
  ];
  for (const mesh of meshes) if (mesh) group.add(mesh);
  group.add(mirror, moonMesh, doors, bottleMesh, glassMesh, dust.points);

  const lampFlameBase = lampFixture.flameColor.clone();

  const update = (time: number, dt: number): void => {
    const k = 1 - Math.exp(-Math.max(dt, 0) * 14);
    let sum = 0;
    for (const l of lanterns) {
      l.level += (flameFlicker(time, l.seed) - l.level) * k;
      sum += l.level;
      if (l.light) l.light.intensity = LANTERN_LIGHT.intensity * l.level;
    }
    flameMat.color.copy(flameBase).multiplyScalar(sum / lanterns.length);
    lampFixture.flameMaterial.color.copy(lampFlameBase).multiplyScalar(0.97 + 0.03 * valueNoise1(time * 3, 9));
    lampFixture.object.rotation.z = 0.005 * Math.sin(time * 0.8);
    lampFixture.object.rotation.x = 0.0035 * Math.sin(time * 0.57 + 1.3);
    dust.time.value = time;
    const draft = valueNoise1(time * 0.25, 4);
    setDoors(0.08 + 0.06 * draft + 0.015 * Math.sin(time * 1.3), 0.12 + 0.05 * draft + 0.015 * Math.sin(time * 1.1 + 2));
  };

  const walkBounds = { minX: -HX + WALL_MARGIN, maxX: HX - WALL_MARGIN, minZ: -HZ + WALL_MARGIN, maxZ: HZ - WALL_MARGIN };
  const spawn = { x: HX - 1.2, z: 0, yaw: -PI / 2 };

  return { group, tableLight, lampFixture: lampFixture.object, colliders, spawn, walkBounds, update };
}

// ---------------------------------------------------------------------------
// Sub-builders
// ---------------------------------------------------------------------------

function createMoonBeamGeometry(): { geometry: THREE.BufferGeometry } {
  const z = -HZ + 0.01;
  const x0 = WINDOW.x - WINDOW.halfWidth;
  const x1 = WINDOW.x + WINDOW.halfWidth;
  const corners: [number, number][] = [
    [x0, WINDOW.bottom],
    [x1, WINDOW.bottom],
    [x1, WINDOW.top],
    [x0, WINDOW.top],
  ];
  const win = corners.map(([x, h]) => new THREE.Vector3(x, fy(h), z));
  const flr = corners.map(([x, h]) => new THREE.Vector3(x + MOON_DIR[0] * h, FLOOR_Y + 0.004, z + MOON_DIR[2] * h));
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvQuad: number[]): void => {
    const base = positions.length / 3;
    for (const v of [a, b, c, d]) positions.push(v.x, v.y, v.z);
    uvs.push(...uvQuad);
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const side = [0, 1, 0.5, 1, 0.5, 0, 0, 0];
  quad(win[0], win[1], flr[1], flr[0], side);
  quad(win[3], win[2], flr[2], flr[3], side);
  quad(win[0], win[3], flr[3], flr[0], side);
  quad(win[1], win[2], flr[2], flr[1], side);
  quad(flr[0], flr[1], flr[2], flr[3], [0.5, 0, 1, 0, 1, 1, 0.5, 1]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return { geometry };
}

function createDoorLeaves(material: THREE.Material): THREE.InstancedMesh {
  const leaf = new Batch(1, 1);
  const W = 0.76;
  leaf.add(at(box(0.035, 1.2, 0.07), 0, 0.6, 0.035));
  leaf.add(at(box(0.035, 1.2, 0.07), 0, 0.6, W - 0.035));
  for (const y of [0.045, 0.6, 1.155]) leaf.add(at(box(0.035, 0.09, W), 0, y, W / 2));
  leaf.add(at(box(0.02, 0.46, W - 0.12), 0, 0.325, W / 2));
  for (let i = 0; i < 6; i++) leaf.add(at(box(0.012, 0.06, W - 0.12).rotateZ(0.6), 0, 0.68 + i * 0.075, W / 2));
  const mesh = leaf.build(material, 'door-leaf');
  if (!mesh) throw new Error('Saloon: door leaf geometry missing');
  const doors = new THREE.InstancedMesh(mesh.geometry, material, 2);
  doors.name = 'saloon-doors';
  return doors;
}

function createHorn(side: number, segments: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(side * 0.09, 0.07, 0),
    new THREE.Vector3(side * 0.22, 0.09, 0.02),
    new THREE.Vector3(side * 0.34, 0.14, 0.05),
    new THREE.Vector3(side * 0.42, 0.25, 0.07),
    new THREE.Vector3(side * 0.44, 0.36, 0.08),
  ]);
  const radial = 8;
  const tube = new THREE.TubeGeometry(curve, segments, 0.034, radial, false);
  const pos = tube.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color('#cbb894');
  const tip = new THREE.Color('#2e241b');
  const center = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, center);
    const taper = 1 - 0.88 * t;
    tmpColor.copy(base).lerp(tip, Math.pow(t, 2.2));
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(center).multiplyScalar(taper).add(center);
      pos.setXYZ(idx, v.x, v.y, v.z);
      colors[idx * 3] = tmpColor.r;
      colors[idx * 3 + 1] = tmpColor.g;
      colors[idx * 3 + 2] = tmpColor.b;
    }
  }
  tube.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  tube.computeVertexNormals();
  return tube;
}

function createBottleGeometry(radial: number): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0, 0], [0.036, 0], [0.038, 0.01], [0.038, 0.18], [0.034, 0.205], [0.016, 0.235], [0.013, 0.28], [0.015, 0.285], [0.015, 0.3], [0, 0.3],
  ];
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), radial);
}

function createGlassGeometry(radial: number): THREE.BufferGeometry {
  const profile: [number, number][] = [
    [0, 0], [0.03, 0], [0.032, 0.006], [0.036, 0.09], [0.033, 0.09], [0.029, 0.014], [0, 0.014],
  ];
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), radial);
}

interface LampFixture {
  object: THREE.Group;
  flameMaterial: THREE.MeshBasicMaterial;
  flameColor: THREE.Color;
}

function createLampFixture(high: boolean, seg: number): LampFixture {
  const object = new THREE.Group();
  object.name = 'lamp-fixture';
  object.position.set(0, CEIL_Y, 0);
  const ly = (worldY: number): number => worldY - CEIL_Y;

  const lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.5, envMapIntensity: 0.6 });
  const metal = new Batch(1, 1, true);
  const inner = new Batch(1, 1, true);
  const bulbs = new Batch(1, 1, true);
  const ENAMEL = new THREE.Color('#1e3a2b');
  const BRASS = new THREE.Color('#9c7a44');
  const IRON = new THREE.Color('#2a2622');

  const linkR = high ? 0.011 : 0.014;
  const pitch = linkR * 2.1;
  const chainLen = CEIL_Y - LAMP_BAR_Y;
  for (const x of [-0.55, 0.55]) {
    metal.add(new THREE.CylinderGeometry(0.05, 0.08, 0.05, 12).translate(x, -0.025, 0), { color: IRON });
    const links = Math.floor(chainLen / pitch);
    for (let i = 0; i < links; i++) {
      const g = new THREE.TorusGeometry(linkR, linkR * 0.24, high ? 4 : 3, high ? 8 : 6).scale(1, 1.35, 1);
      if (i % 2 === 1) g.rotateY(PI / 2);
      metal.add(g.translate(x, -(i + 0.5) * pitch, 0), { color: IRON });
    }
  }
  metal.add(at(box(1.56, 0.032, 0.032), 0, ly(LAMP_BAR_Y), 0), { color: BRASS });
  for (const s of [-1, 1]) metal.add(new THREE.SphereGeometry(0.022, 10, 8).translate(s * 0.8, ly(LAMP_BAR_Y), 0), { color: BRASS });

  const shadeH = 0.21;
  const profile: [number, number][] = [
    [0.205, 0], [0.198, 0.012], [0.17, 0.045], [0.125, 0.1], [0.08, 0.16], [0.052, 0.195], [0.042, shadeH],
  ];
  const shadePoints = profile.map(([r, y]) => new THREE.Vector2(r, y));
  const innerPoints = profile.map(([r, y]) => new THREE.Vector2(r * 0.97, y));
  const innerTop = linear(1.5, 1.12, 0.72);
  const innerRim = linear(0.6, 0.42, 0.24);
  for (const x of SHADE_X) {
    const rimY = ly(LAMP_RIM_Y);
    metal.add(new THREE.LatheGeometry(shadePoints, seg + 4).translate(x, rimY, 0), { color: ENAMEL });
    inner.add(paintGradientY(new THREE.LatheGeometry(innerPoints, seg + 4).translate(x, rimY, 0), rimY, rimY + shadeH, innerRim, innerTop), { keepUV: true });
    metal.add(new THREE.TorusGeometry(0.205, 0.006, 4, seg + 4).rotateX(PI / 2).translate(x, rimY, 0), { color: BRASS });
    const rodTop = ly(LAMP_BAR_Y);
    const rodBottom = rimY + shadeH;
    metal.add(new THREE.CylinderGeometry(0.006, 0.006, rodTop - rodBottom, 6).translate(x, (rodTop + rodBottom) / 2, 0), { color: BRASS });
    metal.add(new THREE.CylinderGeometry(0.018, 0.022, 0.05, 10).translate(x, rimY + 0.17, 0), { color: BRASS });
    bulbs.add(new THREE.SphereGeometry(0.032, 12, 8).scale(1, 1.15, 1).translate(x, rimY + 0.105, 0));
  }

  const flameColor = linear(5, 3.3, 1.6);
  const flameMaterial = new THREE.MeshBasicMaterial({ color: flameColor.clone() });
  const innerMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  for (const mesh of [metal.build(lampMat, 'lamp-metal'), inner.build(innerMaterial, 'lamp-shade-inner'), bulbs.build(flameMaterial, 'lamp-bulbs')]) {
    if (!mesh) continue;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    object.add(mesh);
  }
  return { object, flameMaterial, flameColor };
}

// ---------------------------------------------------------------------------
// Environment map
// ---------------------------------------------------------------------------

const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

export function createEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const cached = envCache.get(renderer);
  if (cached) return cached;

  const scene = new THREE.Scene();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const add = (geometry: THREE.BufferGeometry, rgb: V3, side: THREE.Side = THREE.FrontSide): void => {
    const material = new THREE.MeshBasicMaterial({ color: linear(...rgb), side });
    geometries.push(geometry);
    materials.push(material);
    scene.add(new THREE.Mesh(geometry, material));
  };
  const facing = (w: number, h: number, pos: V3): THREE.BufferGeometry => {
    const g = new THREE.PlaneGeometry(w, h);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...pos), new THREE.Vector3(0, pos[1] * 0.5, 0), Y_AXIS);
    return g.applyMatrix4(new THREE.Matrix4().makeRotationY(PI)).applyMatrix4(m).translate(...pos);
  };

  add(new THREE.BoxGeometry(HX * 2, ROOM_H, HZ * 2).translate(0, fy(ROOM_H / 2), 0), [0.014, 0.009, 0.006], THREE.BackSide);
  add(new THREE.CircleGeometry(2.6, 32).rotateX(-PI / 2).translate(0, FLOOR_Y + 0.01, 0), [0.05, 0.03, 0.018]);
  add(new THREE.PlaneGeometry(2.4, 1.3).rotateX(-PI / 2).translate(0, -0.03, 0), [0.03, 0.09, 0.045]);
  for (const x of SHADE_X) add(new THREE.CircleGeometry(0.12, 24).rotateX(PI / 2).translate(x, LAMP_RIM_Y + 0.05, 0), [3.2, 2.1, 1.1]);
  add(new THREE.PlaneGeometry(1.7, 0.4).rotateX(PI / 2).translate(0, LAMP_RIM_Y + 0.2, 0), [0.06, 0.1, 0.07], THREE.DoubleSide);
  add(facing(0.16, 0.22, [-4.0, fy(2.05), HZ - 0.3]), [6, 3, 1.2]);
  add(facing(0.16, 0.22, [4.0, fy(2.05), -HZ + 0.3]), [6, 3, 1.2]);
  add(facing(0.3, 0.2, [-4.3, fy(1.2), 0]), [2.4, 1.3, 0.5]);
  add(new THREE.PlaneGeometry(WINDOW.halfWidth * 2, WINDOW.top - WINDOW.bottom).translate(WINDOW.x, fy((WINDOW.top + WINDOW.bottom) / 2), -HZ + 0.02), [0.14, 0.2, 0.46]);
  add(new THREE.PlaneGeometry(DOOR_HALF * 2, DOOR_H).rotateY(-PI / 2).translate(HX - 0.02, fy(DOOR_H / 2), 0), [0.02, 0.03, 0.06]);
  add(new THREE.PlaneGeometry(2.4, 1.3).rotateY(PI / 2).translate(-HX + 0.02, fy(1.66), 0), [0.12, 0.08, 0.05]);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.015, 0.01, 30);
  pmrem.dispose();
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
  target.texture.name = 'saloon-env';
  envCache.set(renderer, target.texture);
  return target.texture;
}
