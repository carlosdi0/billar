import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_L, HALF_W, TABLE } from '../config';
import { pocketedOutline, type Pocket, type Point, type TableGeometry } from '../physics/tableGeometry';
import { createFeltTexture, createLeatherTexture, createWoodTexture, FELT_REPEAT } from './textures';

const APRON_DEPTH = 0.2;
const SLATE_THICKNESS = 0.045;
const POCKET_DEPTH = 0.16;
const OUTER_X = HALF_L + TABLE.cushionWidth + TABLE.railWidth;
const OUTER_Z = HALF_W + TABLE.cushionWidth + TABLE.railWidth;

/** Shapes live in the X/-Z plane so that rotating by -90° around X maps them onto the table. */
function toShapePoints(points: Point[]): THREE.Vector2[] {
  return points.map((p) => new THREE.Vector2(p.x, -p.z));
}

function layFlat(geometry: THREE.BufferGeometry, bottomY: number): THREE.BufferGeometry {
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bottomY, 0);
  return geometry;
}

function planarUVs(geometry: THREE.BufferGeometry, scale: number): void {
  const pos = geometry.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) * scale;
    uv[i * 2 + 1] = pos.getZ(i) * scale + pos.getY(i) * scale;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function buildCloth(geometry: TableGeometry, material: THREE.Material): THREE.Mesh {
  const outline = pocketedOutline(
    HALF_L + TABLE.cushionWidth,
    HALF_W + TABLE.cushionWidth,
    geometry.pockets,
    'in',
  );
  const shape = new THREE.Shape(toShapePoints(outline));
  const geo = layFlat(
    new THREE.ExtrudeGeometry(shape, { depth: SLATE_THICKNESS, bevelEnabled: false, curveSegments: 24 }),
    -SLATE_THICKNESS,
  );
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildCushions(geometry: TableGeometry, material: THREE.Material): THREE.Mesh {
  const parts = geometry.cushions.map((poly) => {
    const shape = new THREE.Shape(toShapePoints(poly));
    return layFlat(
      new THREE.ExtrudeGeometry(shape, {
        depth: TABLE.cushionHeight - 0.008,
        bevelEnabled: true,
        bevelThickness: 0.004,
        bevelSize: 0.003,
        bevelOffset: -0.003,
        bevelSegments: 3,
      }),
      0.004,
    );
  });
  const mesh = new THREE.Mesh(mergeGeometries(parts), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function buildRails(geometry: TableGeometry, material: THREE.Material): THREE.Mesh {
  const outer = new THREE.Shape();
  const r = 0.05;
  outer.moveTo(-OUTER_X + r, OUTER_Z);
  outer.lineTo(OUTER_X - r, OUTER_Z);
  outer.quadraticCurveTo(OUTER_X, OUTER_Z, OUTER_X, OUTER_Z - r);
  outer.lineTo(OUTER_X, -OUTER_Z + r);
  outer.quadraticCurveTo(OUTER_X, -OUTER_Z, OUTER_X - r, -OUTER_Z);
  outer.lineTo(-OUTER_X + r, -OUTER_Z);
  outer.quadraticCurveTo(-OUTER_X, -OUTER_Z, -OUTER_X, -OUTER_Z + r);
  outer.lineTo(-OUTER_X, OUTER_Z - r);
  outer.quadraticCurveTo(-OUTER_X, OUTER_Z, -OUTER_X + r, OUTER_Z);

  const inner = pocketedOutline(
    HALF_L + TABLE.cushionWidth,
    HALF_W + TABLE.cushionWidth,
    geometry.pockets,
    'out',
    (p) => p.holeRadius + RAIL_HOLE_MARGIN,
  );
  outer.holes.push(new THREE.Path(toShapePoints(inner)));

  const height = TABLE.railHeight + APRON_DEPTH;
  const geo = layFlat(
    new THREE.ExtrudeGeometry(outer, {
      depth: height - 0.024,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.01,
      bevelOffset: -0.01,
      bevelSegments: 4,
      curveSegments: 16,
    }),
    -APRON_DEPTH + 0.012,
  );
  planarUVs(geo, 0.6);
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const RAIL_HOLE_MARGIN = 0.012;
const CAP_WIDTH = 0.024;
const CAP_THICKNESS = 0.005;
const CAP_LIP_DEPTH = 0.045;

/** Angular range (world X/Z angle around the pocket) where the rail hole edge lies over the rail. */
function railArc(p: Pocket, radius: number): [number, number] {
  const backX = HALF_L + TABLE.cushionWidth;
  const backZ = HALF_W + TABLE.cushionWidth;
  const overRail = (a: number) => {
    const x = p.x + Math.cos(a) * radius;
    const z = p.z + Math.sin(a) * radius;
    return Math.abs(x) > backX + 1e-4 || Math.abs(z) > backZ + 1e-4;
  };
  const inward = Math.atan2(-p.z, -p.x);
  const edge = (from: number, dir: 1 | -1) => {
    let lo = from;
    let hi = from + dir * Math.PI;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (overRail(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  const start = edge(inward, 1);
  let end = edge(inward, -1);
  if (end < start) end += Math.PI * 2;
  return [start, end];
}

function buildPocketCap(p: Pocket): THREE.BufferGeometry[] {
  const inner = p.holeRadius + RAIL_HOLE_MARGIN;
  const outer = inner + CAP_WIDTH;
  const [a0, a1] = railArc(p, inner);
  const steps = 32;
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    points.push({ x: p.x + Math.cos(a) * outer, z: p.z + Math.sin(a) * outer });
  }
  for (let i = steps; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / steps;
    points.push({ x: p.x + Math.cos(a) * inner, z: p.z + Math.sin(a) * inner });
  }
  const top = layFlat(
    new THREE.ExtrudeGeometry(new THREE.Shape(toShapePoints(points)), {
      depth: CAP_THICKNESS - 0.002,
      bevelEnabled: true,
      bevelThickness: 0.001,
      bevelSize: 0.0015,
      bevelOffset: -0.0015,
      bevelSegments: 2,
    }),
    TABLE.railHeight + 0.001,
  );
  const lip = new THREE.CylinderGeometry(inner, inner, CAP_LIP_DEPTH, steps, 1, true, Math.PI / 2 - a1, a1 - a0);
  lip.translate(p.x, TABLE.railHeight + CAP_THICKNESS - CAP_LIP_DEPTH / 2, p.z);
  return [top.toNonIndexed(), lip.toNonIndexed()];
}

function buildPockets(geometry: TableGeometry, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const bottom = new THREE.MeshStandardMaterial({ color: 0x050302, roughness: 1 });
  const brass = new THREE.MeshStandardMaterial({
    color: 0x9a7338,
    metalness: 0.85,
    roughness: 0.42,
    side: THREE.DoubleSide,
  });
  const caps: THREE.BufferGeometry[] = [];
  for (const p of geometry.pockets) {
    const radius = p.holeRadius + 0.004;
    const liner = new THREE.Mesh(
      new THREE.CylinderGeometry(radius, radius * 0.85, POCKET_DEPTH, 28, 1, true),
      material,
    );
    liner.position.set(p.x, -POCKET_DEPTH / 2 + 0.002, p.z);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.85, 24), bottom);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(p.x, -POCKET_DEPTH + 0.004, p.z);
    liner.castShadow = true;
    floor.castShadow = true;
    group.add(liner, floor);
    caps.push(...buildPocketCap(p));
  }
  for (const g of caps) {
    g.deleteAttribute('uv');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
  }
  const capMesh = new THREE.Mesh(mergeGeometries(caps), brass);
  capMesh.castShadow = true;
  capMesh.receiveShadow = true;
  group.add(capMesh);
  return group;
}

function buildDiamonds(): THREE.InstancedMesh {
  const railMid = TABLE.cushionWidth + TABLE.railWidth / 2;
  const spots: [number, number][] = [];
  for (let k = 1; k <= 7; k++) {
    if (k === 4) continue;
    const x = -HALF_L + (k * TABLE.length) / 8;
    spots.push([x, -HALF_W - railMid], [x, HALF_W + railMid]);
  }
  for (let k = 1; k <= 3; k++) {
    const z = -HALF_W + (k * TABLE.width) / 4;
    spots.push([-HALF_L - railMid, z], [HALF_L + railMid, z]);
  }
  const shape = new THREE.Shape();
  const s = 0.011;
  shape.moveTo(0, s * 1.6);
  shape.lineTo(s, 0);
  shape.lineTo(0, -s * 1.6);
  shape.lineTo(-s, 0);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xcdbf9f, roughness: 0.45, metalness: 0.1 });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m = new THREE.Matrix4();
  spots.forEach(([x, z], i) => {
    const alongX = Math.abs(z) > HALF_W;
    m.makeRotationY(alongX ? Math.PI / 2 : 0).setPosition(x, TABLE.railHeight + 0.0015, z);
    mesh.setMatrixAt(i, m);
  });
  return mesh;
}

function buildLegs(material: THREE.Material): THREE.Mesh {
  const floorY = -TABLE.surfaceHeight;
  const top = -APRON_DEPTH;
  const h = top - floorY;
  const profile = [
    [0.0, 0],
    [0.075, 0],
    [0.08, 0.03],
    [0.06, 0.06],
    [0.05, 0.12],
    [0.065, 0.2],
    [0.05, 0.3],
    [0.04, 0.42],
    [0.055, 0.5],
    [0.07, h - 0.04],
    [0.075, h],
    [0.0, h],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const leg = new THREE.LatheGeometry(profile, 20);
  leg.translate(0, floorY, 0);
  const legs: THREE.BufferGeometry[] = [];
  const lx = OUTER_X - 0.16;
  const lz = OUTER_Z - 0.16;
  for (const [x, z] of [[-lx, -lz], [lx, -lz], [-lx, lz], [lx, lz], [0, -lz], [0, lz]]) {
    legs.push(leg.clone().translate(x, 0, z));
  }
  const beam = new THREE.BoxGeometry(OUTER_X * 2 - 0.4, 0.05, 0.08).translate(0, floorY + 0.14, 0);
  legs.push(beam);
  const mesh = new THREE.Mesh(mergeGeometries(legs), material);
  mesh.castShadow = true;
  return mesh;
}

export function createTable(geometry: TableGeometry): THREE.Group {
  const group = new THREE.Group();
  group.name = 'table';

  const felt = createFeltTexture();
  // Extruded shapes carry UVs in metres; FELT_REPEAT assumes UVs spanning the 2.5 x 1.4 m cloth.
  for (const t of [felt.map, felt.bumpMap]) t.repeat.set(FELT_REPEAT.x / 2.5, FELT_REPEAT.y / 1.4);
  const clothMaterial = new THREE.MeshStandardMaterial({
    map: felt.map,
    bumpMap: felt.bumpMap,
    bumpScale: 0.6,
    roughness: 0.92,
    metalness: 0,
  });
  const cushionMaterial = clothMaterial.clone();
  cushionMaterial.color = new THREE.Color(0.82, 0.82, 0.82);

  const rail = createWoodTexture('rail');
  const railMaterial = new THREE.MeshPhysicalMaterial({
    map: rail.map,
    bumpMap: rail.bumpMap,
    bumpScale: 0.3,
    color: 0x9a7868,
    roughness: 0.38,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
  });
  const dark = createWoodTexture('dark');
  const legMaterial = new THREE.MeshStandardMaterial({ map: dark.map, bumpMap: dark.bumpMap, roughness: 0.5 });
  const leatherMaterial = new THREE.MeshStandardMaterial({
    map: createLeatherTexture(),
    roughness: 0.7,
    side: THREE.DoubleSide,
  });

  group.add(
    buildCloth(geometry, clothMaterial),
    buildCushions(geometry, cushionMaterial),
    buildRails(geometry, railMaterial),
    buildPockets(geometry, leatherMaterial),
    buildDiamonds(),
    buildLegs(legMaterial),
  );
  return group;
}

export const TABLE_EXTENT = { x: OUTER_X, z: OUTER_Z };
