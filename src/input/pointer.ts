import * as THREE from 'three';
import { BALL_RADIUS as R } from '../config';
import type { CameraRig } from '../render/cameraRig';

export interface PointerHost {
  canAim(): boolean;
  canPlaceCue(): boolean;
  cuePosition(): { x: number; z: number };
  placeCue(x: number, z: number): void;
  rotateAim(delta: number): void;
  aimAt(x: number, z: number): void;
  toggleView(): void;
  unlockAudio(): void;
}

const ROTATE_SPEED = 0.0045;
const PITCH_SPEED = 0.004;
const PICK_RADIUS = R * 3.2;

type Drag = 'none' | 'aim' | 'place' | 'pinch';

export class PointerControls {
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -R);
  private readonly ndc = new THREE.Vector2();
  private drag: Drag = 'none';
  private pinchDistance = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly rig: CameraRig,
    private readonly host: PointerHost,
  ) {
    element.addEventListener('pointerdown', (e) => this.down(e));
    element.addEventListener('pointermove', (e) => this.move(e));
    element.addEventListener('pointerup', (e) => this.up(e));
    element.addEventListener('pointercancel', (e) => this.up(e));
    element.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e));
  }

  private tablePoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.element.getBoundingClientRect();
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.rig.camera);
    return this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  private down(e: PointerEvent): void {
    this.host.unlockAudio();
    this.element.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = 'pinch';
      return;
    }
    if (!this.host.canAim()) {
      this.drag = 'none';
      return;
    }

    const point = this.tablePoint(e.clientX, e.clientY);
    const cue = this.host.cuePosition();
    if (point && this.host.canPlaceCue() && Math.hypot(point.x - cue.x, point.z - cue.z) < PICK_RADIUS) {
      this.drag = 'place';
      return;
    }
    this.drag = 'aim';
    if (this.rig.mode === 'top' && point) this.host.aimAt(point.x, point.z);
  }

  private move(e: PointerEvent): void {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) return;
    const dx = e.clientX - previous.x;
    const dy = e.clientY - previous.y;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.drag === 'pinch' && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchDistance > 0) this.rig.adjust(0, this.pinchDistance / distance);
      this.pinchDistance = distance;
      return;
    }
    if (!this.host.canAim()) return;

    if (this.drag === 'place') {
      const point = this.tablePoint(e.clientX, e.clientY);
      if (point) this.host.placeCue(point.x, point.z);
    } else if (this.drag === 'aim') {
      if (this.rig.mode === 'top') {
        const point = this.tablePoint(e.clientX, e.clientY);
        if (point) this.host.aimAt(point.x, point.z);
      } else {
        const fine = e.shiftKey ? 0.15 : 1;
        this.host.rotateAim(dx * ROTATE_SPEED * fine);
        this.rig.adjust(dy * PITCH_SPEED * fine, 1);
      }
    }
  }

  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.drag = 'none';
    else if (this.drag === 'pinch') this.drag = 'none';
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    this.rig.adjust(0, Math.exp(e.deltaY * 0.0012));
  }

  private key(e: KeyboardEvent): void {
    if (e.key === 'c' || e.key === 'C') {
      this.host.toggleView();
      return;
    }
    if (!this.host.canAim()) return;
    const step = e.shiftKey ? 0.0015 : 0.012;
    if (e.key === 'ArrowLeft') this.host.rotateAim(-step);
    else if (e.key === 'ArrowRight') this.host.rotateAim(step);
    else if (e.key === 'ArrowUp') this.rig.adjust(-0.03, 1);
    else if (e.key === 'ArrowDown') this.rig.adjust(0.03, 1);
    else return;
    e.preventDefault();
  }
}
