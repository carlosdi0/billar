import * as THREE from 'three';
import { BALL_RADIUS as R } from '../config';
import type { Ball } from '../physics/simulation';
import type { Pocket } from '../physics/tableGeometry';
import { createBallTexture } from './textures';

interface Drop {
  pocket: Pocket;
  t: number;
  fromX: number;
  fromZ: number;
}

const DROP_TIME = 0.35;
const DROP_DEPTH = 0.12;

export class BallViews {
  readonly group = new THREE.Group();
  readonly meshes: THREE.Mesh[] = [];
  private readonly drops = new Map<number, Drop>();
  private readonly shadowBlobs: THREE.Mesh[] = [];

  constructor(quality: 'low' | 'high') {
    const segments = quality === 'high' ? 40 : 28;
    const geometry = new THREE.SphereGeometry(R, segments, Math.round(segments * 0.66));
    const blobTexture = createBlobTexture();
    const blobMaterial = new THREE.MeshBasicMaterial({
      map: blobTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.55,
    });
    const blobGeometry = new THREE.PlaneGeometry(R * 3.2, R * 3.2).rotateX(-Math.PI / 2);

    for (let id = 0; id < 16; id++) {
      const material = new THREE.MeshPhysicalMaterial({
        map: createBallTexture(id),
        roughness: 0.14,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.06,
        envMapIntensity: 0.9,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.visible = false;
      this.meshes.push(mesh);

      const blob = new THREE.Mesh(blobGeometry, blobMaterial);
      blob.position.y = 0.0008;
      blob.renderOrder = 1;
      blob.visible = false;
      this.shadowBlobs.push(blob);
      this.group.add(mesh, blob);
    }
  }

  startDrop(ball: Ball, pocket: Pocket): void {
    this.drops.set(ball.id, { pocket, t: 0, fromX: ball.x, fromZ: ball.z });
  }

  isDropping(id: number): boolean {
    return this.drops.has(id);
  }

  clearDrops(): void {
    this.drops.clear();
  }

  sync(balls: Ball[], dt: number): void {
    for (const b of balls) {
      const mesh = this.meshes[b.id];
      const blob = this.shadowBlobs[b.id];
      const drop = this.drops.get(b.id);
      if (drop) {
        drop.t += dt;
        const k = Math.min(1, drop.t / DROP_TIME);
        const ease = k * k;
        mesh.position.set(
          THREE.MathUtils.lerp(drop.fromX, drop.pocket.x, Math.min(1, k * 1.6)),
          R - ease * DROP_DEPTH,
          THREE.MathUtils.lerp(drop.fromZ, drop.pocket.z, Math.min(1, k * 1.6)),
        );
        mesh.visible = true;
        blob.visible = false;
        if (k >= 1) {
          this.drops.delete(b.id);
          mesh.visible = false;
        }
        continue;
      }
      mesh.visible = b.onTable;
      blob.visible = b.onTable;
      if (!b.onTable) continue;
      mesh.position.set(b.x, R, b.z);
      mesh.quaternion.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      blob.position.x = b.x;
      blob.position.z = b.z;
    }
  }
}

function createBlobTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.9)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
