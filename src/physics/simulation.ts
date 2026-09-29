import { BALL_RADIUS as R, HALF_L, HALF_W, PHYSICS, SHOT } from '../config';
import { buildTableGeometry, type Pocket, type Segment } from './tableGeometry';

export interface Ball {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
  /** Orientation quaternion (x, y, z, w) for rendering. */
  q: [number, number, number, number];
  onTable: boolean;
  moving: boolean;
}

export type SimEvent =
  | { type: 'ballBall'; a: number; b: number; speed: number; x: number; z: number }
  | { type: 'cushion'; ball: number; speed: number; x: number; z: number }
  | { type: 'pocket'; ball: number; pocket: number; speed: number };

const G = PHYSICS.gravity;
const CUSHION_CONTACT_SIN = 0.27;
const SLIP_EPS = 1e-4;
const MAX_SHOT_TIME = 45;

export class Simulation {
  readonly balls: Ball[] = [];
  readonly segments: Segment[];
  readonly pockets: Pocket[];
  private accumulator = 0;
  private elapsed = 0;

  constructor() {
    const geometry = buildTableGeometry();
    this.segments = geometry.segments;
    this.pockets = geometry.pockets;
    for (let id = 0; id < 16; id++) {
      this.balls.push({
        id,
        x: 0,
        z: 0,
        vx: 0,
        vz: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        q: [0, 0, 0, 1],
        onTable: false,
        moving: false,
      });
    }
  }

  place(id: number, x: number, z: number): void {
    const b = this.balls[id];
    b.x = x;
    b.z = z;
    b.vx = b.vz = b.wx = b.wy = b.wz = 0;
    b.onTable = true;
    b.moving = false;
  }

  remove(id: number): void {
    const b = this.balls[id];
    b.onTable = false;
    b.moving = false;
    b.vx = b.vz = b.wx = b.wy = b.wz = 0;
  }

  /**
   * Strike a ball with the cue.
   * @param tipSide horizontal tip offset in ball radii (+ = right english)
   * @param tipVertical vertical tip offset in ball radii (+ = follow, - = draw)
   */
  strike(id: number, dirX: number, dirZ: number, speed: number, tipSide: number, tipVertical: number): void {
    const b = this.balls[id];
    const len = Math.hypot(dirX, dirZ) || 1;
    const dx = dirX / len;
    const dz = dirZ / len;
    const offset = Math.hypot(tipSide, tipVertical);
    const scale = offset > SHOT.maxTipOffset ? SHOT.maxTipOffset / offset : 1;
    const side = tipSide * scale;
    const vertical = tipVertical * scale;

    b.vx = dx * speed;
    b.vz = dz * speed;
    const spin = (5 * speed) / (2 * R);
    b.wx = dz * spin * vertical;
    b.wz = -dx * spin * vertical;
    b.wy = spin * side;
    b.moving = true;
    this.elapsed = 0;
    this.accumulator = 0;
  }

  isSettled(): boolean {
    return this.balls.every((b) => !b.onTable || !b.moving);
  }

  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    if (this.isSettled()) return events;

    this.accumulator += dt;
    const h = PHYSICS.substep;
    while (this.accumulator >= h) {
      this.accumulator -= h;
      this.substep(h, events);
    }

    this.elapsed += dt;
    if (this.elapsed > MAX_SHOT_TIME) this.freeze();
    return events;
  }

  private freeze(): void {
    for (const b of this.balls) {
      b.vx = b.vz = b.wx = b.wy = b.wz = 0;
      b.moving = false;
    }
  }

  private substep(h: number, events: SimEvent[]): void {
    for (const b of this.balls) {
      if (b.onTable && b.moving) this.integrate(b, h);
    }
    this.collideBalls(events);
    for (const b of this.balls) {
      if (!b.onTable || !b.moving) continue;
      this.collideCushions(b, events);
      this.checkPocket(b, events);
    }
  }

  private integrate(b: Ball, h: number): void {
    const ux = b.vx + R * b.wz;
    const uz = b.vz - R * b.wx;
    const slip = Math.hypot(ux, uz);

    if (slip > SLIP_EPS) {
      const decel = PHYSICS.slidingFriction * G;
      const timeToRoll = slip / (3.5 * decel);
      const t = Math.min(h, timeToRoll);
      const fx = (-ux / slip) * decel * t;
      const fz = (-uz / slip) * decel * t;
      b.vx += fx;
      b.vz += fz;
      b.wx -= (fz * 2.5) / R;
      b.wz += (fx * 2.5) / R;
      if (t >= timeToRoll) this.snapToRolling(b);
    } else {
      const speed = Math.hypot(b.vx, b.vz);
      const decel = PHYSICS.rollingFriction * G * h;
      if (speed <= decel) {
        b.vx = b.vz = 0;
      } else {
        const k = (speed - decel) / speed;
        b.vx *= k;
        b.vz *= k;
      }
      this.snapToRolling(b);
    }

    const spinDecel = ((5 * PHYSICS.spinFriction * G) / (2 * R)) * h;
    b.wy = Math.abs(b.wy) <= spinDecel ? 0 : b.wy - Math.sign(b.wy) * spinDecel;

    b.x += b.vx * h;
    b.z += b.vz * h;
    this.integrateOrientation(b, h);

    const speed = Math.hypot(b.vx, b.vz);
    const angular = Math.hypot(b.wx, b.wy, b.wz);
    if (speed < PHYSICS.linearSleep && angular * R < PHYSICS.linearSleep && Math.abs(b.wy) < PHYSICS.angularSleep) {
      b.vx = b.vz = b.wx = b.wy = b.wz = 0;
      b.moving = false;
    }
  }

  private snapToRolling(b: Ball): void {
    b.wx = b.vz / R;
    b.wz = -b.vx / R;
  }

  private integrateOrientation(b: Ball, h: number): void {
    const [qx, qy, qz, qw] = b.q;
    const hx = 0.5 * h * b.wx;
    const hy = 0.5 * h * b.wy;
    const hz = 0.5 * h * b.wz;
    const nx = qx + hx * qw + hy * qz - hz * qy;
    const ny = qy - hx * qz + hy * qw + hz * qx;
    const nz = qz + hx * qy - hy * qx + hz * qw;
    const nw = qw - hx * qx - hy * qy - hz * qz;
    const len = Math.hypot(nx, ny, nz, nw);
    b.q[0] = nx / len;
    b.q[1] = ny / len;
    b.q[2] = nz / len;
    b.q[3] = nw / len;
  }

  private collideBalls(events: SimEvent[]): void {
    const minDist = 2 * R;
    const minDist2 = minDist * minDist;
    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (!a.onTable) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (!b.onTable || (!a.moving && !b.moving)) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minDist2 || d2 === 0) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const overlap = (minDist - d) / 2;
        a.x -= nx * overlap;
        a.z -= nz * overlap;
        b.x += nx * overlap;
        b.z += nz * overlap;

        const approach = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (approach <= 0) continue;

        const jn = ((1 + PHYSICS.ballRestitution) / 2) * approach;
        a.vx -= jn * nx;
        a.vz -= jn * nz;
        b.vx += jn * nx;
        b.vz += jn * nz;

        const tx = -nz;
        const tz = nx;
        const slip = (a.vx - b.vx) * tx + (a.vz - b.vz) * tz - R * a.wy - R * b.wy;
        const limit = PHYSICS.ballFriction * jn;
        const jt = Math.max(-limit, Math.min(limit, slip / 7));
        a.vx -= jt * tx;
        a.vz -= jt * tz;
        b.vx += jt * tx;
        b.vz += jt * tz;
        a.wy += (2.5 * jt) / R;
        b.wy += (2.5 * jt) / R;

        a.moving = b.moving = true;
        events.push({ type: 'ballBall', a: a.id, b: b.id, speed: approach, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
    }
  }

  private collideCushions(b: Ball, events: SimEvent[]): void {
    if (Math.abs(b.x) < HALF_L - 2 * R && Math.abs(b.z) < HALF_W - 2 * R) return;

    for (const seg of this.segments) {
      const ex = seg.b.x - seg.a.x;
      const ez = seg.b.z - seg.a.z;
      const len2 = ex * ex + ez * ez;
      const t = Math.max(0, Math.min(1, ((b.x - seg.a.x) * ex + (b.z - seg.a.z) * ez) / len2));
      const cx = seg.a.x + ex * t;
      const cz = seg.a.z + ez * t;
      const dx = b.x - cx;
      const dz = b.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 === 0) continue;

      const d = Math.sqrt(d2);
      const nx = dx / d;
      const nz = dz / d;
      b.x = cx + nx * R;
      b.z = cz + nz * R;

      const vn = b.vx * nx + b.vz * nz;
      if (vn >= 0) continue;

      const jn = -(1 + PHYSICS.cushionRestitution) * vn;
      const tx = nz;
      const tz = -nx;
      const slip = b.vx * tx + b.vz * tz - R * b.wy;
      const limit = PHYSICS.cushionFriction * jn;
      const jt = Math.max(-limit, Math.min(limit, slip / 3.5));

      b.vx += jn * nx - jt * tx;
      b.vz += jn * nz - jt * tz;
      b.wy += (2.5 * jt) / R;

      const torque = (2.5 * CUSHION_CONTACT_SIN * jn) / R;
      b.wx += torque * tx;
      b.wz += torque * tz;

      b.moving = true;
      events.push({ type: 'cushion', ball: b.id, speed: -vn, x: b.x, z: b.z });
    }
  }

  private checkPocket(b: Ball, events: SimEvent[]): void {
    const outOfBounds = Math.abs(b.x) > HALF_L + R * 0.5 || Math.abs(b.z) > HALF_W + R * 0.5;
    let nearest = -1;
    let nearestDist = Infinity;
    for (let i = 0; i < this.pockets.length; i++) {
      const p = this.pockets[i];
      const dist = Math.hypot(b.x - p.x, b.z - p.z);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }
    if (nearestDist < this.pockets[nearest].captureRadius || outOfBounds) {
      const speed = Math.hypot(b.vx, b.vz);
      this.remove(b.id);
      events.push({ type: 'pocket', ball: b.id, pocket: nearest, speed });
    }
  }
}
