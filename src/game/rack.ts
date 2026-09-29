import { BALL_RADIUS as R, FOOT_SPOT_X, HALF_L, HALF_W, HEAD_STRING_X } from '../config';
import { SOLIDS, STRIPES } from './rules';

export interface Placement {
  id: number;
  x: number;
  z: number;
}

const RACK_GAP = 0.0002;

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Standard 8-ball rack: apex on the foot spot, 8 in the centre, one solid and one stripe in the back corners. */
export function rackPositions(): Placement[] {
  const spacing = 2 * R + RACK_GAP;
  const rowStep = spacing * Math.cos(Math.PI / 6);
  const slots: { x: number; z: number }[] = [];
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      slots.push({ x: FOOT_SPOT_X + row * rowStep, z: (k - row / 2) * spacing });
    }
  }

  const solidCorner = Math.random() < 0.5;
  const solids = shuffle(SOLIDS.filter((b) => b !== 1));
  const stripes = shuffle(STRIPES);
  const cornerA = solidCorner ? solids.pop()! : stripes.pop()!;
  const cornerB = solidCorner ? stripes.pop()! : solids.pop()!;
  const rest = shuffle([...solids, ...stripes]);

  const order: number[] = new Array(15);
  order[0] = 1;
  order[4] = 8;
  order[10] = cornerA;
  order[14] = cornerB;
  for (let i = 0; i < 15; i++) {
    if (order[i] === undefined) order[i] = rest.pop()!;
  }

  return slots.map((s, i) => ({ id: order[i], x: s.x, z: s.z }));
}

export const HEAD_SPOT = { x: HEAD_STRING_X, z: 0 };

export function isInsidePlayArea(x: number, z: number, kitchenOnly: boolean): boolean {
  const margin = R + 0.001;
  if (Math.abs(x) > HALF_L - margin || Math.abs(z) > HALF_W - margin) return false;
  return !kitchenOnly || x <= HEAD_STRING_X;
}

export function isFreeSpot(x: number, z: number, others: { x: number; z: number }[]): boolean {
  const min = 2 * R + 0.0005;
  return others.every((o) => Math.hypot(o.x - x, o.z - z) >= min);
}

/** First free spot on the long string from the foot spot toward the foot rail, then back toward the head. */
export function respotPosition(others: { x: number; z: number }[]): { x: number; z: number } {
  const step = 0.004;
  for (let x = FOOT_SPOT_X; x < HALF_L - R; x += step) {
    if (isFreeSpot(x, 0, others)) return { x, z: 0 };
  }
  for (let x = FOOT_SPOT_X; x > -HALF_L + R; x -= step) {
    if (isFreeSpot(x, 0, others)) return { x, z: 0 };
  }
  return { x: FOOT_SPOT_X, z: 0 };
}
