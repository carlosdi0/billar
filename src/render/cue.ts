import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BALL_RADIUS as R } from '../config';
import { createWoodTexture } from './textures';

const CUE_LENGTH = 1.47;
const TIP_GAP = 0.012;
const MAX_PULL = 0.28;
const ELEVATION = THREE.MathUtils.degToRad(5);

interface Section {
  from: number;
  to: number;
  r0: number;
  r1: number;
  material: THREE.Material;
}

/** A cue built along +Y from the tip (y = 0) to the butt, then rotated to point along the aim. */
export class CueView {
  readonly object = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private strikeT = -1;
  private strikeDuration = 0.1;
  private pull = 0;
  private onContact: (() => void) | null = null;
  private opacity = 1;
  private readonly materials: THREE.Material[] = [];

  constructor() {
    const maple = createWoodTexture('cue');
    const dark = createWoodTexture('dark');
    const shaft = new THREE.MeshPhysicalMaterial({ map: maple.map, color: 0x9c8468, roughness: 0.5, clearcoat: 0.25 });
    const butt = new THREE.MeshPhysicalMaterial({ map: dark.map, roughness: 0.3, clearcoat: 0.8 });
    const tip = new THREE.MeshStandardMaterial({ color: 0x3b6b8f, roughness: 0.9 });
    const ferrule = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.3 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.3, metalness: 0.9 });
    const wrap = new THREE.MeshStandardMaterial({ color: 0x2a1a10, roughness: 0.95 });
    this.materials.push(shaft, butt, tip, ferrule, brass, wrap);

    const sections: Section[] = [
      { from: 0, to: 0.01, r0: 0.0062, r1: 0.0064, material: tip },
      { from: 0.01, to: 0.035, r0: 0.0064, r1: 0.0065, material: ferrule },
      { from: 0.035, to: 0.72, r0: 0.0065, r1: 0.0105, material: shaft },
      { from: 0.72, to: 0.74, r0: 0.0108, r1: 0.0108, material: brass },
      { from: 0.74, to: 1.0, r0: 0.0108, r1: 0.0128, material: butt },
      { from: 1.0, to: 1.28, r0: 0.0128, r1: 0.0138, material: wrap },
      { from: 1.28, to: 1.44, r0: 0.0138, r1: 0.0148, material: butt },
      { from: 1.44, to: CUE_LENGTH, r0: 0.0148, r1: 0.014, material: brass },
    ];
    const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
    for (const s of sections) {
      const geo = new THREE.CylinderGeometry(s.r1, s.r0, s.to - s.from, 24, 1, false);
      geo.translate(0, (s.from + s.to) / 2, 0);
      const list = byMaterial.get(s.material) ?? [];
      list.push(geo);
      byMaterial.set(s.material, list);
    }
    for (const [material, geos] of byMaterial) {
      const mesh = new THREE.Mesh(mergeGeometries(geos), material);
      mesh.castShadow = true;
      this.pivot.add(mesh);
    }
    this.pivot.rotation.x = -Math.PI / 2 + ELEVATION;
    this.object.add(this.pivot);
  }

  /** Place the cue behind the ball at (x, z) aiming along `angle`, with tip offsets in ball radii. */
  aim(x: number, z: number, angle: number, power: number, side: number, vertical: number): void {
    if (this.strikeT < 0) this.pull = power * MAX_PULL;
    this.layout(x, z, angle, side, vertical, TIP_GAP + this.pull);
  }

  private layout(x: number, z: number, angle: number, side: number, vertical: number, distance: number): void {
    const dir = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const contact = new THREE.Vector3(x, R, z)
      .addScaledVector(right, side * R)
      .addScaledVector(new THREE.Vector3(0, 1, 0), vertical * R)
      .addScaledVector(dir, -Math.sqrt(Math.max(0, 1 - side * side - vertical * vertical)) * R);
    const back = dir.clone().multiplyScalar(-1);
    back.y = Math.tan(ELEVATION);
    back.normalize();
    this.object.position.copy(contact).addScaledVector(back, distance);
    this.object.rotation.set(0, Math.PI / 2 - angle, 0);
    this.pivot.rotation.x = -Math.PI / 2 + ELEVATION;
  }

  strike(power: number, onContact: () => void): void {
    this.strikeT = 0;
    this.strikeDuration = THREE.MathUtils.lerp(0.16, 0.06, power);
    this.onContact = onContact;
  }

  get striking(): boolean {
    return this.strikeT >= 0;
  }

  update(dt: number, x: number, z: number, angle: number, side: number, vertical: number): void {
    if (this.strikeT < 0) return;
    this.strikeT += dt;
    const k = Math.min(1, this.strikeT / this.strikeDuration);
    const distance = TIP_GAP + this.pull * (1 - k * k) - (k >= 1 ? 0 : TIP_GAP * k);
    this.layout(x, z, angle, side, vertical, Math.max(0, distance));
    if (k >= 1 && this.onContact) {
      const callback = this.onContact;
      this.onContact = null;
      callback();
    }
    if (this.strikeT > this.strikeDuration + 0.25) this.strikeT = -1;
  }

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  fade(target: number, dt: number): void {
    this.opacity = THREE.MathUtils.damp(this.opacity, target, 10, dt);
    const transparent = this.opacity < 0.99;
    for (const m of this.materials) {
      m.transparent = transparent;
      m.opacity = this.opacity;
    }
    this.object.visible = this.opacity > 0.02;
  }
}
