import * as THREE from 'three';
import { TABLE } from '../config';
import { Walker } from '../input/walker';
import type { Pose } from '../net/protocol';
import type { CameraRig } from '../render/cameraRig';
import { createCharacter, DEFAULT_LOOKS, type Character } from '../render/character';
import type { Patrons } from '../render/patrons';
import type { Saloon } from '../render/saloon';
import { SpeechBubble } from '../render/speechBubble';
import type { Quality } from '../render/stage';
import { TABLE_EXTENT } from '../render/table';

const FLOOR_Y = -TABLE.surfaceHeight;
const CEILING_Y = 2.6;
const REACH_DISTANCE = 0.9;
const RUN_THRESHOLD = 2.2;
const MOVE_THRESHOLD = 0.15;
const DRINK_TIME = 2.4;
const MAX_TIPSY = 6;
const SOBER_RATE = 1 / 75;
const BAR_FRONT_X = -3.0;
const BAR_HALF_LENGTH = 2.6;

/** Lets the player leave the table and walk the saloon in third or first person (desktop only). */
export class Stroll {
  readonly available: boolean;
  private readonly walker: Walker;
  private readonly avatar: Character;
  private extraColliders: () => { x: number; z: number; r: number }[] = () => [];
  private readonly colliderBuffer: { x: number; z: number; r: number }[] = [];
  private drinkTimer = 0;
  private tipsy = 0;
  private readonly sway = new THREE.Vector3();
  private readonly bubble = new SpeechBubble();
  shots = 0;

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
    scene.add(this.avatar.object, this.bubble.sprite);
  }

  /** Shows a chat line over the avatar (only visible while walking in third person). */
  say(text: string): void {
    this.bubble.say(text);
  }

  /** Stops held movement keys, e.g. when a text field takes the keyboard. */
  releaseKeys(): void {
    this.walker.releaseKeys();
  }

  get active(): boolean {
    return this.walker.active;
  }

  get pointerLocked(): boolean {
    return this.walker.pointerLocked;
  }

  setLook(index: number): void {
    this.avatar.setLook(DEFAULT_LOOKS[index % DEFAULT_LOOKS.length]);
  }

  setExtraColliders(provider: () => { x: number; z: number; r: number }[]): void {
    this.extraColliders = provider;
  }

  enterAt(x: number, z: number, yaw: number): void {
    if (!this.available) return;
    this.walker.start(x, z, yaw);
    this.avatar.setAction('idle');
    this.avatar.object.visible = true;
  }

  nearBar(): boolean {
    const p = this.walker.position;
    return p.x < BAR_FRONT_X && Math.abs(p.y) < BAR_HALF_LENGTH;
  }

  get tipsyLevel(): number {
    return this.tipsy;
  }

  /** Sobering up happens whether walking or at the table. */
  tick(dt: number): void {
    this.tipsy = Math.max(0, this.tipsy - SOBER_RATE * dt);
  }

  get drinking(): boolean {
    return this.drinkTimer > 0;
  }

  /** Knock back a shot at the bar. Returns false if already drinking. */
  orderShot(): boolean {
    if (this.drinkTimer > 0 || !this.walker.active) return false;
    this.drinkTimer = DRINK_TIME;
    this.walker.frozen = true;
    this.avatar.setDrinkProp('whisky');
    this.avatar.setAction('drink');
    this.shots += 1;
    this.tipsy = Math.min(MAX_TIPSY, this.tipsy + 1);
    return true;
  }

  pose(): Pose {
    const speed = this.walker.speed;
    return {
      x: this.walker.position.x,
      z: this.walker.position.y,
      yaw: this.walker.bodyYaw,
      action: this.drinkTimer > 0 ? 'drink' : speed > RUN_THRESHOLD ? 'run' : speed > MOVE_THRESHOLD ? 'walk' : 'idle',
      speed,
      atTable: false,
    };
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
    this.bubble.sprite.visible = false;
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
    const buffer = this.colliderBuffer;
    buffer.length = 0;
    for (const c of this.patrons.colliders()) buffer.push(c);
    for (const c of this.extraColliders()) buffer.push(c);
    this.walker.setDynamicColliders(buffer);
    this.walker.wobble = this.tipsy;
    if (this.drinkTimer > 0) {
      this.drinkTimer -= dt;
      if (this.drinkTimer <= 0) this.walker.frozen = false;
    }
    this.walker.update(dt);
    const p = this.walker.position;
    this.patrons.setPlayerPosition(p.x, p.y);

    const speed = this.walker.speed;
    this.avatar.setAction(
      this.drinkTimer > 0 ? 'drink' : speed > RUN_THRESHOLD ? 'run' : speed > MOVE_THRESHOLD ? 'walk' : 'idle',
    );
    this.avatar.setSpeed(speed);
    this.avatar.object.position.set(p.x, FLOOR_Y, p.y);
    this.avatar.object.rotation.y = this.walker.bodyYaw;
    this.avatar.object.visible = !this.walker.firstPerson;
    this.avatar.update(dt, time);
    this.bubble.update(dt, p.x, FLOOR_Y + this.avatar.height + 0.12, p.y, rig.camera.position, !this.walker.firstPerson);

    const pose = this.walker.cameraPose();
    if (this.tipsy > 0.01) {
      const k = this.tipsy;
      this.sway.set(Math.sin(time * 0.9) * 0.09 * k, Math.sin(time * 0.71 + 1) * 0.05 * k, Math.cos(time * 0.83) * 0.09 * k);
      pose.target.add(this.sway);
      pose.position.addScaledVector(this.sway, 0.15);
    }
    rig.setWalkPose(pose.position, pose.target);
  }
}
