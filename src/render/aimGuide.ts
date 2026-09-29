import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BALL_RADIUS as R } from '../config';
import type { AimPrediction } from '../physics/predict';

const Y = 0.002;
const TARGET_LINE = 0.45;
const DEFLECT_LINE = 0.3;

function makeLine(color: number, width: number, dashed: boolean, opacity: number): Line2 {
  const material = new LineMaterial({
    color,
    linewidth: width,
    dashed,
    dashSize: 0.025,
    gapSize: 0.018,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const line = new Line2(new LineGeometry(), material);
  line.renderOrder = 2;
  return line;
}

function setSegment(line: Line2, ax: number, az: number, bx: number, bz: number): void {
  const geometry = line.geometry as LineGeometry;
  geometry.setPositions([ax, Y, az, bx, Y, bz]);
  line.computeLineDistances();
}

export class AimGuide {
  readonly group = new THREE.Group();
  private readonly main = makeLine(0xf6e7c1, 2, true, 0.75);
  private readonly targetLine = makeLine(0xffd27a, 2.5, false, 0.85);
  private readonly deflectLine = makeLine(0xf6e7c1, 1.5, true, 0.45);
  private readonly ghost: THREE.Mesh;

  constructor() {
    this.ghost = new THREE.Mesh(
      new THREE.RingGeometry(R * 0.88, R, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf6e7c1, transparent: true, opacity: 0.7, depthWrite: false }),
    );
    this.ghost.position.y = Y;
    this.ghost.renderOrder = 2;
    this.group.add(this.main, this.targetLine, this.deflectLine, this.ghost);
  }

  setResolution(width: number, height: number): void {
    for (const line of [this.main, this.targetLine, this.deflectLine]) {
      (line.material as LineMaterial).resolution.set(width, height);
    }
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  update(cueX: number, cueZ: number, angle: number, p: AimPrediction, legalTarget: boolean): void {
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    setSegment(this.main, cueX + dx * R, cueZ + dz * R, p.ghostX - dx * R, p.ghostZ - dz * R);
    this.ghost.position.x = p.ghostX;
    this.ghost.position.z = p.ghostZ;
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(legalTarget ? 0xf6e7c1 : 0xff5a3c);

    if (p.target === null) {
      const vn = dx * p.cushionNormalX + dz * p.cushionNormalZ;
      const rx = dx - 2 * vn * p.cushionNormalX;
      const rz = dz - 2 * vn * p.cushionNormalZ;
      this.targetLine.visible = false;
      this.deflectLine.visible = true;
      setSegment(this.deflectLine, p.ghostX, p.ghostZ, p.ghostX + rx * DEFLECT_LINE, p.ghostZ + rz * DEFLECT_LINE);
      return;
    }

    const tx = p.ghostX + p.targetDirX * 2 * R;
    const tz = p.ghostZ + p.targetDirZ * 2 * R;
    this.targetLine.visible = true;
    setSegment(
      this.targetLine,
      tx,
      tz,
      tx + p.targetDirX * TARGET_LINE * (0.25 + 0.75 * p.fullness),
      tz + p.targetDirZ * TARGET_LINE * (0.25 + 0.75 * p.fullness),
    );
    (this.targetLine.material as LineMaterial).color.set(legalTarget ? 0xffd27a : 0xff5a3c);

    let ox = dx - p.fullness * p.targetDirX;
    let oz = dz - p.fullness * p.targetDirZ;
    const len = Math.hypot(ox, oz);
    this.deflectLine.visible = len > 0.02;
    if (len > 0.02) {
      ox /= len;
      oz /= len;
      const k = DEFLECT_LINE * Math.min(1, len * 1.4);
      setSegment(this.deflectLine, p.ghostX, p.ghostZ, p.ghostX + ox * k, p.ghostZ + oz * k);
    }
  }
}
