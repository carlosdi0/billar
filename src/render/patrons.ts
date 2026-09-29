import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TABLE } from '../config';

export interface Patrons {
  group: THREE.Group;
  update(time: number, dt: number): void;
}

type Quality = 'low' | 'high';
type V3 = readonly [number, number, number];
type Updater = (time: number, dt: number) => void;

const FLOOR_Y = -TABLE.surfaceHeight;
const NO_GO_RADIUS = 3.2;
const WALK_MIN_RADIUS = NO_GO_RADIUS + 0.25;
const PI = Math.PI;
const TAU = PI * 2;

// ---------------------------------------------------------------------------
// Skeleton layout (metres, person faces +Z, left hand on +X)
// ---------------------------------------------------------------------------

const BONES = ['pelvis', 'spine', 'head', 'armL', 'foreL', 'armR', 'foreR', 'thighL', 'shinL', 'thighR', 'shinR'] as const;
type Bone = (typeof BONES)[number];
type MergeMap = Partial<Record<Bone, Bone>>;

const PARENT: Record<Bone, Bone | null> = {
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

const PIVOT: Record<Bone, V3> = {
  pelvis: [0, 0.95, 0],
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

interface Pose {
  pelvis: V3;
  rot: Partial<Record<Bone, V3>>;
}

const STAND_ARMS = {
  armL: [0.04, 0, 0.07],
  armR: [0.04, 0, -0.07],
  foreL: [-0.2, 0, 0],
  foreR: [-0.2, 0, 0],
} as const satisfies Partial<Record<Bone, V3>>;

const POSES = {
  stand: { pelvis: [0, 0.95, 0], rot: { ...STAND_ARMS } },
  carry: { pelvis: [0, 0.95, 0], rot: { ...STAND_ARMS, armR: [-0.05, 0.25, -0.12], foreR: [-1.35, 0, 0] } },
  stool: {
    pelvis: [0, 0.88, -0.02],
    rot: {
      spine: [0.14, 0, 0],
      thighL: [-1.2, 0, 0.13],
      thighR: [-1.2, 0, -0.13],
      shinL: [1.3, 0, 0],
      shinR: [1.3, 0, 0],
      armR: [-0.8, 0.25, 0],
      foreR: [-0.9, 0, 0],
      armL: [-0.7, -0.25, 0],
      foreL: [-0.95, 0, 0],
    },
  },
  chair: {
    pelvis: [0, 0.6, -0.06],
    rot: {
      spine: [0.1, 0, 0],
      thighL: [-1.5, 0, 0.08],
      thighR: [-1.5, 0, -0.08],
      shinL: [1.5, 0, 0],
      shinR: [1.5, 0, 0],
      armR: [-0.55, 0.2, 0],
      foreR: [-1.12, 0, 0],
      armL: [-0.3, -0.35, 0],
      foreL: [-1.55, 0, 0],
    },
  },
  piano: {
    pelvis: [0, 0.65, -0.04],
    rot: {
      spine: [0.12, 0, 0],
      thighL: [-1.45, 0, 0.1],
      thighR: [-1.45, 0, -0.1],
      shinL: [1.35, 0, 0],
      shinR: [1.35, 0, 0],
      armL: [-0.6, -0.3, -0.1],
      foreL: [-0.85, 0, 0],
      armR: [-0.6, 0.3, 0.1],
      foreR: [-0.85, 0, 0],
    },
  },
  bar: {
    pelvis: [0, 0.95, 0],
    rot: { spine: [0.06, 0, 0], armL: [-0.35, -0.35, -0.1], foreL: [-1.35, 0, 0], armR: [-0.45, 0.35, 0.1], foreR: [-1.3, 0, 0] },
  },
} satisfies Record<string, Pose>;
type PoseName = keyof typeof POSES;

// ---------------------------------------------------------------------------
// Looks: shared geometry per shape, colours from a palette atlas row
// ---------------------------------------------------------------------------

const SLOTS = ['skin', 'hat', 'band', 'shirt', 'vest', 'pants', 'boots', 'hair', 'accent', 'belt', 'metal', 'cloth', 'eye', 'lace'] as const;
type Slot = (typeof SLOTS)[number];
type Palette = Record<Slot, string>;
const PALETTE_W = 16;
const SLOT_U = Object.fromEntries(SLOTS.map((s, i) => [s, (i + 0.5) / PALETTE_W])) as Record<Slot, number>;

type Body = 'vest' | 'poncho' | 'dress' | 'barkeep';
type Hat = 'cowboy' | 'bowler' | 'lady' | 'none';
type Face = 'moustache' | 'handlebar' | 'beard' | 'lady';
type Sleeves = 'long' | 'rolled' | 'glove';
type HandItem = 'none' | 'cards' | 'rag';

interface Look {
  body: Body;
  hat: Hat;
  face: Face;
  sleeves: Sleeves;
  holster: boolean;
  palette: Partial<Palette>;
}

const BASE_PALETTE: Palette = {
  skin: '#a87a58',
  hat: '#4a382a',
  band: '#221811',
  shirt: '#b3a384',
  vest: '#3b2c22',
  pants: '#4a4c55',
  boots: '#34231a',
  hair: '#2a1e16',
  accent: '#7e2c20',
  belt: '#2c1e15',
  metal: '#a0844f',
  cloth: '#d2c9b4',
  eye: '#120c09',
  lace: '#ddd3bd',
};

const LOOKS = {
  drifter: { body: 'vest', hat: 'cowboy', face: 'moustache', sleeves: 'long', holster: true, palette: {} },
  gunslinger: {
    body: 'vest',
    hat: 'cowboy',
    face: 'handlebar',
    sleeves: 'long',
    holster: true,
    palette: { hat: '#221d1a', band: '#6b5a40', shirt: '#6a5844', vest: '#5a3a26', pants: '#6a5640', accent: '#3a4858', skin: '#9c6e4e' },
  },
  vaquero: {
    body: 'poncho',
    hat: 'cowboy',
    face: 'moustache',
    sleeves: 'long',
    holster: false,
    palette: { hat: '#7a6446', band: '#3a2a1c', vest: '#6a4a2e', accent: '#8e3a22', shirt: '#a8977a', pants: '#3c3834', skin: '#8e6246', hair: '#15100c' },
  },
  rancher: {
    body: 'vest',
    hat: 'cowboy',
    face: 'beard',
    sleeves: 'rolled',
    holster: false,
    palette: { hat: '#5a4a38', shirt: '#6e2a22', vest: '#2a2420', pants: '#5a5046', hair: '#4a3626', accent: '#b09a70' },
  },
  prospector: {
    body: 'vest',
    hat: 'cowboy',
    face: 'beard',
    sleeves: 'long',
    holster: false,
    palette: { hat: '#3a3028', shirt: '#56606a', vest: '#6a5638', pants: '#4e4232', hair: '#8a8278', accent: '#6b5a30' },
  },
  gambler: {
    body: 'vest',
    hat: 'cowboy',
    face: 'handlebar',
    sleeves: 'long',
    holster: true,
    palette: { hat: '#1c1a18', band: '#5a4a3a', shirt: '#cfc6ae', vest: '#1e1b1c', pants: '#2c2a2c', accent: '#5a1e22' },
  },
  barkeep: {
    body: 'barkeep',
    hat: 'none',
    face: 'handlebar',
    sleeves: 'rolled',
    holster: false,
    palette: { shirt: '#d0c8b4', vest: '#3a2a22', pants: '#3a3634', accent: '#171212', band: '#7a2a22', hair: '#22170f', cloth: '#d8d2c2' },
  },
  pianist: {
    body: 'vest',
    hat: 'bowler',
    face: 'moustache',
    sleeves: 'long',
    holster: false,
    palette: { hat: '#2a2622', shirt: '#bfb49a', vest: '#46383c', pants: '#34302e', accent: '#2a2226' },
  },
  lady: {
    body: 'dress',
    hat: 'lady',
    face: 'lady',
    sleeves: 'glove',
    holster: false,
    palette: {
      skin: '#c99c7c',
      vest: '#7a2432',
      pants: '#6a1e2a',
      lace: '#dcd0b8',
      hair: '#5a3220',
      accent: '#2a2030',
      belt: '#1c1418',
      boots: '#1c1412',
    },
  },
} satisfies Record<string, Look>;
type LookName = keyof typeof LOOKS;
const LOOK_NAMES = Object.keys(LOOKS) as LookName[];
const PALETTE_V = 1 - 0.5 / LOOK_NAMES.length;

function createPaletteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PALETTE_W;
  canvas.height = LOOK_NAMES.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  LOOK_NAMES.forEach((name, row) => {
    const palette: Palette = { ...BASE_PALETTE, ...LOOKS[name].palette };
    SLOTS.forEach((slot, col) => {
      ctx.fillStyle = palette[slot];
      ctx.fillRect(col, row, 1, 1);
    });
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.name = 'patron-palette';
  return texture;
}

// ---------------------------------------------------------------------------
// Low-poly part builders (all indexed, position/normal/uv)
// ---------------------------------------------------------------------------

interface Detail {
  radial: number;
  sw: number;
  sh: number;
  brim: number;
}

function paint(g: THREE.BufferGeometry, slot: Slot): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const count = g.getAttribute('position').count;
  const uv = new Float32Array(count * 2);
  const u = SLOT_U[slot];
  for (let i = 0; i < count; i++) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = PALETTE_V;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const cyl = (rt: number, rb: number, h: number, radial: number, y: number, slot: Slot): THREE.BufferGeometry =>
  paint(new THREE.CylinderGeometry(rt, rb, h, radial).translate(0, y, 0), slot);

const ball = (r: number, d: Detail, x: number, y: number, z: number, slot: Slot, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry =>
  paint(new THREE.SphereGeometry(r, d.sw, d.sh).scale(sx, sy, sz).translate(x, y, z), slot);

const cube = (w: number, h: number, depth: number, x: number, y: number, z: number, slot: Slot, rz = 0): THREE.BufferGeometry =>
  paint(new THREE.BoxGeometry(w, h, depth).rotateZ(rz).translate(x, y, z), slot);

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

function pinchCrown(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp((y - 0.06) / 0.07, 0, 1);
    pos.setX(i, pos.getX(i) * (1 - 0.14 * t));
    if (pos.getZ(i) > 0) pos.setY(i, y - 0.018 * t * (pos.getZ(i) / 0.1));
  }
  g.computeVertexNormals();
  return g;
}

function hatParts(hat: Hat, d: Detail): THREE.BufferGeometry[] {
  if (hat === 'cowboy') {
    const tilt = new THREE.Matrix4().makeRotationX(-0.12).setPosition(0, 0.205, 0);
    return [
      paint(curlBrim(new THREE.CylinderGeometry(0.2, 0.2, 0.012, d.brim), 0.2, 0.055, 1.12), 'hat'),
      pinchCrown(lathe([[0.102, 0], [0.104, 0.03], [0.094, 0.1], [0.072, 0.128], [0.035, 0.12], [0, 0.114]], d.brim, 'hat')),
      cyl(0.1035, 0.1055, 0.026, d.brim, 0.02, 'band'),
    ].map((g) => g.applyMatrix4(tilt));
  }
  if (hat === 'bowler') {
    return [
      paint(new THREE.SphereGeometry(0.1, d.brim, d.sh, 0, TAU, 0, PI / 2).scale(1, 0.95, 1.05).translate(0, 0.2, 0), 'hat'),
      paint(curlBrim(new THREE.CylinderGeometry(0.135, 0.135, 0.01, d.brim), 0.135, 0.03, 1.08).translate(0, 0.2, 0), 'hat'),
      cyl(0.101, 0.101, 0.02, d.brim, 0.212, 'band'),
    ];
  }
  if (hat === 'lady') {
    return [
      ball(0.107, d, 0, 0.15, -0.018, 'hair', 0.95, 1.02, 1),
      ball(0.06, d, 0, 0.22, -0.075, 'hair'),
      ball(0.042, d, 0.08, 0.1, -0.03, 'hair'),
      ball(0.042, d, -0.08, 0.1, -0.03, 'hair'),
      paint(new THREE.ConeGeometry(0.02, 0.2, 5).rotateZ(-0.45).translate(0.07, 0.31, -0.06), 'accent'),
      ball(0.026, d, 0.075, 0.22, -0.02, 'vest'),
    ];
  }
  return [ball(0.104, d, 0, 0.16, -0.025, 'hair', 0.93, 1.02, 1)];
}

function faceParts(face: Face, d: Detail): THREE.BufferGeometry[] {
  if (face === 'lady') return [cube(0.032, 0.01, 0.012, 0, 0.083, 0.094, 'vest')];
  const parts = [cube(0.045, 0.016, 0.02, 0.022, 0.087, 0.094, 'hair', -0.35), cube(0.045, 0.016, 0.02, -0.022, 0.087, 0.094, 'hair', 0.35)];
  if (face === 'handlebar') {
    parts.push(cube(0.03, 0.012, 0.016, 0.055, 0.094, 0.083, 'hair', 0.7), cube(0.03, 0.012, 0.016, -0.055, 0.094, 0.083, 'hair', -0.7));
  }
  if (face === 'beard') parts.push(ball(0.078, d, 0, 0.068, 0.03, 'hair', 1.02, 0.9, 1));
  return parts;
}

function headParts(look: Look, d: Detail): THREE.BufferGeometry[] {
  const parts = [
    ball(0.1, d, 0, 0.13, 0, 'skin', 0.9, 1.1, 1),
    cube(0.022, 0.04, 0.03, 0, 0.12, 0.1, 'skin'),
    cube(0.02, 0.045, 0.03, 0.09, 0.13, 0, 'skin'),
    cube(0.02, 0.045, 0.03, -0.09, 0.13, 0, 'skin'),
    cube(0.02, 0.012, 0.01, 0.034, 0.152, 0.093, 'eye'),
    cube(0.02, 0.012, 0.01, -0.034, 0.152, 0.093, 'eye'),
    cube(0.032, 0.009, 0.012, 0.034, 0.171, 0.09, 'hair'),
    cube(0.032, 0.009, 0.012, -0.034, 0.171, 0.09, 'hair'),
  ];
  if (look.hat === 'cowboy' || look.hat === 'bowler') parts.push(ball(0.1, d, 0, 0.14, -0.02, 'hair', 0.93, 1.02, 1));
  parts.push(...hatParts(look.hat, d), ...faceParts(look.face, d));
  return parts;
}

const TORSO_PROFILE = [[0, -0.03], [0.14, -0.03], [0.15, 0.08], [0.17, 0.22], [0.172, 0.31], [0.15, 0.39], [0.1, 0.44], [0, 0.45]] as const;
const TORSO_DEPTH = 0.62;

function torsoParts(body: Body, d: Detail): THREE.BufferGeometry[] {
  const neck = cyl(0.045, 0.05, 0.1, d.radial, 0.48, 'skin');
  if (body === 'dress') {
    return [
      lathe([[0, -0.03], [0.12, -0.03], [0.125, 0.06], [0.15, 0.2], [0.155, 0.27], [0.14, 0.33], [0, 0.33]], d.radial, 'vest', TORSO_DEPTH),
      lathe([[0.137, 0.33], [0.13, 0.38], [0.09, 0.44], [0, 0.45]], d.radial, 'skin', TORSO_DEPTH),
      ball(0.058, d, 0.052, 0.245, 0.068, 'vest', 1, 0.9, 0.8),
      ball(0.058, d, -0.052, 0.245, 0.068, 'vest', 1, 0.9, 0.8),
      paint(new THREE.TorusGeometry(0.138, 0.011, 4, d.radial * 2).rotateX(PI / 2).scale(1, 1, TORSO_DEPTH + 0.04).translate(0, 0.33, 0), 'lace'),
      paint(new THREE.CylinderGeometry(0.05, 0.05, 0.34, d.radial).rotateZ(PI / 2).translate(0, 0.395, 0), 'skin'),
      neck,
      cyl(0.05, 0.051, 0.02, d.radial, 0.47, 'accent'),
    ];
  }
  const parts = [
    lathe(TORSO_PROFILE, d.radial, body === 'poncho' ? 'shirt' : 'vest', TORSO_DEPTH),
    paint(new THREE.CylinderGeometry(0.055, 0.055, 0.36, d.radial).rotateZ(PI / 2).translate(0, 0.395, 0), 'shirt'),
    neck,
  ];
  if (body === 'poncho') {
    const sz = 0.78;
    parts.push(
      lathe([[0.065, 0.48], [0.2, 0.455], [0.29, 0.38], [0.305, 0.28]], d.radial + 2, 'vest', sz),
      lathe([[0.3, 0.28], [0.315, 0.235]], d.radial + 2, 'accent', sz),
      lathe([[0.315, 0.235], [0.33, 0.16], [0.335, 0.12]], d.radial + 2, 'vest', sz),
      lathe([[0.335, 0.12], [0.337, 0.1]], d.radial + 2, 'accent', sz),
    );
    return parts;
  }
  parts.push(cube(0.075, 0.34, 0.02, 0, 0.26, 0.1, 'shirt'));
  if (body === 'barkeep') {
    parts.push(cube(0.042, 0.03, 0.02, 0.022, 0.43, 0.075, 'accent', 0.2), cube(0.042, 0.03, 0.02, -0.022, 0.43, 0.075, 'accent', -0.2));
  } else {
    parts.push(
      paint(new THREE.ConeGeometry(0.075, 0.13, 4).rotateZ(PI).scale(1, 1, 0.45).translate(0, 0.39, 0.095), 'accent'),
      cyl(0.056, 0.06, 0.035, d.radial, 0.455, 'accent'),
    );
  }
  return parts;
}

function pelvisParts(look: Look, d: Detail): THREE.BufferGeometry[] {
  if (look.body === 'dress') {
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
  if (look.body === 'barkeep') parts.push(cube(0.33, 0.58, 0.012, 0, -0.22, 0.12, 'cloth'));
  return parts;
}

function upperArmParts(look: Look, d: Detail): THREE.BufferGeometry[] {
  if (look.body === 'dress') {
    return [ball(0.07, d, 0, -0.02, 0, 'vest'), cyl(0.042, 0.037, 0.3, d.radial, -0.15, 'skin')];
  }
  if (look.body === 'poncho') return [cyl(0.045, 0.043, 0.3, d.radial, -0.15, 'shirt')];
  const parts = [ball(0.06, d, 0, 0, 0, 'shirt'), cyl(0.052, 0.045, 0.3, d.radial, -0.15, 'shirt')];
  if (look.body === 'barkeep') parts.push(paint(new THREE.TorusGeometry(0.051, 0.008, 4, d.radial).rotateX(PI / 2).translate(0, -0.1, 0), 'band'));
  return parts;
}

function forearmParts(look: Look, item: HandItem, d: Detail): THREE.BufferGeometry[] {
  const sleeve: Slot = look.sleeves === 'long' ? 'shirt' : look.sleeves === 'glove' ? 'belt' : 'skin';
  const hand: Slot = look.sleeves === 'glove' ? 'belt' : 'skin';
  const slim = look.body === 'dress' ? 0.85 : 1;
  const parts = [
    ball(0.046 * slim, d, 0, 0, 0, look.sleeves === 'rolled' ? 'shirt' : sleeve),
    cyl(0.045 * slim, 0.037 * slim, 0.24, d.radial, -0.12, sleeve),
    cube(0.03, 0.085, 0.065, 0, -0.29, 0.005, hand),
    cube(0.02, 0.045, 0.022, 0, -0.262, 0.042, hand),
  ];
  if (look.sleeves === 'rolled') parts.push(cyl(0.053, 0.05, 0.05, d.radial, -0.025, 'shirt'));
  if (item === 'cards') {
    for (const a of [-0.3, 0, 0.3]) parts.push(cube(0.052, 0.074, 0.003, 0, -0.35, 0.04, 'lace', a).translate(0, 0, a * 0.004));
  }
  if (item === 'rag') parts.push(cube(0.035, 0.15, 0.1, 0, -0.34, 0, 'cloth', 0.2), cube(0.02, 0.09, 0.085, 0.015, -0.43, -0.01, 'cloth', -0.15));
  return parts;
}

function thighParts(d: Detail): THREE.BufferGeometry[] {
  return [ball(0.075, d, 0, 0, 0, 'pants'), cyl(0.074, 0.06, 0.42, d.radial, -0.21, 'pants')];
}

function shinParts(look: Look, d: Detail): THREE.BufferGeometry[] {
  const parts = [
    ball(0.058, d, 0, 0, 0, 'pants'),
    cyl(0.058, 0.05, 0.22, d.radial, -0.11, look.body === 'dress' ? 'eye' : 'pants'),
    cyl(0.063, 0.057, 0.24, d.radial, -0.3, 'boots'),
    cube(0.09, 0.07, 0.22, 0, -0.465, 0.045, 'boots'),
  ];
  if (look.body === 'vest' || look.body === 'poncho') {
    parts.push(paint(new THREE.TorusGeometry(0.02, 0.005, 4, 8).rotateY(PI / 2).translate(0, -0.455, -0.075), 'metal'));
  }
  return parts;
}

function boneParts(bone: Bone, look: Look, items: Record<'L' | 'R', HandItem>, d: Detail): THREE.BufferGeometry[] {
  switch (bone) {
    case 'pelvis':
      return pelvisParts(look, d);
    case 'spine':
      return torsoParts(look.body, d);
    case 'head':
      return headParts(look, d);
    case 'armL':
    case 'armR':
      return upperArmParts(look, d);
    case 'foreL':
      return forearmParts(look, items.L, d);
    case 'foreR':
      return forearmParts(look, items.R, d);
    case 'thighL':
    case 'thighR':
      return look.body === 'dress' ? [] : thighParts(d);
    case 'shinL':
    case 'shinR':
      return shinParts(look, d);
  }
}

function boneShapeKey(bone: Bone, look: Look, items: Record<'L' | 'R', HandItem>): string {
  switch (bone) {
    case 'pelvis':
      return `pelvis:${look.body}:${look.holster}`;
    case 'spine':
      return `spine:${look.body}`;
    case 'head':
      return `head:${look.hat}:${look.face}`;
    case 'armL':
    case 'armR':
      return `arm:${look.body}`;
    case 'foreL':
      return `fore:${look.body}:${look.sleeves}:${items.L}`;
    case 'foreR':
      return `fore:${look.body}:${look.sleeves}:${items.R}`;
    case 'thighL':
    case 'thighR':
      return `thigh:${look.body}`;
    case 'shinL':
    case 'shinR':
      return `shin:${look.body}`;
  }
}

// ---------------------------------------------------------------------------
// Props (glassware, own glossy material with vertex colours)
// ---------------------------------------------------------------------------

type PropKind = 'mug' | 'whisky' | 'glass';

function tint(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  const c = new THREE.Color(hex);
  const count = g.getAttribute('position').count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) c.toArray(data, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(data, 3));
  return g;
}

function createPropGeometry(kind: PropKind, radial: number): THREE.BufferGeometry {
  let parts: THREE.BufferGeometry[];
  if (kind === 'mug') {
    parts = [
      tint(new THREE.CylinderGeometry(0.04, 0.038, 0.13, radial), '#9a5812'),
      tint(new THREE.CylinderGeometry(0.041, 0.041, 0.016, radial).translate(0, -0.058, 0), '#c49048'),
      tint(new THREE.CylinderGeometry(0.0415, 0.0405, 0.026, radial).translate(0, 0.072, 0), '#efe6d2'),
      tint(new THREE.SphereGeometry(0.041, radial, 3, 0, TAU, 0, PI / 2).scale(1, 0.35, 1).translate(0, 0.085, 0), '#f4ecdc'),
      tint(new THREE.TorusGeometry(0.032, 0.009, 5, 8, PI).rotateZ(PI / 2).translate(-0.04, 0, 0), '#b8802e'),
    ];
  } else if (kind === 'whisky') {
    parts = [
      tint(new THREE.CylinderGeometry(0.031, 0.03, 0.036, radial).translate(0, -0.024, 0), '#8a4a12'),
      tint(new THREE.CylinderGeometry(0.034, 0.031, 0.05, radial).translate(0, 0.019, 0), '#8f9a98'),
    ];
  } else {
    parts = [tint(new THREE.CylinderGeometry(0.034, 0.03, 0.085, radial), '#a6b0ae')];
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error(`Patrons: failed to build prop "${kind}"`);
  return merged;
}

// ---------------------------------------------------------------------------
// Rig assembly
// ---------------------------------------------------------------------------

interface Rig {
  root: THREE.Group;
  /** Animation handles; merged (frozen) bones point to detached dummies. */
  j: Record<Bone, THREE.Object3D>;
  pelvisY: number;
}

interface PropSpec {
  hand: 'L' | 'R';
  kind: PropKind;
}

interface PersonSpec {
  look: LookName;
  pose: PoseName;
  merge: MergeMap;
  items?: Partial<Record<'L' | 'R', HandItem>>;
  props?: PropSpec[];
  x: number;
  z: number;
  heading: number;
  scale?: number;
}

interface BuildContext {
  detail: Detail;
  palette: THREE.Texture;
  geometries: Map<string, THREE.BufferGeometry | null>;
  materials: Map<LookName, THREE.MeshStandardMaterial>;
  propMaterial: THREE.MeshStandardMaterial;
  props: Map<PropKind, THREE.BufferGeometry>;
}

function lookMaterial(ctx: BuildContext, name: LookName): THREE.MeshStandardMaterial {
  const cached = ctx.materials.get(name);
  if (cached) return cached;
  const map = ctx.palette.clone();
  map.offset.set(0, -LOOK_NAMES.indexOf(name) / LOOK_NAMES.length);
  map.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.86, metalness: 0, envMapIntensity: 0.35 });
  material.name = `patron-${name}`;
  ctx.materials.set(name, material);
  return material;
}

function resolveTarget(bone: Bone, merge: MergeMap): Bone {
  let b = bone;
  for (let next = merge[b]; next; next = merge[b]) b = next;
  return b;
}

function finishMesh(mesh: THREE.Mesh): THREE.Mesh {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.updateMatrix();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

function buildPerson(ctx: BuildContext, spec: PersonSpec): Rig {
  const look: Look = LOOKS[spec.look];
  const pose: Pose = POSES[spec.pose];
  const items = { L: spec.items?.L ?? 'none', R: spec.items?.R ?? 'none' };
  const root = new THREE.Group();
  root.name = `patron-${spec.look}`;
  const bones = {} as Record<Bone, THREE.Group>;
  for (const b of BONES) {
    const g = new THREE.Group();
    g.name = b;
    const p = b === 'pelvis' ? pose.pelvis : PIVOT[b];
    g.position.set(p[0], p[1], p[2]);
    const r = pose.rot[b];
    if (r) g.rotation.set(r[0], r[1], r[2]);
    bones[b] = g;
    const parent = PARENT[b];
    (parent ? bones[parent] : root).add(g);
  }
  root.updateMatrixWorld(true);

  const groups = new Map<Bone, Bone[]>();
  for (const b of BONES) {
    const target = resolveTarget(b, spec.merge);
    const list = groups.get(target);
    if (list) list.push(b);
    else groups.set(target, [b]);
  }

  const material = lookMaterial(ctx, spec.look);
  const inverse = new THREE.Matrix4();
  const relative = new THREE.Matrix4();
  for (const [target, list] of groups) {
    const key =
      list.length === 1
        ? boneShapeKey(target, look, items)
        : `${spec.pose}|${target}|${list.map((b) => `${b}=${boneShapeKey(b, look, items)}`).join(',')}`;
    let geometry = ctx.geometries.get(key);
    if (geometry === undefined) {
      inverse.copy(bones[target].matrixWorld).invert();
      const parts: THREE.BufferGeometry[] = [];
      for (const b of list) {
        relative.multiplyMatrices(inverse, bones[b].matrixWorld);
        for (const part of boneParts(b, look, items, ctx.detail)) parts.push(b === target ? part : part.applyMatrix4(relative));
      }
      geometry = parts.length > 0 ? mergeGeometries(parts, false) : null;
      for (const p of parts) p.dispose();
      geometry?.computeBoundingSphere();
      ctx.geometries.set(key, geometry);
    }
    if (geometry) bones[target].add(finishMesh(new THREE.Mesh(geometry, material)));
  }

  for (const prop of spec.props ?? []) {
    const geometry = ctx.props.get(prop.kind);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, ctx.propMaterial);
    const medial = prop.hand === 'R' ? 1 : -1;
    mesh.position.set(medial * (prop.kind === 'mug' ? 0.06 : 0.045), -0.3, 0);
    mesh.rotation.set(PI / 2, prop.hand === 'R' ? 0 : PI, 0);
    bones[prop.hand === 'R' ? 'foreR' : 'foreL'].add(finishMesh(mesh));
  }

  const j = { ...bones } as Record<Bone, THREE.Object3D>;
  for (const b of BONES) if (spec.merge[b]) j[b] = new THREE.Object3D();

  root.position.set(spec.x, FLOOR_Y, spec.z);
  root.rotation.y = spec.heading;
  root.scale.setScalar(spec.scale ?? 1);
  return { root, j, pelvisY: pose.pelvis[1] };
}

const WALK_MERGE_HIGH: MergeMap = { spine: 'pelvis' };
const WALK_MERGE_LOW: MergeMap = { spine: 'pelvis', foreL: 'armL', foreR: 'armR', shinL: 'thighL', shinR: 'thighR' };
const SEATED_MERGE_HIGH: MergeMap = { thighL: 'pelvis', shinL: 'thighL', thighR: 'pelvis', shinR: 'thighR' };

function seatedMerge(high: boolean, keepElbow: 'L' | 'R' | 'both'): MergeMap {
  if (high) return SEATED_MERGE_HIGH;
  const merge: MergeMap = { ...SEATED_MERGE_HIGH, spine: 'pelvis' };
  if (keepElbow === 'R') merge.foreL = 'armL';
  if (keepElbow === 'L') merge.foreR = 'armR';
  return merge;
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const mix = (a: number, b: number, w: number): number => a + (b - a) * w;
const damp = (current: number, target: number, rate: number, dt: number): number => current + (target - current) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number): number => a - TAU * Math.floor((a + PI) / TAU);

function envelope(t: number, rise: number, hold: number, fall: number): number {
  if (t <= 0) return 0;
  if (t < rise) return smooth01(t / rise);
  t -= rise;
  if (t < hold) return 1;
  t -= hold;
  return t < fall ? 1 - smooth01(t / fall) : 0;
}

function setMix(o: THREE.Object3D, a: V3, b: V3, w: number, dx = 0, dy = 0, dz = 0): void {
  o.rotation.set(mix(a[0], b[0], w) + dx, mix(a[1], b[1], w) + dy, mix(a[2], b[2], w) + dz);
}

/** A recurring action with random gaps; `elapsed` is the time since it last started. */
class Episode {
  private start = -Infinity;
  private next: number;

  constructor(
    private readonly rand: () => number,
    private readonly length: number,
    private readonly gapMin: number,
    private readonly gapMax: number,
    firstDelay: number,
  ) {
    this.next = firstDelay;
  }

  elapsed(time: number, allowed = true): number {
    if (allowed && time >= this.next && time - this.start > this.length) {
      this.start = time;
      this.next = time + this.length + this.gapMin + this.rand() * (this.gapMax - this.gapMin);
    }
    return time - this.start;
  }
}

class Gaze {
  yaw = 0;
  pitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private next = 0;

  constructor(
    private readonly rand: () => number,
    private readonly yawRange: number,
    private readonly pitchRange: number,
    private readonly gapMin = 1.5,
    private readonly gapMax = 5,
  ) {}

  update(time: number, dt: number, focus = 0): void {
    if (time >= this.next) {
      const straight = this.rand() < 0.35;
      this.targetYaw = straight ? 0 : (this.rand() * 2 - 1) * this.yawRange;
      this.targetPitch = (this.rand() * 2 - 1) * this.pitchRange;
      this.next = time + this.gapMin + this.rand() * (this.gapMax - this.gapMin);
    }
    this.yaw = damp(this.yaw, this.targetYaw * (1 - focus), 3.5, dt);
    this.pitch = damp(this.pitch, this.targetPitch * (1 - focus), 3, dt);
  }
}

// ---------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------

interface ArmPose {
  arm: V3;
  fore: V3;
}

interface DrinkerConfig {
  cupHand: 'L' | 'R';
  cupRest: ArmPose;
  cupDrink: ArmPose;
  freeRest: ArmPose;
  freeGesture: ArmPose;
  wave: number;
  lean: number;
  gazeRange: number;
  gestureNod: number;
}

function drinker(rig: Rig, rand: () => number, cfg: DrinkerConfig): Updater {
  const { j } = rig;
  const cupArm = cfg.cupHand === 'R' ? j.armR : j.armL;
  const cupFore = cfg.cupHand === 'R' ? j.foreR : j.foreL;
  const freeArm = cfg.cupHand === 'R' ? j.armL : j.armR;
  const freeFore = cfg.cupHand === 'R' ? j.foreL : j.foreR;
  const side = cfg.cupHand === 'R' ? 1 : -1;
  const drink = new Episode(rand, 3.3, 4 + rand() * 3, 10 + rand() * 6, 1 + rand() * 6);
  const gesture = new Episode(rand, 3.1, 2.5, 8, 2 + rand() * 5);
  const gaze = new Gaze(rand, cfg.gazeRange, 0.12);
  const phase = rand() * TAU;
  const breath = 1.2 + rand() * 0.5;
  const waveRate = 5.5 + rand() * 3;
  return (time, dt) => {
    const w = envelope(drink.elapsed(time), 0.9, 1.5, 0.9);
    const g = envelope(gesture.elapsed(time, w === 0), 0.6, 1.8, 0.7);
    const sip = w * 0.06 * Math.sin(time * 5 + phase);
    setMix(cupArm, cfg.cupRest.arm, cfg.cupDrink.arm, w);
    setMix(cupFore, cfg.cupRest.fore, cfg.cupDrink.fore, w, sip);
    const wave = g * Math.sin(time * waveRate + phase);
    setMix(freeArm, cfg.freeRest.arm, cfg.freeGesture.arm, g, 0, 0, -side * 0.08 * wave);
    setMix(freeFore, cfg.freeRest.fore, cfg.freeGesture.fore, g, cfg.wave * wave);
    j.spine.rotation.set(cfg.lean + 0.012 * Math.sin(time * breath + phase) + 0.04 * g - 0.05 * w, 0.08 * g * side, 0);
    gaze.update(time, dt, w);
    j.head.rotation.set(gaze.pitch - 0.3 * w + cfg.gestureNod * g, gaze.yaw - side * 0.15 * g, 0.04 * Math.sin(time * 0.6 + phase));
  };
}

function barkeep(rig: Rig, rand: () => number): Updater {
  const { j } = rig;
  const inspect = new Episode(rand, 4.2, 5, 11, 4);
  const gaze = new Gaze(rand, 0.9, 0.08, 2, 5);
  const glassRest: ArmPose = { arm: POSES.bar.rot.armL, fore: POSES.bar.rot.foreL };
  const glassUp: ArmPose = { arm: [-1.05, -0.3, -0.15], fore: [-1.2, 0, 0] };
  const ragRest: ArmPose = { arm: POSES.bar.rot.armR, fore: POSES.bar.rot.foreR };
  const ragDown: ArmPose = { arm: [0.05, 0.1, -0.1], fore: [-0.5, 0, 0] };
  return (time, dt) => {
    const w = envelope(inspect.elapsed(time), 0.8, 2.4, 0.9);
    const wipe = 1 - w;
    const a = time * 6.4;
    setMix(j.armL, glassRest.arm, glassUp.arm, w);
    setMix(j.foreL, glassRest.fore, glassUp.fore, w, 0, 0.3 * Math.sin(time * 1.3) * wipe);
    setMix(j.armR, ragRest.arm, ragDown.arm, w, 0.09 * Math.sin(a) * wipe, 0, 0.08 * Math.cos(a) * wipe);
    setMix(j.foreR, ragRest.fore, ragDown.fore, w, 0.12 * Math.sin(a + 1.1) * wipe);
    j.spine.rotation.set(0.06 + 0.015 * Math.sin(a) * wipe, 0.04 * Math.sin(time * 0.4), 0);
    gaze.update(time, dt, w);
    j.head.rotation.set(0.28 * wipe * (1 - Math.min(1, Math.abs(gaze.yaw))) - 0.25 * w, gaze.yaw + 0.2 * w, 0);
  };
}

function pianist(rig: Rig, rand: () => number): Updater {
  const { j } = rig;
  const look = new Episode(rand, 3.5, 6, 12, 5);
  const gaze = new Gaze(rand, 0.25, 0.08, 1.5, 3);
  const beat = TAU * (1.6 + rand() * 0.3);
  const armL = POSES.piano.rot.armL;
  const armR = POSES.piano.rot.armR;
  const fore = POSES.piano.rot.foreL;
  return (time, dt) => {
    const b = time * beat;
    const phraseL = Math.sin(time * 0.37) + 0.5 * Math.sin(time * 0.91);
    const phraseR = Math.sin(time * 0.29 + 2) + 0.5 * Math.sin(time * 1.13);
    j.armL.rotation.set(armL[0] + 0.04 * Math.sin(b), armL[1], armL[2] + 0.07 * phraseL);
    j.armR.rotation.set(armR[0] + 0.04 * Math.sin(b + 1.7), armR[1], armR[2] + 0.07 * phraseR);
    j.foreL.rotation.set(fore[0] - 0.1 * Math.max(0, Math.sin(b * 2)), 0, 0);
    j.foreR.rotation.set(fore[0] - 0.1 * Math.max(0, Math.sin(b * 2 + 2.1)) - 0.05 * Math.max(0, Math.sin(b * 3)), 0, 0);
    j.spine.rotation.set(0.12 + 0.025 * Math.sin(b * 0.5), 0.05 * Math.sin(b * 0.25), 0.035 * Math.sin(b * 0.25 + 1));
    const turn = envelope(look.elapsed(time), 0.7, 2, 0.8);
    gaze.update(time, dt, turn);
    j.head.rotation.set(0.12 + 0.05 * Math.sin(b) + gaze.pitch - 0.12 * turn, gaze.yaw + 1.0 * turn, 0.04 * Math.sin(b * 0.5));
  };
}

interface Waypoint {
  x: number;
  z: number;
  stop?: { chance: number; min: number; max: number; face: number; sway?: boolean };
}

interface WalkerConfig {
  route: readonly Waypoint[];
  speed: number;
  armSwing: number;
  carry: boolean;
  drinks: boolean;
  start: number;
}

const TURN_RATE = 2.6;
const STRIDE = 1.35;
const ARRIVE = 0.14;

function walker(rig: Rig, rand: () => number, cfg: WalkerConfig): Updater {
  const { j, root } = rig;
  const route = cfg.route;
  let index = Math.min(cfg.start, route.length - 1);
  let dir = index === route.length - 1 ? -1 : 1;
  let x = route[index].x;
  let z = route[index].z;
  index += dir;
  let heading = Math.atan2(route[index].x - x, route[index].z - z);
  let speed = 0;
  let phase = rand() * TAU;
  let gait = 0;
  let stopTime = 0;
  let stopFace = 0;
  let sway = false;
  const gaze = new Gaze(rand, 0.7, 0.1);
  const drink = new Episode(rand, 3.3, 3, 7, 2 + rand() * 3);
  const idlePhase = rand() * TAU;
  const baseSpeed = cfg.speed;
  const carryArm = POSES.carry.rot.armR;
  const carryFore = POSES.carry.rot.foreR;
  const drinkArm: V3 = [-0.75, 0.55, 0.15];
  const drinkFore: V3 = [-2.25, 0, 0];

  const advance = (): void => {
    if (index + dir < 0 || index + dir >= route.length) dir = -dir;
    index += dir;
  };

  const arrive = (wp: Waypoint): void => {
    const stop = wp.stop;
    if (stop && rand() < stop.chance) {
      stopTime = stop.min + rand() * (stop.max - stop.min);
      stopFace = stop.face;
      sway = stop.sway ?? false;
    }
    advance();
  };

  return (time, dt) => {
    let targetSpeed = 0;
    let desired = heading;
    if (stopTime > 0) {
      stopTime -= dt;
      desired = stopFace;
    } else {
      const wp = route[index];
      const dx = wp.x - x;
      const dz = wp.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist < ARRIVE) {
        arrive(wp);
      } else {
        desired = Math.atan2(dx, dz);
        const align = Math.max(0, Math.cos(wrapAngle(desired - heading)));
        targetSpeed = baseSpeed * align * align * Math.min(1, 0.45 + dist);
      }
    }
    const diff = wrapAngle(desired - heading);
    const maxTurn = TURN_RATE * dt;
    const turn = diff > maxTurn ? maxTurn : diff < -maxTurn ? -maxTurn : diff;
    heading = wrapAngle(heading + turn);
    speed = damp(speed, targetSpeed, 5, dt);
    x += Math.sin(heading) * speed * dt;
    z += Math.cos(heading) * speed * dt;
    const r = Math.hypot(x, z);
    if (r < WALK_MIN_RADIUS && r > 1e-6) {
      x *= WALK_MIN_RADIUS / r;
      z *= WALK_MIN_RADIUS / r;
    }
    root.position.x = x;
    root.position.z = z;
    root.rotation.y = heading;

    const turning = dt > 0 ? Math.min(1, Math.abs(turn) / maxTurn) : 0;
    phase += (speed / STRIDE) * TAU * dt + Math.abs(turn) * 1.2;
    gait = damp(gait, Math.max(speed / baseSpeed, 0.35 * turning), 6, dt);

    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const legA = 0.45 * gait;
    const kneeL = Math.max(0, c);
    const kneeR = Math.max(0, -c);
    j.thighL.rotation.set(-legA * s, 0, 0.02);
    j.thighR.rotation.set(legA * s, 0, -0.02);
    j.shinL.rotation.set(gait * (0.1 + 0.8 * kneeL * kneeL), 0, 0);
    j.shinR.rotation.set(gait * (0.1 + 0.8 * kneeR * kneeR), 0, 0);

    const idle = 1 - gait;
    const shift = Math.sin(time * 0.55 + idlePhase);
    j.pelvis.position.y = rig.pelvisY - 0.012 * gait + 0.022 * gait * Math.cos(2 * phase);
    const dance = sway && stopTime > 0 ? Math.sin(time * 2.4) : 0;
    j.pelvis.rotation.set(0.03 * gait, 0.09 * gait * s + 0.12 * dance, 0.025 * gait * c + 0.03 * idle * shift + 0.04 * dance);

    const armA = cfg.armSwing * gait;
    j.armL.rotation.set(armA * s, 0, 0.07 + 0.02 * idle);
    j.foreL.rotation.set(-0.22 - 0.25 * gait * Math.max(0, -s), 0, 0);
    const d = cfg.drinks ? envelope(drink.elapsed(time, stopTime > 3.5), 0.9, 1.4, 0.9) : 0;
    if (cfg.carry) {
      setMix(j.armR, carryArm, drinkArm, d, -0.08 * armA * s);
      setMix(j.foreR, carryFore, drinkFore, d);
    } else {
      j.armR.rotation.set(-armA * s, 0, -0.07 - 0.02 * idle);
      j.foreR.rotation.set(-0.22 - 0.25 * gait * Math.max(0, s), 0, 0);
    }

    gaze.update(time, dt, Math.max(gait * 0.6, d));
    j.head.rotation.set(gaze.pitch - 0.03 * gait * c - 0.3 * d, gaze.yaw - 0.09 * gait * s, 0.05 * dance);
  };
}

// ---------------------------------------------------------------------------
// Cast: seat positions mirror saloon.ts (bar stools, piano, poker chairs)
// ---------------------------------------------------------------------------

const HZ = 4.4;
const STOOL_X = -3.55;
const PIANO = { x: -2.2, z: HZ - 0.85 };
const BARKEEP = { x: -4.73, z: 0.35 };

// Chair transforms depend on the saloon's seeded RNG, which consumes a
// different number of values per quality level.
const CHAIRS = {
  high: { gambler: [4.6239, 3.2852, -1.8998], vaquero: [3.7687, -3.8287, -0.0231] },
  low: { gambler: [4.6946, 3.3082, -1.7738], vaquero: [3.7691, -3.8265, 0.2514] },
} as const;

const ROUTE_FRONT: readonly Waypoint[] = [
  { x: -3.2, z: -3.45, stop: { chance: 0.85, min: 3, max: 6, face: -1.0 } },
  { x: -1.5, z: -3.72, stop: { chance: 0.5, min: 2.5, max: 5, face: PI } },
  { x: 0.4, z: -3.62 },
  { x: 2.0, z: -3.78, stop: { chance: 0.7, min: 3, max: 7, face: PI } },
  { x: 2.5, z: -3.5, stop: { chance: 0.4, min: 2, max: 4, face: 1.23 } },
];

const ROUTE_BACK: readonly Waypoint[] = [
  { x: -1.3, z: 3.3, stop: { chance: 0.85, min: 4, max: 8, face: -1.3, sway: true } },
  { x: 0.2, z: 3.72, stop: { chance: 0.4, min: 2, max: 4, face: 0 } },
  { x: 1.0, z: 3.75, stop: { chance: 0.4, min: 2, max: 4, face: 0 } },
  { x: 2.25, z: 3.35, stop: { chance: 0.7, min: 3, max: 6, face: 1.75 } },
];

const ROUTE_DOOR: readonly Waypoint[] = [
  { x: 3.55, z: 1.7, stop: { chance: 0.6, min: 3, max: 6, face: 0.25 } },
  { x: 3.95, z: 0.95 },
  { x: 4.85, z: 0.25, stop: { chance: 0.7, min: 3, max: 6, face: PI / 2 } },
  { x: 3.75, z: -0.9 },
  { x: 3.35, z: -1.55, stop: { chance: 0.6, min: 3, max: 6, face: 2.78 } },
];

const STOOL_DRINKER: Omit<DrinkerConfig, 'lean'> = {
  cupHand: 'R',
  cupRest: { arm: POSES.stool.rot.armR, fore: POSES.stool.rot.foreR },
  cupDrink: { arm: [-0.9, 0.6, 0.2], fore: [-2.3, 0, 0] },
  freeRest: { arm: POSES.stool.rot.armL, fore: POSES.stool.rot.foreL },
  freeGesture: { arm: [-0.55, -0.1, 0.35], fore: [-1.9, 0, 0] },
  wave: 0.25,
  gazeRange: 0.9,
  gestureNod: 0,
};

const CARD_PLAYER: Omit<DrinkerConfig, 'lean'> = {
  cupHand: 'R',
  cupRest: { arm: POSES.chair.rot.armR, fore: POSES.chair.rot.foreR },
  cupDrink: { arm: [-0.8, 0.6, 0.2], fore: [-2.3, 0, 0] },
  freeRest: { arm: POSES.chair.rot.armL, fore: POSES.chair.rot.foreL },
  freeGesture: { arm: [-0.55, -0.45, -0.05], fore: [-1.75, 0, 0] },
  wave: 0.04,
  gazeRange: 0.7,
  gestureNod: 0.3,
};

export function createPatrons(opts: { quality: Quality }): Patrons {
  const high = opts.quality === 'high';
  const group = new THREE.Group();
  group.name = 'patrons';
  const rand = makeRng(1879);

  const detail: Detail = high ? { radial: 9, sw: 10, sh: 7, brim: 16 } : { radial: 6, sw: 7, sh: 5, brim: 10 };
  const propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0, envMapIntensity: 1.3 });
  propMaterial.name = 'patron-glassware';
  const ctx: BuildContext = {
    detail,
    palette: createPaletteTexture(),
    geometries: new Map(),
    materials: new Map(),
    propMaterial,
    props: new Map((['mug', 'whisky', 'glass'] as const).map((k) => [k, createPropGeometry(k, high ? 10 : 7)])),
  };

  const updaters: Updater[] = [];
  const add = (spec: PersonSpec, behave: (rig: Rig) => Updater): void => {
    const rig = buildPerson(ctx, spec);
    group.add(rig.root);
    updaters.push(behave(rig));
  };

  const chairs = high ? CHAIRS.high : CHAIRS.low;
  const walkMerge = high ? WALK_MERGE_HIGH : WALK_MERGE_LOW;

  add(
    {
      look: 'barkeep',
      pose: 'bar',
      merge: high ? SEATED_MERGE_HIGH : { ...SEATED_MERGE_HIGH, spine: 'pelvis', foreL: 'armL', foreR: 'armR' },
      items: { R: 'rag' },
      props: [{ hand: 'L', kind: 'glass' }],
      x: BARKEEP.x,
      z: BARKEEP.z,
      heading: PI / 2,
    },
    (rig) => barkeep(rig, rand),
  );
  add(
    { look: 'rancher', pose: 'stool', merge: seatedMerge(high, 'R'), props: [{ hand: 'R', kind: 'mug' }], x: STOOL_X, z: -1.1, heading: -PI / 2 + 0.5 },
    (rig) => drinker(rig, rand, { ...STOOL_DRINKER, lean: 0.14 }),
  );
  add(
    {
      look: 'prospector',
      pose: 'stool',
      merge: seatedMerge(high, 'R'),
      props: [{ hand: 'R', kind: 'whisky' }],
      x: STOOL_X,
      z: 2.2,
      heading: -PI / 2 - 0.5,
    },
    (rig) => drinker(rig, rand, { ...STOOL_DRINKER, lean: 0.18 }),
  );
  add(
    {
      look: 'vaquero',
      pose: 'chair',
      merge: seatedMerge(high, 'R'),
      items: { L: 'cards' },
      props: [{ hand: 'R', kind: 'whisky' }],
      x: chairs.vaquero[0],
      z: chairs.vaquero[1],
      heading: chairs.vaquero[2],
    },
    (rig) => drinker(rig, rand, { ...CARD_PLAYER, lean: 0.1 }),
  );
  add(
    { look: 'drifter', pose: 'carry', merge: walkMerge, props: [{ hand: 'R', kind: 'mug' }], x: 0, z: 0, heading: 0, scale: 1.02 },
    (rig) => walker(rig, rand, { route: ROUTE_FRONT, speed: 0.95, armSwing: 0.38, carry: true, drinks: high, start: 1 }),
  );

  if (high) {
    add(
      { look: 'pianist', pose: 'piano', merge: SEATED_MERGE_HIGH, x: PIANO.x, z: PIANO.z, heading: 0 },
      (rig) => pianist(rig, rand),
    );
    add(
      {
        look: 'gambler',
        pose: 'chair',
        merge: SEATED_MERGE_HIGH,
        items: { L: 'cards' },
        props: [{ hand: 'R', kind: 'whisky' }],
        x: chairs.gambler[0],
        z: chairs.gambler[1],
        heading: chairs.gambler[2],
      },
      (rig) => drinker(rig, rand, { ...CARD_PLAYER, lean: 0.06, gazeRange: 0.5 }),
    );
    add(
      { look: 'lady', pose: 'stand', merge: walkMerge, x: 0, z: 0, heading: 0, scale: 0.95 },
      (rig) => walker(rig, rand, { route: ROUTE_BACK, speed: 0.72, armSwing: 0.2, carry: false, drinks: false, start: 2 }),
    );
    add(
      { look: 'gunslinger', pose: 'stand', merge: walkMerge, x: 0, z: 0, heading: 0, scale: 1.04 },
      (rig) => walker(rig, rand, { route: ROUTE_DOOR, speed: 1.05, armSwing: 0.42, carry: false, drinks: false, start: 2 }),
    );
  }

  const update = (time: number, dt: number): void => {
    const step = Math.min(Math.max(dt, 0), 0.1);
    for (const u of updaters) u(time, step);
  };
  update(0, 0);

  return { group, update };
}
