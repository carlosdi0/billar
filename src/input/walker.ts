import * as THREE from 'three';
import { TABLE } from '../config';

export type WalkCollider =
  | { kind: 'circle'; x: number; z: number; r: number }
  | { kind: 'box'; minX: number; maxX: number; minZ: number; maxZ: number };

export interface WalkBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const FLOOR_Y = -TABLE.surfaceHeight;
const BODY_RADIUS = 0.28;
const WALK_SPEED = 1.5;
const RUN_SPEED = 3.2;
const ACCELERATION = 12;
const LOOK_SPEED = 0.0022;
const EYE_HEIGHT = 1.6;
const SHOULDER_OFFSET = 0.32;
const MIN_PITCH = -1.2;
const MAX_PITCH = 1.1;
const MAX_CAMERA_DISTANCE = 3;
const FIRST_PERSON_THRESHOLD = 0.25;
const CEILING_MARGIN = 0.25;

export function isTyping(e: KeyboardEvent): boolean {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
}

export class Walker {
  readonly position = new THREE.Vector2();
  yaw = 0;
  pitch = -0.15;
  cameraDistance = 1.9;
  bodyYaw = 0;
  speed = 0;
  active = false;
  /** Blocks movement input, e.g. while drinking at the bar. */
  frozen = false;
  /** 0 = sober; each unit makes walking drift a little more. */
  wobble = 0;
  private clock = 0;

  private readonly keys = new Set<string>();
  private readonly velocity = new THREE.Vector2();
  private dynamicColliders: { x: number; z: number; r: number }[] = [];
  private readonly cameraPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();

  constructor(
    private readonly element: HTMLElement,
    private readonly colliders: WalkCollider[],
    private readonly bounds: WalkBounds,
    private readonly ceilingY: number,
  ) {
    window.addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.active || document.pointerLockElement !== this.element) return;
      this.yaw -= e.movementX * LOOK_SPEED;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK_SPEED, MIN_PITCH, MAX_PITCH);
    });
    element.addEventListener('wheel', (e) => {
      if (!this.active) return;
      const from = e.deltaY > 0 ? Math.max(this.cameraDistance, FIRST_PERSON_THRESHOLD) : this.cameraDistance;
      this.cameraDistance = THREE.MathUtils.clamp(from * Math.exp(e.deltaY * 0.0015), 0, MAX_CAMERA_DISTANCE);
      if (this.cameraDistance < FIRST_PERSON_THRESHOLD && e.deltaY < 0) this.cameraDistance = 0;
    });
    element.addEventListener('click', () => {
      if (this.active && document.pointerLockElement !== element) this.lockPointer();
    });
  }

  get firstPerson(): boolean {
    return this.cameraDistance < FIRST_PERSON_THRESHOLD;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  lockPointer(): void {
    const request = this.element.requestPointerLock() as unknown;
    if (request instanceof Promise) request.catch(() => undefined);
  }

  start(x: number, z: number, yaw: number): void {
    this.position.set(x, z);
    this.resolveCollisions();
    this.yaw = yaw;
    this.bodyYaw = yaw;
    this.velocity.set(0, 0);
    this.active = true;
  }

  stop(): void {
    this.active = false;
    this.keys.clear();
    this.velocity.set(0, 0);
    this.speed = 0;
    if (document.pointerLockElement === this.element) document.exitPointerLock();
  }

  setDynamicColliders(colliders: { x: number; z: number; r: number }[]): void {
    this.dynamicColliders = colliders;
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  pressed(code: string): boolean {
    return this.keys.has(code);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.clock += dt;
    let ix = 0;
    let iz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) iz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) iz -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ix += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ix -= 1;
    const running = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    if (this.frozen) ix = iz = 0;
    if (this.wobble > 0 && (ix !== 0 || iz !== 0)) {
      const sway = Math.sin(this.clock * 1.7) * 0.14 * this.wobble + Math.sin(this.clock * 0.6) * 0.06 * this.wobble;
      const c = Math.cos(sway);
      const s = Math.sin(sway);
      [ix, iz] = [ix * c - iz * s, ix * s + iz * c];
    }
    const len = Math.hypot(ix, iz);
    const targetSpeed = len > 0 ? (running ? RUN_SPEED : WALK_SPEED) : 0;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const tx = len > 0 ? ((ix * cos + iz * sin) / len) * targetSpeed : 0;
    const tz = len > 0 ? ((-ix * sin + iz * cos) / len) * targetSpeed : 0;
    const k = 1 - Math.exp(-ACCELERATION * dt);
    this.velocity.x += (tx - this.velocity.x) * k;
    this.velocity.y += (tz - this.velocity.y) * k;

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.resolveCollisions();
    this.speed = this.velocity.length();

    if (this.firstPerson) {
      this.bodyYaw = this.yaw;
    } else if (this.speed > 0.2) {
      const desired = Math.atan2(this.velocity.x, this.velocity.y);
      let delta = desired - this.bodyYaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      this.bodyYaw += delta * (1 - Math.exp(-10 * dt));
    }
  }

  private resolveCollisions(): void {
    const p = this.position;
    for (let iteration = 0; iteration < 3; iteration++) {
      for (const c of this.colliders) {
        if (c.kind === 'circle') this.pushFromCircle(c.x, c.z, c.r);
        else this.pushFromBox(c);
      }
      for (const c of this.dynamicColliders) this.pushFromCircle(c.x, c.z, c.r);
    }
    p.x = THREE.MathUtils.clamp(p.x, this.bounds.minX + BODY_RADIUS, this.bounds.maxX - BODY_RADIUS);
    p.y = THREE.MathUtils.clamp(p.y, this.bounds.minZ + BODY_RADIUS, this.bounds.maxZ - BODY_RADIUS);
  }

  private pushFromCircle(x: number, z: number, r: number): void {
    const dx = this.position.x - x;
    const dz = this.position.y - z;
    const min = r + BODY_RADIUS;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min) return;
    const d = Math.sqrt(d2) || 1e-6;
    this.position.x = x + (dx / d) * min;
    this.position.y = z + (dz / d) * min;
  }

  private pushFromBox(b: { minX: number; maxX: number; minZ: number; maxZ: number }): void {
    const p = this.position;
    const cx = THREE.MathUtils.clamp(p.x, b.minX, b.maxX);
    const cz = THREE.MathUtils.clamp(p.y, b.minZ, b.maxZ);
    const dx = p.x - cx;
    const dz = p.y - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 0) {
      if (d2 >= BODY_RADIUS * BODY_RADIUS) return;
      const d = Math.sqrt(d2);
      p.x = cx + (dx / d) * BODY_RADIUS;
      p.y = cz + (dz / d) * BODY_RADIUS;
      return;
    }
    const exits = [p.x - b.minX, b.maxX - p.x, p.y - b.minZ, b.maxZ - p.y];
    const min = Math.min(...exits);
    if (min === exits[0]) p.x = b.minX - BODY_RADIUS;
    else if (min === exits[1]) p.x = b.maxX + BODY_RADIUS;
    else if (min === exits[2]) p.y = b.minZ - BODY_RADIUS;
    else p.y = b.maxZ + BODY_RADIUS;
  }

  /** Third-person over-the-shoulder camera that collapses into first person when zoomed in. */
  cameraPose(): { position: THREE.Vector3; target: THREE.Vector3 } {
    const eyeY = FLOOR_Y + EYE_HEIGHT;
    const fx = Math.sin(this.yaw) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = Math.cos(this.yaw) * Math.cos(this.pitch);

    if (this.firstPerson) {
      this.cameraPosition.set(this.position.x + Math.sin(this.yaw) * 0.12, eyeY, this.position.y + Math.cos(this.yaw) * 0.12);
    } else {
      const rightX = -Math.cos(this.yaw);
      const rightZ = Math.sin(this.yaw);
      const shoulder = SHOULDER_OFFSET * Math.min(1, this.cameraDistance);
      const d = this.cameraDistance;
      this.cameraPosition.set(
        this.position.x - fx * d + rightX * shoulder,
        eyeY + 0.1 - fy * d,
        this.position.y - fz * d + rightZ * shoulder,
      );
      this.cameraPosition.x = THREE.MathUtils.clamp(this.cameraPosition.x, this.bounds.minX + 0.1, this.bounds.maxX - 0.1);
      this.cameraPosition.z = THREE.MathUtils.clamp(this.cameraPosition.z, this.bounds.minZ + 0.1, this.bounds.maxZ - 0.1);
      this.cameraPosition.y = THREE.MathUtils.clamp(this.cameraPosition.y, FLOOR_Y + 0.25, this.ceilingY - CEILING_MARGIN);
    }
    this.lookTarget.set(this.cameraPosition.x + fx * 4, this.cameraPosition.y + fy * 4, this.cameraPosition.z + fz * 4);
    return { position: this.cameraPosition, target: this.lookTarget };
  }
}
