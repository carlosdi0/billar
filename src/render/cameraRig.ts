import * as THREE from 'three';
import { BALL_RADIUS as R } from '../config';
import { TABLE_EXTENT } from './table';

export type ViewMode = 'aim' | 'top';

const FOV = 45;
const MIN_PITCH = THREE.MathUtils.degToRad(4);
const MAX_PITCH = THREE.MathUtils.degToRad(78);
const MIN_DISTANCE = 0.4;
const MAX_DISTANCE = 2.2;
const SMOOTHING = 6;
const TOP_HEIGHT = 2.1;

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.02, 40);
  mode: ViewMode = 'aim';
  pitch = THREE.MathUtils.degToRad(14);
  distance = 0.85;
  /** While balls roll the aim camera rises to follow the action. */
  followShot = false;

  private readonly position = new THREE.Vector3(-3, 1.5, 0);
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private readonly targetUp = new THREE.Vector3();
  private targetFov = FOV;
  private shotOrigin = new THREE.Vector2();
  private shotAngle = 0;

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  get portrait(): boolean {
    return this.camera.aspect < 1;
  }

  adjust(deltaPitch: number, zoom: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch + deltaPitch, MIN_PITCH, MAX_PITCH);
    this.distance = THREE.MathUtils.clamp(this.distance * zoom, MIN_DISTANCE, MAX_DISTANCE);
  }

  beginShot(x: number, z: number, angle: number): void {
    this.followShot = true;
    this.shotOrigin.set(x, z);
    this.shotAngle = angle;
  }

  snap(): void {
    this.position.copy(this.targetPosition);
    this.look.copy(this.targetLook);
    this.up.copy(this.targetUp);
    this.camera.fov = this.targetFov;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, focusX: number, focusZ: number, angle: number): void {
    if (this.mode === 'top') this.computeTop();
    else if (this.followShot) this.computeShot();
    else this.computeAim(focusX, focusZ, angle);

    const k = 1 - Math.exp(-SMOOTHING * dt);
    this.position.lerp(this.targetPosition, k);
    this.look.lerp(this.targetLook, k);
    this.up.lerp(this.targetUp, k).normalize();
    this.camera.position.copy(this.position);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);
    const fov = THREE.MathUtils.lerp(this.camera.fov, this.targetFov, k);
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private computeAim(x: number, z: number, angle: number): void {
    this.targetFov = this.portrait ? FOV + 12 : FOV;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const horizontal = Math.cos(this.pitch) * this.distance;
    this.targetPosition.set(x - dx * horizontal, R + Math.sin(this.pitch) * this.distance, z - dz * horizontal);
    const ahead = 0.25 + this.distance * 0.25;
    this.targetLook.set(x + dx * ahead, 0, z + dz * ahead);
    this.targetUp.set(0, 1, 0);
  }

  private computeShot(): void {
    this.targetFov = this.portrait ? FOV + 20 : FOV;
    const dx = Math.cos(this.shotAngle);
    const dz = Math.sin(this.shotAngle);
    const cx = this.shotOrigin.x * 0.35;
    const cz = this.shotOrigin.y * 0.35;
    this.targetPosition.set(cx - dx * 2.1, 0.95, cz - dz * 2.1);
    this.targetLook.set(cx + dx * 0.3, 0, cz + dz * 0.3);
    this.targetUp.set(0, 1, 0);
  }

  private computeTop(): void {
    const aspect = this.camera.aspect;
    const margin = 1.16;
    const long = TABLE_EXTENT.x * margin;
    const short = TABLE_EXTENT.z * margin;
    const [halfW, halfH] = this.portrait ? [short, long] : [long, short];
    const tan = Math.max(halfH, halfW / aspect) / TOP_HEIGHT;
    this.targetFov = THREE.MathUtils.radToDeg(2 * Math.atan(tan));
    this.targetPosition.set(0, TOP_HEIGHT, 0.0001);
    this.targetLook.set(0, 0, 0);
    if (this.portrait) this.targetUp.set(1, 0, 0);
    else this.targetUp.set(0, 0, -1);
  }
}
