import * as THREE from 'three';
import { TABLE } from '../config';
import {
  createCharacter,
  createHandProp,
  type Character,
  type CharacterHand,
  type CharacterLook,
  type CharacterPose,
  type HandPropKind,
  type PoseDriver,
} from './character';

export interface PatronCollider {
  x: number;
  z: number;
  r: number;
}

export interface Patrons {
  group: THREE.Group;
  update(time: number, dt: number): void;
  /** Current footprint of every patron; the array and its objects are reused between calls. */
  colliders(): PatronCollider[];
  setPlayerPosition(x: number, z: number): void;
}

type Quality = 'low' | 'high';
type V3 = readonly [number, number, number];
type Updater = (time: number, dt: number) => void;

const FLOOR_Y = -TABLE.surfaceHeight;
const NO_GO_RADIUS = 3.2;
const WALK_MIN_RADIUS = NO_GO_RADIUS + 0.25;
const ROOM_HALF = { x: 5.5 - 0.4, z: 4.4 - 0.4 } as const;
const PATRON_RADIUS = 0.3;
const PI = Math.PI;
const TAU = PI * 2;

const SEAT = { stool: 0.76, chair: 0.48, piano: 0.53 } as const;

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

const LOOKS = {
  drifter: { skin: '#a87a58', shirt: '#b3a384', vest: '#3b2c22', pants: '#4a4c55', hat: 'cowboy', hatColor: '#4a382a', mustache: true, holster: true },
  gunslinger: {
    skin: '#9c6e4e',
    shirt: '#6a5844',
    vest: '#5a3a26',
    pants: '#6a5640',
    hat: 'cowboy',
    hatColor: '#221d1a',
    bandana: '#3a4858',
    handlebar: true,
    mustache: true,
    holster: true,
  },
  vaquero: {
    skin: '#8e6246',
    shirt: '#a8977a',
    vest: '#6a4a2e',
    pants: '#3c3834',
    hat: 'cowboy',
    hatColor: '#7a6446',
    bandana: '#8e3a22',
    poncho: true,
    mustache: true,
    hair: '#15100c',
  },
  rancher: { skin: '#a87a58', shirt: '#6e2a22', vest: '#2a2420', pants: '#5a5046', hat: 'cowboy', hatColor: '#5a4a38', beard: true, sleeves: 'rolled', hair: '#4a3626' },
  prospector: { skin: '#a87a58', shirt: '#56606a', vest: '#6a5638', pants: '#4e4232', hat: 'cowboy', hatColor: '#3a3028', beard: true, hair: '#8a8278' },
  gambler: { skin: '#a87a58', shirt: '#cfc6ae', vest: '#1e1b1c', pants: '#2c2a2c', hat: 'cowboy', hatColor: '#1c1a18', handlebar: true, mustache: true, holster: true, hair: '#1a1410' },
  barkeep: { skin: '#a87a58', shirt: '#d0c8b4', vest: '#3a2a22', pants: '#3a3634', hat: 'none', hatColor: '#3a2a22', bandana: '#7a2a22', apron: true, handlebar: true, mustache: true, hair: '#22170f' },
  pianist: { skin: '#a87a58', shirt: '#bfb49a', vest: '#46383c', pants: '#34302e', hat: 'bowler', hatColor: '#2a2622', mustache: true },
  lady: { skin: '#c99c7c', shirt: '#dcd0b8', vest: '#7a2432', pants: '#6a1e2a', hat: 'none', hatColor: '#2a2030', bandana: '#2a2030', dress: true, hair: '#5a3220', boots: '#1c1412' },
} satisfies Record<string, CharacterLook>;
type LookName = keyof typeof LOOKS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const damp = (current: number, target: number, rate: number, dt: number): number => current + (target - current) * (1 - Math.exp(-rate * dt));
const wrapAngle = (a: number): number => a - TAU * Math.floor((a + PI) / TAU);
const clamp = THREE.MathUtils.clamp;

function envelope(t: number, rise: number, hold: number, fall: number): number {
  if (t <= 0) return 0;
  if (t < rise) return smooth01(t / rise);
  t -= rise;
  if (t < hold) return 1;
  t -= hold;
  return t < fall ? 1 - smooth01(t / fall) : 0;
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

  update(time: number, dt: number, focus = 0, forcedYaw: number | null = null): void {
    if (time >= this.next) {
      const straight = this.rand() < 0.35;
      this.targetYaw = straight ? 0 : (this.rand() * 2 - 1) * this.yawRange;
      this.targetPitch = (this.rand() * 2 - 1) * this.pitchRange;
      this.next = time + this.gapMin + this.rand() * (this.gapMax - this.gapMin);
    }
    const yaw = forcedYaw ?? this.targetYaw * (1 - focus);
    const pitch = forcedYaw === null ? this.targetPitch * (1 - focus) : 0;
    this.yaw = damp(this.yaw, yaw, 3.5, dt);
    this.pitch = damp(this.pitch, pitch, 3, dt);
  }
}

/** Shared player position; far away until the game reports one. */
interface PlayerRef {
  x: number;
  z: number;
}

/** Yaw of the player relative to a body at (x, z) facing `heading`, if close enough to notice. */
function noticePlayer(player: PlayerRef, x: number, z: number, heading: number, range: number, maxYaw: number): number | null {
  const dx = player.x - x;
  const dz = player.z - z;
  if (dx * dx + dz * dz > range * range) return null;
  const rel = wrapAngle(Math.atan2(dx, dz) - heading);
  return Math.abs(rel) > maxYaw + 0.6 ? null : clamp(rel, -maxYaw, maxYaw);
}

// ---------------------------------------------------------------------------
// Behaviours (pose drivers layered on top of the character's base action)
// ---------------------------------------------------------------------------

interface ArmPose {
  arm: V3;
  fore: V3;
}

interface DrinkerConfig {
  cupHand: CharacterHand;
  cupRest: ArmPose;
  cupDrink: ArmPose;
  freeRest: ArmPose;
  freeGesture: ArmPose;
  wave: number;
  lean: number;
  gazeRange: number;
  gestureNod: number;
}

interface Seat {
  x: number;
  z: number;
  heading: number;
}

function drinker(rand: () => number, cfg: DrinkerConfig, player: PlayerRef, seat: Seat): PoseDriver {
  const cupArm = cfg.cupHand === 'R' ? 'armR' : 'armL';
  const cupFore = cfg.cupHand === 'R' ? 'foreR' : 'foreL';
  const freeArm = cfg.cupHand === 'R' ? 'armL' : 'armR';
  const freeFore = cfg.cupHand === 'R' ? 'foreL' : 'foreR';
  const side = cfg.cupHand === 'R' ? 1 : -1;
  const drink = new Episode(rand, 3.3, 4 + rand() * 3, 10 + rand() * 6, 1 + rand() * 6);
  const gesture = new Episode(rand, 3.1, 2.5, 8, 2 + rand() * 5);
  const gaze = new Gaze(rand, cfg.gazeRange, 0.12);
  const phase = rand() * TAU;
  const breath = 1.2 + rand() * 0.5;
  const waveRate = 5.5 + rand() * 3;
  return (pose, time, dt) => {
    const w = envelope(drink.elapsed(time), 0.9, 1.5, 0.9);
    const g = envelope(gesture.elapsed(time, w === 0), 0.6, 1.8, 0.7);
    const sip = w * 0.06 * Math.sin(time * 5 + phase);
    pose.mix(cupArm, cfg.cupRest.arm, cfg.cupDrink.arm, w);
    pose.mix(cupFore, cfg.cupRest.fore, cfg.cupDrink.fore, w, sip);
    const wave = g * Math.sin(time * waveRate + phase);
    pose.mix(freeArm, cfg.freeRest.arm, cfg.freeGesture.arm, g, 0, 0, -side * 0.08 * wave);
    pose.mix(freeFore, cfg.freeRest.fore, cfg.freeGesture.fore, g, cfg.wave * wave);
    pose.set('spine', cfg.lean + 0.012 * Math.sin(time * breath + phase) + 0.04 * g - 0.05 * w, 0.08 * g * side, 0);
    gaze.update(time, dt, w, w === 0 ? noticePlayer(player, seat.x, seat.z, seat.heading, 2.2, 0.9) : null);
    pose.set('head', gaze.pitch - 0.3 * w + cfg.gestureNod * g, gaze.yaw - side * 0.15 * g, 0.04 * Math.sin(time * 0.6 + phase));
  };
}

const BAR_ARMS = { armL: [-0.35, -0.35, -0.1], foreL: [-1.35, 0, 0], armR: [-0.45, 0.35, 0.1], foreR: [-1.3, 0, 0] } as const;

function barkeep(rand: () => number, player: PlayerRef, seat: Seat): PoseDriver {
  const inspect = new Episode(rand, 4.2, 5, 11, 4);
  const gaze = new Gaze(rand, 0.9, 0.08, 2, 5);
  const glassRest: ArmPose = { arm: BAR_ARMS.armL, fore: BAR_ARMS.foreL };
  const glassUp: ArmPose = { arm: [-1.05, -0.3, -0.15], fore: [-1.2, 0, 0] };
  const ragRest: ArmPose = { arm: BAR_ARMS.armR, fore: BAR_ARMS.foreR };
  const ragDown: ArmPose = { arm: [0.05, 0.1, -0.1], fore: [-0.5, 0, 0] };
  return (pose, time, dt) => {
    const w = envelope(inspect.elapsed(time), 0.8, 2.4, 0.9);
    const wipe = 1 - w;
    const a = time * 6.4;
    pose.mix('armL', glassRest.arm, glassUp.arm, w);
    pose.mix('foreL', glassRest.fore, glassUp.fore, w, 0, 0.3 * Math.sin(time * 1.3) * wipe);
    pose.mix('armR', ragRest.arm, ragDown.arm, w, 0.09 * Math.sin(a) * wipe, 0, 0.08 * Math.cos(a) * wipe);
    pose.mix('foreR', ragRest.fore, ragDown.fore, w, 0.12 * Math.sin(a + 1.1) * wipe);
    pose.set('spine', 0.06 + 0.015 * Math.sin(a) * wipe, 0.04 * Math.sin(time * 0.4), 0);
    const notice = noticePlayer(player, seat.x, seat.z, seat.heading, 2.6, 1.0);
    gaze.update(time, dt, w, notice);
    const down = notice === null ? 0.28 * wipe * (1 - Math.min(1, Math.abs(gaze.yaw))) : 0;
    pose.set('head', down - 0.25 * w, gaze.yaw + 0.2 * w, 0);
  };
}

const PIANO_ARMS = { armL: [-0.6, -0.3, -0.1], armR: [-0.6, 0.3, 0.1], fore: [-0.85, 0, 0] } as const;

function pianist(rand: () => number): PoseDriver {
  const look = new Episode(rand, 3.5, 6, 12, 5);
  const gaze = new Gaze(rand, 0.25, 0.08, 1.5, 3);
  const beat = TAU * (1.6 + rand() * 0.3);
  const { armL, armR, fore } = PIANO_ARMS;
  return (pose, time, dt) => {
    const b = time * beat;
    const phraseL = Math.sin(time * 0.37) + 0.5 * Math.sin(time * 0.91);
    const phraseR = Math.sin(time * 0.29 + 2) + 0.5 * Math.sin(time * 1.13);
    pose.set('armL', armL[0] + 0.04 * Math.sin(b), armL[1], armL[2] + 0.07 * phraseL);
    pose.set('armR', armR[0] + 0.04 * Math.sin(b + 1.7), armR[1], armR[2] + 0.07 * phraseR);
    pose.set('foreL', fore[0] - 0.1 * Math.max(0, Math.sin(b * 2)), 0, 0);
    pose.set('foreR', fore[0] - 0.1 * Math.max(0, Math.sin(b * 2 + 2.1)) - 0.05 * Math.max(0, Math.sin(b * 3)), 0, 0);
    pose.set('spine', 0.12 + 0.025 * Math.sin(b * 0.5), 0.05 * Math.sin(b * 0.25), 0.035 * Math.sin(b * 0.25 + 1));
    const turn = envelope(look.elapsed(time), 0.7, 2, 0.8);
    gaze.update(time, dt, turn);
    pose.set('head', 0.12 + 0.05 * Math.sin(b) + gaze.pitch - 0.12 * turn, gaze.yaw + 1.0 * turn, 0.04 * Math.sin(b * 0.5));
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
  carry: boolean;
  drinks: boolean;
  start: number;
}

const TURN_RATE = 2.6;
const ARRIVE = 0.14;
const WALK_ON = 0.12;
const WALK_OFF = 0.05;
const YIELD_STOP = 0.95;
const YIELD_CLOSE = 0.6;
const YIELD_RESUME = 1.2;
const YIELD_STEER = 2.0;
const YIELD_PATIENCE = 3.5;
const CARRY: ArmPose = { arm: [-0.05, 0.25, -0.12], fore: [-1.35, 0, 0] };
const CARRY_SIP: ArmPose = { arm: [-0.75, 0.55, 0.15], fore: [-2.25, 0, 0] };

function walker(ch: Character, rand: () => number, cfg: WalkerConfig, player: PlayerRef): Updater {
  const root = ch.object;
  const route = cfg.route;
  let index = Math.min(cfg.start, route.length - 1);
  let dir = index === route.length - 1 ? -1 : 1;
  let x = route[index].x;
  let z = route[index].z;
  index += dir;
  let heading = Math.atan2(route[index].x - x, route[index].z - z);
  let speed = 0;
  let stopTime = 0;
  let stopFace = 0;
  let sway = false;
  let yielding = false;
  let yieldTime = 0;
  let drinkWeight = 0;
  let noticeYaw: number | null = null;
  const gaze = new Gaze(rand, 0.7, 0.1);
  const drink = new Episode(rand, 3.3, 3, 7, 2 + rand() * 3);
  const baseSpeed = cfg.speed;

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

  const driver: PoseDriver = (pose: CharacterPose, time: number, dt: number) => {
    const gait = Math.min(1, speed / baseSpeed);
    if (cfg.carry) {
      const swing = pose.get('armR', 0);
      pose.mix('armR', CARRY.arm, CARRY_SIP.arm, drinkWeight, 0.15 * swing);
      pose.mix('foreR', CARRY.fore, CARRY_SIP.fore, drinkWeight);
    }
    const dance = sway && stopTime > 0 ? Math.sin(time * 2.4) : 0;
    pose.add('pelvis', 0, 0.12 * dance, 0.04 * dance);
    gaze.update(time, dt, Math.max(gait * 0.6, drinkWeight), drinkWeight > 0 ? null : noticeYaw);
    pose.add('head', gaze.pitch - 0.3 * drinkWeight, gaze.yaw, 0.05 * dance);
  };
  ch.setPoseDriver(driver);

  return (time, dt) => {
    const pdx = player.x - x;
    const pdz = player.z - z;
    const pd = Math.hypot(pdx, pdz);
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const ahead = pd > 1e-6 ? (pdx * fx + pdz * fz) / pd : 0;
    if (yielding) yielding = pd < YIELD_RESUME && (ahead > 0 || pd < YIELD_CLOSE);
    else yielding = pd < YIELD_CLOSE || (pd < YIELD_STOP && ahead > 0.5);
    yieldTime = yielding && stopTime <= 0 ? yieldTime + dt : 0;
    if (yieldTime > YIELD_PATIENCE && pd > YIELD_CLOSE) {
      dir = -dir;
      advance();
      yielding = false;
      yieldTime = 0;
    }

    let targetSpeed = 0;
    let desired = heading;
    if (stopTime > 0) {
      stopTime -= dt;
      desired = stopFace;
    } else if (!yielding) {
      const wp = route[index];
      let dx = wp.x - x;
      let dz = wp.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist < ARRIVE) {
        arrive(wp);
      } else {
        dx /= dist;
        dz /= dist;
        if (pd < YIELD_STEER && pdx * dx + pdz * dz > 0) {
          const push = (1 - pd / YIELD_STEER) * 1.3;
          const k = (dz * pdx - dx * pdz > 0 ? -1 : 1) * push;
          const px = dz * k;
          const pz = -dx * k;
          dx += px;
          dz += pz;
        }
        desired = Math.atan2(dx, dz);
        const align = Math.max(0, Math.cos(wrapAngle(desired - heading)));
        targetSpeed = baseSpeed * align * align * Math.min(1, 0.45 + dist);
      }
    }
    const diff = wrapAngle(desired - heading);
    const maxTurn = TURN_RATE * dt;
    heading = wrapAngle(heading + clamp(diff, -maxTurn, maxTurn));
    speed = damp(speed, targetSpeed, 5, dt);
    x += Math.sin(heading) * speed * dt;
    z += Math.cos(heading) * speed * dt;
    const r = Math.hypot(x, z);
    if (r < WALK_MIN_RADIUS && r > 1e-6) {
      x *= WALK_MIN_RADIUS / r;
      z *= WALK_MIN_RADIUS / r;
    }
    x = clamp(x, -ROOM_HALF.x, ROOM_HALF.x);
    z = clamp(z, -ROOM_HALF.z, ROOM_HALF.z);
    root.position.x = x;
    root.position.z = z;
    root.rotation.y = heading;

    if (ch.action === 'walk' ? speed < WALK_OFF : speed > WALK_ON) ch.setAction(ch.action === 'walk' ? 'idle' : 'walk');
    ch.setSpeed(speed);
    drinkWeight = cfg.drinks ? envelope(drink.elapsed(time, stopTime > 3.5), 0.9, 1.4, 0.9) : 0;
    noticeYaw = noticePlayer(player, x, z, heading, yielding ? 3 : 2, 1.1);
    ch.update(dt, time);
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

const STOOL_ARMS = { armR: [-0.8, 0.25, 0], foreR: [-0.9, 0, 0], armL: [-0.7, -0.25, 0], foreL: [-0.95, 0, 0] } as const;
const CHAIR_ARMS = { armR: [-0.55, 0.2, 0], foreR: [-1.12, 0, 0], armL: [-0.3, -0.35, 0], foreL: [-1.55, 0, 0] } as const;

const STOOL_DRINKER: Omit<DrinkerConfig, 'lean'> = {
  cupHand: 'R',
  cupRest: { arm: STOOL_ARMS.armR, fore: STOOL_ARMS.foreR },
  cupDrink: { arm: [-0.9, 0.6, 0.2], fore: [-2.3, 0, 0] },
  freeRest: { arm: STOOL_ARMS.armL, fore: STOOL_ARMS.foreL },
  freeGesture: { arm: [-0.55, -0.1, 0.35], fore: [-1.9, 0, 0] },
  wave: 0.25,
  gazeRange: 0.9,
  gestureNod: 0,
};

const CARD_PLAYER: Omit<DrinkerConfig, 'lean'> = {
  cupHand: 'R',
  cupRest: { arm: CHAIR_ARMS.armR, fore: CHAIR_ARMS.foreR },
  cupDrink: { arm: [-0.8, 0.6, 0.2], fore: [-2.3, 0, 0] },
  freeRest: { arm: CHAIR_ARMS.armL, fore: CHAIR_ARMS.foreL },
  freeGesture: { arm: [-0.55, -0.45, -0.05], fore: [-1.75, 0, 0] },
  wave: 0.04,
  gazeRange: 0.7,
  gestureNod: 0.3,
};

interface PatronSpec {
  look: LookName;
  x: number;
  z: number;
  heading: number;
  seat?: number;
  props?: Partial<Record<CharacterHand, HandPropKind>>;
  scale?: number;
}

export function createPatrons(opts: { quality: Quality }): Patrons {
  const quality = opts.quality;
  const high = quality === 'high';
  const group = new THREE.Group();
  group.name = 'patrons';
  const rand = makeRng(1879);
  const player: PlayerRef = { x: 1e6, z: 1e6 };

  const cast: Character[] = [];
  const updaters: Updater[] = [];

  const spawn = (spec: PatronSpec): Character => {
    const ch = createCharacter(LOOKS[spec.look], { quality, scale: spec.scale, seed: rand() * TAU });
    ch.object.name = `patron-${spec.look}`;
    ch.object.position.set(spec.x, FLOOR_Y, spec.z);
    ch.object.rotation.y = spec.heading;
    if (spec.seat !== undefined) {
      ch.setSeatHeight(spec.seat);
      ch.setAction('sit', true);
    }
    for (const hand of ['L', 'R'] as const) {
      const kind = spec.props?.[hand];
      if (kind) ch.hand(hand).add(createHandProp(kind, quality));
    }
    group.add(ch.object);
    cast.push(ch);
    return ch;
  };

  const settle = (spec: PatronSpec, driver: PoseDriver): void => {
    const ch = spawn(spec);
    ch.setPoseDriver(driver);
    updaters.push((time, dt) => ch.update(dt, time));
  };

  const chairs = high ? CHAIRS.high : CHAIRS.low;
  const seatOf = (x: number, z: number, heading: number): Seat => ({ x, z, heading });

  settle({ look: 'barkeep', x: BARKEEP.x, z: BARKEEP.z, heading: PI / 2, props: { L: 'glass', R: 'rag' } }, barkeep(rand, player, seatOf(BARKEEP.x, BARKEEP.z, PI / 2)));
  const stoolA = seatOf(STOOL_X, -1.1, -PI / 2 + 0.5);
  settle({ look: 'rancher', ...stoolA, seat: SEAT.stool, props: { R: 'mug' } }, drinker(rand, { ...STOOL_DRINKER, lean: 0.14 }, player, stoolA));
  const stoolB = seatOf(STOOL_X, 2.2, -PI / 2 - 0.5);
  settle({ look: 'prospector', ...stoolB, seat: SEAT.stool, props: { R: 'whisky' } }, drinker(rand, { ...STOOL_DRINKER, lean: 0.18 }, player, stoolB));
  const chairV = seatOf(chairs.vaquero[0], chairs.vaquero[1], chairs.vaquero[2]);
  settle({ look: 'vaquero', ...chairV, seat: SEAT.chair, props: { L: 'cards', R: 'whisky' } }, drinker(rand, { ...CARD_PLAYER, lean: 0.1 }, player, chairV));
  const drifter = spawn({ look: 'drifter', x: 0, z: 0, heading: 0, props: { R: 'mug' }, scale: 1.02 });
  updaters.push(walker(drifter, rand, { route: ROUTE_FRONT, speed: 0.95, carry: true, drinks: high, start: 1 }, player));

  if (high) {
    settle({ look: 'pianist', x: PIANO.x, z: PIANO.z, heading: 0, seat: SEAT.piano }, pianist(rand));
    const chairG = seatOf(chairs.gambler[0], chairs.gambler[1], chairs.gambler[2]);
    settle({ look: 'gambler', ...chairG, seat: SEAT.chair, props: { L: 'cards', R: 'whisky' } }, drinker(rand, { ...CARD_PLAYER, lean: 0.06, gazeRange: 0.5 }, player, chairG));
    const lady = spawn({ look: 'lady', x: 0, z: 0, heading: 0, scale: 0.95 });
    updaters.push(walker(lady, rand, { route: ROUTE_BACK, speed: 0.72, carry: false, drinks: false, start: 2 }, player));
    const gunslinger = spawn({ look: 'gunslinger', x: 0, z: 0, heading: 0, scale: 1.04 });
    updaters.push(walker(gunslinger, rand, { route: ROUTE_DOOR, speed: 1.05, carry: false, drinks: false, start: 2 }, player));
  }

  const colliderList: PatronCollider[] = cast.map(() => ({ x: 0, z: 0, r: PATRON_RADIUS }));
  const colliders = (): PatronCollider[] => {
    for (let i = 0; i < cast.length; i++) {
      colliderList[i].x = cast[i].object.position.x;
      colliderList[i].z = cast[i].object.position.z;
    }
    return colliderList;
  };

  const update = (time: number, dt: number): void => {
    const step = Math.min(Math.max(dt, 0), 0.1);
    for (const u of updaters) u(time, step);
  };
  update(0, 0);

  return {
    group,
    update,
    colliders,
    setPlayerPosition(x: number, z: number): void {
      player.x = x;
      player.z = z;
    },
  };
}
