import * as THREE from 'three';
import { TABLE } from '../config';
import { Walker } from '../input/walker';
import type { CameraRig } from '../render/cameraRig';
import { createCharacter, DEFAULT_LOOKS, type Character } from '../render/character';
import type { Patrons } from '../render/patrons';
import type { Saloon } from '../render/saloon';
import type { Quality } from '../render/stage';
import { TABLE_EXTENT } from '../render/table';

const FLOOR_Y = -TABLE.surfaceHeight;
const CEILING_Y = 2.6;
const REACH_DISTANCE = 0.9;
const RUN_THRESHOLD = 2.2;
const MOVE_THRESHOLD = 0.15;

/** Lets the player leave the table and walk the saloon in third or first person (desktop only). */
export class Stroll {
  readonly available: boolean;
  private readonly walker: Walker;
  private readonly avatar: Character;

  constructor(
    scene: THREE.Scene,
    canvas: HTMLElement,
    saloon: Saloon,
    private readonly patrons: Patrons,
    quality: Quality,
  ) {
    this.available = !window.matchMedia('(pointer: coarse)').matches;
    this.walker = new Walker(canvas, saloon.colliders, saloon.walkBounds, CEILING_Y);
    this.avatar = createCharacter(DEFAULT_LOOKS[0], { quality });
    this.avatar.object.traverse((o) => (o.castShadow = true));
    this.avatar.object.visible = false;
    scene.add(this.avatar.object);
  }

  get active(): boolean {
    return this.walker.active;
  }

  get pointerLocked(): boolean {
    return this.walker.pointerLocked;
  }

  /** Stand up from the table where the camera currently is, facing the given point. */
  enter(from: THREE.Vector3, faceX: number, faceZ: number): void {
    if (!this.available) return;
    this.walker.start(from.x, from.z, Math.atan2(faceX - from.x, faceZ - from.z));
    this.walker.lockPointer();
    this.avatar.setAction('idle');
    this.avatar.object.visible = true;
  }

  exit(): void {
    this.walker.stop();
    this.avatar.object.visible = false;
  }

  get position(): THREE.Vector2 {
    return this.walker.position;
  }

  nearTable(): boolean {
    const p = this.walker.position;
    const dx = Math.max(0, Math.abs(p.x) - TABLE_EXTENT.x);
    const dz = Math.max(0, Math.abs(p.y) - TABLE_EXTENT.z);
    return Math.hypot(dx, dz) < REACH_DISTANCE;
  }

  update(dt: number, time: number, rig: CameraRig): void {
    if (!this.walker.active) return;
    this.walker.setDynamicColliders(this.patrons.colliders());
    this.walker.update(dt);
    const p = this.walker.position;
    this.patrons.setPlayerPosition(p.x, p.y);

    const speed = this.walker.speed;
    this.avatar.setAction(speed > RUN_THRESHOLD ? 'run' : speed > MOVE_THRESHOLD ? 'walk' : 'idle');
    this.avatar.setSpeed(speed);
    this.avatar.object.position.set(p.x, FLOOR_Y, p.y);
    this.avatar.object.rotation.y = this.walker.bodyYaw;
    this.avatar.object.visible = !this.walker.firstPerson;
    this.avatar.update(dt, time);

    const pose = this.walker.cameraPose();
    rig.setWalkPose(pose.position, pose.target);
  }
}
