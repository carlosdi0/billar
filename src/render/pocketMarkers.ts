import * as THREE from 'three';
import { TABLE } from '../config';
import type { Pocket } from '../physics/tableGeometry';

const Y = TABLE.railHeight + 0.003;
const IDLE_COLOR = 0xf6e7c1;
const CALLED_COLOR = 0xffc94a;
const ARROW_HEIGHT = 0.16;

interface Marker {
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
}

/** Rings over the pockets to call (and show) where the 8 has to drop. */
export class PocketMarkers {
  readonly group = new THREE.Group();
  private readonly markers: Marker[];
  private readonly arrow: THREE.Mesh;

  constructor(private readonly pockets: Pocket[]) {
    this.markers = pockets.map((p) => {
      const r = p.holeRadius;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 1.05, r * 1.3, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: IDLE_COLOR, transparent: true, depthTest: false, depthWrite: false }),
      );
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(r * 1.05, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: CALLED_COLOR, transparent: true, opacity: 0.25, depthTest: false, depthWrite: false }),
      );
      ring.position.set(p.x, Y, p.z);
      disc.position.set(p.x, Y, p.z);
      ring.renderOrder = disc.renderOrder = 3;
      this.group.add(ring, disc);
      return { ring, disc };
    });

    this.arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.035, 0.07, 20).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color: CALLED_COLOR, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.arrow.renderOrder = 3;
    this.group.add(this.arrow);
    this.group.visible = false;
  }

  /** Index of the pocket under a table point, if the point is close enough to one. */
  pick(x: number, z: number): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    this.pockets.forEach((p, i) => {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.holeRadius * 1.8 && d < bestDist) {
        best = i;
        bestDist = d;
      }
    });
    return best;
  }

  /**
   * @param choosing show every pocket as a candidate (the shooter is calling)
   * @param called the called pocket, highlighted for everyone
   */
  update(time: number, choosing: boolean, called: number | null): void {
    this.group.visible = choosing || called !== null;
    if (!this.group.visible) return;
    const pulse = 0.5 + 0.5 * Math.sin(time * 4);
    this.markers.forEach((m, i) => {
      const isCalled = i === called;
      m.ring.visible = choosing || isCalled;
      m.ring.material.color.setHex(isCalled ? CALLED_COLOR : IDLE_COLOR);
      m.ring.material.opacity = isCalled ? 0.95 : 0.3 + pulse * 0.35;
      m.disc.visible = isCalled;
    });
    this.arrow.visible = called !== null;
    if (called !== null) {
      const p = this.pockets[called];
      this.arrow.position.set(p.x, Y + ARROW_HEIGHT + Math.sin(time * 3) * 0.02, p.z);
      this.arrow.rotation.y = time * 1.5;
    }
  }
}
