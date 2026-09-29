import { BALL_RADIUS as R } from '../config';
import type { Ball } from './simulation';
import type { Segment } from './tableGeometry';

export interface AimPrediction {
  ghostX: number;
  ghostZ: number;
  target: number | null;
  targetDirX: number;
  targetDirZ: number;
  /** Fraction of the cue ball speed transferred to the object ball (cosine of the cut angle). */
  fullness: number;
  cushionNormalX: number;
  cushionNormalZ: number;
}

const MAX_DISTANCE = 3;

function rayCircle(px: number, pz: number, dx: number, dz: number, cx: number, cz: number, radius: number): number {
  const fx = px - cx;
  const fz = pz - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

function raySegment(px: number, pz: number, dx: number, dz: number, seg: Segment): { t: number; nx: number; nz: number } {
  let best = { t: Infinity, nx: 0, nz: 0 };
  for (const end of [seg.a, seg.b]) {
    const t = rayCircle(px, pz, dx, dz, end.x, end.z, R);
    if (t < best.t) {
      const hx = px + dx * t - end.x;
      const hz = pz + dz * t - end.z;
      const len = Math.hypot(hx, hz) || 1;
      best = { t, nx: hx / len, nz: hz / len };
    }
  }
  const ex = seg.b.x - seg.a.x;
  const ez = seg.b.z - seg.a.z;
  const len = Math.hypot(ex, ez);
  let nx = -ez / len;
  let nz = ex / len;
  const side = (px - seg.a.x) * nx + (pz - seg.a.z) * nz;
  if (side < 0) {
    nx = -nx;
    nz = -nz;
  }
  const dn = dx * nx + dz * nz;
  if (dn < 0) {
    const t = (Math.abs(side) - R) / -dn;
    if (t >= 0 && t < best.t) {
      const hx = px + dx * t;
      const hz = pz + dz * t;
      const u = ((hx - seg.a.x) * ex + (hz - seg.a.z) * ez) / (len * len);
      if (u >= 0 && u <= 1) best = { t, nx, nz };
    }
  }
  return best;
}

export function predictAim(balls: Ball[], segments: Segment[], cueId: number, angle: number): AimPrediction {
  const cue = balls[cueId];
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  let bestT = MAX_DISTANCE;
  let target: number | null = null;
  let cushionNormalX = 0;
  let cushionNormalZ = 0;

  for (const b of balls) {
    if (b.id === cueId || !b.onTable) continue;
    const t = rayCircle(cue.x, cue.z, dx, dz, b.x, b.z, 2 * R);
    if (t < bestT) {
      bestT = t;
      target = b.id;
    }
  }
  for (const seg of segments) {
    const hit = raySegment(cue.x, cue.z, dx, dz, seg);
    if (hit.t < bestT) {
      bestT = hit.t;
      target = null;
      cushionNormalX = hit.nx;
      cushionNormalZ = hit.nz;
    }
  }

  const ghostX = cue.x + dx * bestT;
  const ghostZ = cue.z + dz * bestT;
  let targetDirX = 0;
  let targetDirZ = 0;
  let fullness = 0;
  if (target !== null) {
    const t = balls[target];
    const len = Math.hypot(t.x - ghostX, t.z - ghostZ) || 1;
    targetDirX = (t.x - ghostX) / len;
    targetDirZ = (t.z - ghostZ) / len;
    fullness = Math.max(0, dx * targetDirX + dz * targetDirZ);
  }
  return { ghostX, ghostZ, target, targetDirX, targetDirZ, fullness, cushionNormalX, cushionNormalZ };
}
