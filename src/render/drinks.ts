import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_L, HALF_W, TABLE } from '../config';

const RAIL_MID = TABLE.cushionWidth + TABLE.railWidth / 2;
const HIDE_DISTANCE = 0.45;

interface Drink {
  object: THREE.Object3D;
  position: THREE.Vector3;
}

function beerMug(materials: Record<'glass' | 'beer' | 'foam', THREE.Material>): THREE.Group {
  const mug = new THREE.Group();
  const height = 0.13;
  const radius = 0.036;

  const glassProfile = [
    [0, 0],
    [radius * 1.02, 0],
    [radius * 1.04, 0.012],
    [radius, 0.02],
    [radius * 1.05, height],
    [radius * 0.97, height],
    [radius * 0.92, 0.024],
    [0, 0.024],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const handle = new THREE.TorusGeometry(0.03, 0.007, 8, 16, Math.PI).rotateZ(-Math.PI / 2).translate(radius * 1.02, height * 0.55, 0);
  const glass = new THREE.Mesh(mergeGeometries([new THREE.LatheGeometry(glassProfile, 20), handle]), materials.glass);
  glass.renderOrder = 3;

  const beer = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.93, radius * 0.9, height * 0.72, 20).translate(0, 0.024 + height * 0.36, 0), materials.beer);
  const foamProfile = [
    [0, 0],
    [radius * 0.95, 0],
    [radius * 1.02, 0.012],
    [radius * 0.85, 0.024],
    [radius * 0.4, 0.029],
    [0, 0.03],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const foam = new THREE.Mesh(new THREE.LatheGeometry(foamProfile, 20).translate(0, 0.024 + height * 0.72, 0), materials.foam);
  mug.add(beer, foam, glass);
  return mug;
}

function whiskyGlass(materials: Record<'glass' | 'whisky', THREE.Material>): THREE.Group {
  const group = new THREE.Group();
  const glassProfile = [
    [0, 0],
    [0.032, 0],
    [0.034, 0.075],
    [0.031, 0.075],
    [0.029, 0.014],
    [0, 0.014],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const glass = new THREE.Mesh(new THREE.LatheGeometry(glassProfile, 8), materials.glass);
  glass.renderOrder = 3;
  const whisky = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8).translate(0, 0.03, 0), materials.whisky);
  group.add(whisky, glass);
  return group;
}

export class Drinks {
  readonly group = new THREE.Group();
  private readonly drinks: Drink[] = [];

  constructor() {
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0xb8c4b8,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.16,
      clearcoat: 0.6,
      depthWrite: false,
      envMapIntensity: 0.7,
    });
    const beer = new THREE.MeshStandardMaterial({ color: 0xc7811c, emissive: 0x3a1c02, roughness: 0.2, transparent: true, opacity: 0.92 });
    const foam = new THREE.MeshStandardMaterial({ color: 0xb8ab90, roughness: 0.95 });
    const whisky = new THREE.MeshStandardMaterial({ color: 0x9a4d12, emissive: 0x2a0e02, roughness: 0.15, transparent: true, opacity: 0.9 });

    const railY = TABLE.railHeight;
    const longZ = HALF_W + RAIL_MID;
    const shortX = HALF_L + RAIL_MID;
    const spots: { kind: 'beer' | 'whisky'; x: number; z: number; rot: number }[] = [
      { kind: 'beer', x: -HALF_L + (3 * TABLE.length) / 16, z: -longZ, rot: 0.6 },
      { kind: 'beer', x: HALF_L - (3 * TABLE.length) / 16, z: longZ, rot: 2.4 },
      { kind: 'whisky', x: shortX, z: -TABLE.width / 8, rot: 0 },
    ];
    for (const spot of spots) {
      const object = spot.kind === 'beer' ? beerMug({ glass, beer, foam }) : whiskyGlass({ glass, whisky });
      object.position.set(spot.x, railY, spot.z);
      object.rotation.y = spot.rot;
      this.group.add(object);
      this.drinks.push({ object, position: object.position.clone() });
    }
  }

  /** Hide drinks that would sit right in front of the lens when the camera is low over a rail. */
  update(camera: THREE.Camera): void {
    for (const d of this.drinks) {
      d.object.visible = camera.position.distanceTo(d.position) > HIDE_DISTANCE;
    }
  }
}
