import { HALF_L, HALF_W, TABLE } from '../config';

export interface Point {
  x: number;
  z: number;
}

export interface Segment {
  a: Point;
  b: Point;
}

export interface Pocket {
  x: number;
  z: number;
  holeRadius: number;
  captureRadius: number;
  kind: 'corner' | 'side';
}

export interface TableGeometry {
  cushions: Point[][];
  segments: Segment[];
  pockets: Pocket[];
}

const CORNER_POCKET_OFFSET = 0.02;
const SIDE_POCKET_DEPTH = 0.048;
const SIDE_JAW_TAPER = 0.012;
const CAPTURE_MARGIN = 0.01;

function mirror(points: Point[], sx: number, sz: number): Point[] {
  const mirrored = points.map((p) => ({ x: p.x * sx, z: p.z * sz }));
  return sx * sz < 0 ? mirrored.reverse() : mirrored;
}

function buildCushions(): Point[][] {
  const cw = TABLE.cushionWidth;
  const cc = TABLE.cornerCut;
  const sc = TABLE.sideCut;

  const longRail: Point[] = [
    { x: -HALF_L + cc - cw, z: -HALF_W - cw },
    { x: -HALF_L + cc, z: -HALF_W },
    { x: -sc, z: -HALF_W },
    { x: -sc + SIDE_JAW_TAPER, z: -HALF_W - cw },
  ];
  const shortRail: Point[] = [
    { x: -HALF_L - cw, z: HALF_W - cc + cw },
    { x: -HALF_L, z: HALF_W - cc },
    { x: -HALF_L, z: -HALF_W + cc },
    { x: -HALF_L - cw, z: -HALF_W + cc - cw },
  ];

  return [
    longRail,
    mirror(longRail, -1, 1),
    mirror(longRail, 1, -1),
    mirror(longRail, -1, -1),
    shortRail,
    mirror(shortRail, -1, 1),
  ];
}

function buildPockets(): Pocket[] {
  const pockets: Pocket[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      pockets.push({
        x: sx * (HALF_L + CORNER_POCKET_OFFSET),
        z: sz * (HALF_W + CORNER_POCKET_OFFSET),
        holeRadius: TABLE.cornerPocketRadius,
        captureRadius: TABLE.cornerPocketRadius - CAPTURE_MARGIN,
        kind: 'corner',
      });
    }
  }
  for (const sz of [-1, 1]) {
    pockets.push({
      x: 0,
      z: sz * (HALF_W + SIDE_POCKET_DEPTH),
      holeRadius: TABLE.sidePocketRadius,
      captureRadius: TABLE.sidePocketRadius - CAPTURE_MARGIN,
      kind: 'side',
    });
  }
  return pockets;
}

export function buildTableGeometry(): TableGeometry {
  const cushions = buildCushions();
  const segments: Segment[] = [];
  for (const poly of cushions) {
    for (let i = 0; i < poly.length - 1; i++) {
      segments.push({ a: poly[i], b: poly[i + 1] });
    }
  }
  return { cushions, segments, pockets: buildPockets() };
}

/**
 * Closed outline of the rectangle |x| <= halfX, |z| <= halfZ where the parts
 * near each pocket are replaced by arcs of the pocket hole. `bulge: 'out'`
 * traces the union (rectangle + holes), `'in'` the difference (rectangle - holes).
 * Points are returned counter-clockwise in the X/Z plane.
 */
export function pocketedOutline(
  halfX: number,
  halfZ: number,
  pockets: Pocket[],
  bulge: 'in' | 'out',
  radiusFor: (p: Pocket) => number = (p) => p.holeRadius,
  arcSteps = 20,
): Point[] {
  const perimeter = 4 * (halfX + halfZ);
  const samples = 480;
  const insideHole = (p: Point) =>
    pockets.some((pk) => Math.hypot(p.x - pk.x, p.z - pk.z) < radiusFor(pk));

  const pointAt = (s: number): Point => {
    const w = 2 * halfX;
    const h = 2 * halfZ;
    let d = ((s % perimeter) + perimeter) % perimeter;
    if (d < w) return { x: -halfX + d, z: -halfZ };
    d -= w;
    if (d < h) return { x: halfX, z: -halfZ + d };
    d -= h;
    if (d < w) return { x: halfX - d, z: halfZ };
    d -= w;
    return { x: -halfX, z: halfZ - d };
  };

  const corners = [0, 2 * halfX, 2 * halfX + 2 * halfZ, 4 * halfX + 2 * halfZ];
  const out: Point[] = [];
  let startS = 0;
  while (insideHole(pointAt(startS))) startS += perimeter / samples;

  const refine = (s0: number, s1: number) => {
    let lo = s0;
    let hi = s1;
    const loInside = insideHole(pointAt(lo));
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (insideHole(pointAt(mid)) === loInside) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const nearestPocket = (p: Point) =>
    pockets.reduce((best, pk) =>
      Math.hypot(p.x - pk.x, p.z - pk.z) < Math.hypot(p.x - best.x, p.z - best.z) ? pk : best,
    );

  const step = perimeter / samples;
  let prevInside = false;
  let prevS = startS;
  let entry: Point | null = null;

  for (let i = 0; i <= samples; i++) {
    const s = startS + i * step;
    const p = pointAt(s);
    const inside = insideHole(p);

    for (const c of corners) {
      for (const cs of [c, c + perimeter, c + 2 * perimeter]) {
        if (cs > prevS && cs < s && !insideHole(pointAt(cs))) out.push(pointAt(cs));
      }
    }

    if (inside && !prevInside) {
      entry = pointAt(refine(prevS, s));
      out.push(entry);
    } else if (!inside && prevInside && entry) {
      const exit = pointAt(refine(prevS, s));
      const pk = nearestPocket(entry);
      const r = radiusFor(pk);
      const a0 = Math.atan2(entry.z - pk.z, entry.x - pk.x);
      const a1 = Math.atan2(exit.z - pk.z, exit.x - pk.x);
      const outward = Math.atan2(pk.z, pk.x);
      let delta = a1 - a0;
      while (delta <= -Math.PI) delta += 2 * Math.PI;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      const midAngle = a0 + delta / 2;
      const midIsOutward = Math.cos(midAngle - outward) > 0;
      if ((bulge === 'out') !== midIsOutward) delta = delta > 0 ? delta - 2 * Math.PI : delta + 2 * Math.PI;
      for (let k = 1; k < arcSteps; k++) {
        const a = a0 + (delta * k) / arcSteps;
        out.push({ x: pk.x + Math.cos(a) * r, z: pk.z + Math.sin(a) * r });
      }
      out.push(exit);
      entry = null;
    }
    prevInside = inside;
    prevS = s;
  }
  return out;
}
