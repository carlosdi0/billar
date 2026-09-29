import * as THREE from 'three';
import { TABLE } from '../config';
import type { Pose } from '../net/protocol';
import { createCharacter, createFaceTexture, DEFAULT_LOOKS, type Character, type CharacterAction, type CharacterLook, type CharacterQuality } from './character';
import { SpeechBubble } from './speechBubble';
import { TABLE_EXTENT } from './table';

const FLOOR_Y = -TABLE.surfaceHeight;
const POSITION_K = 12;
const YAW_K = 12;
const TELEPORT_DISTANCE = 3;
const COLLIDER_RADIUS = 0.3;
const TABLE_STANDOFF = 0.3;
const SPEED_SMOOTHING = 8;

const LABEL_W = 320;
const LABEL_H = 80;
const LABEL_ASPECT = LABEL_W / LABEL_H;
const LABEL_HEIGHT_MIN = 0.07;
const LABEL_HEIGHT_MAX = 0.26;
const LABEL_DISTANCE_K = 0.045;
const LABEL_HIDE_DISTANCE = 0.6;
const LABEL_LIFT = 0.28;

const SEAT_COLORS = ['#e0b44a', '#c8443a', '#4a7bd0', '#5aa04e'];
const SPECTATOR_COLOR = '#8a8a8a';
const GHOST_GREY = '#7d7a75';

interface Remote {
  id: string;
  name: string;
  look: number;
  seat: number | null;
  connected: boolean;
  character: Character;
  label: THREE.Sprite;
  labelTexture: THREE.CanvasTexture;
  labelCanvas: HTMLCanvasElement;
  bubble: SpeechBubble;
  faceTexture: THREE.Texture | null;
  faceToken: number;
  pose: Pose | null;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  placed: boolean;
}

const tmpVec = new THREE.Vector3();

function ghostLook(look: CharacterLook): CharacterLook {
  return { ...look, skin: GHOST_GREY, shirt: GHOST_GREY, vest: '#5d5a56', pants: '#4a4844', hatColor: '#5d5a56', bandana: undefined, hair: '#3a3835', boots: '#3a3835' };
}

function lookFor(index: number, connected: boolean): CharacterLook {
  const base = DEFAULT_LOOKS[((index % DEFAULT_LOOKS.length) + DEFAULT_LOOKS.length) % DEFAULT_LOOKS.length];
  return connected ? base : ghostLook(base);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawLabel(r: Remote): void {
  const ctx = r.labelCanvas.getContext('2d');
  if (!ctx) return;
  const text = r.connected ? r.name : `${r.name} (desconectado)`;
  ctx.clearRect(0, 0, LABEL_W, LABEL_H);
  roundRect(ctx, 4, 4, LABEL_W - 8, LABEL_H - 8, 16);
  ctx.fillStyle = r.connected ? 'rgba(38, 24, 15, 0.82)' : 'rgba(38, 34, 32, 0.7)';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = r.connected ? '#b08e52' : '#7d7a75';
  ctx.stroke();

  const dot = r.seat === null || !r.connected ? SPECTATOR_COLOR : SEAT_COLORS[r.seat % SEAT_COLORS.length];
  ctx.beginPath();
  ctx.arc(34, LABEL_H / 2, 12, 0, Math.PI * 2);
  ctx.fillStyle = dot;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.stroke();

  let size = 34;
  const maxWidth = LABEL_W - 84;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  do {
    ctx.font = `${size}px 'Rye', Georgia, serif`;
    size -= 2;
  } while (ctx.measureText(text).width > maxWidth && size > 12);
  ctx.fillStyle = r.connected ? '#f0dfb8' : '#b5b0a6';
  ctx.fillText(text, 58, LABEL_H / 2 + 2, maxWidth);
  r.labelTexture.needsUpdate = true;
}

function shortestAngle(from: number, to: number): number {
  const d = (to - from) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d;
}

export class RemotePlayers {
  readonly group = new THREE.Group();
  private readonly players = new Map<string, Remote>();
  private readonly colliderList: { x: number; z: number; r: number }[] = [];
  private readonly quality: CharacterQuality;
  private shootingId: string | null = null;
  private shootX = 0;
  private shootZ = 0;
  private shootYaw = 0;
  private time = 0;

  constructor(quality: 'low' | 'high') {
    this.quality = quality;
    this.group.name = 'remote-players';
  }

  upsert(id: string, name: string, look: number, seat: number | null, connected: boolean): void {
    let r = this.players.get(id);
    if (!r) {
      const character = createCharacter(lookFor(look, connected), { quality: this.quality, seed: this.players.size * 1.37 + 0.5 });
      character.setDrinkProp('whisky');
      character.setCastShadow(true);
      character.object.position.y = FLOOR_Y;
      character.object.visible = false;
      this.group.add(character.object);

      const labelCanvas = document.createElement('canvas');
      labelCanvas.width = LABEL_W;
      labelCanvas.height = LABEL_H;
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      labelTexture.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false }));
      label.renderOrder = 10;
      label.visible = false;
      const bubble = new SpeechBubble();
      this.group.add(label, bubble.sprite);

      r = { id, name, look, seat, connected, character, label, labelTexture, labelCanvas, bubble, faceTexture: null, faceToken: 0, pose: null, x: 0, z: 0, yaw: 0, speed: 0, placed: false };
      this.players.set(id, r);
      drawLabel(r);
      return;
    }
    const labelChanged = r.name !== name || r.seat !== seat || r.connected !== connected;
    const lookChanged = r.look !== look || r.connected !== connected;
    r.name = name;
    r.seat = seat;
    r.look = look;
    r.connected = connected;
    if (lookChanged) r.character.setLook(lookFor(look, connected));
    if (labelChanged) drawLabel(r);
  }

  remove(id: string): void {
    const r = this.players.get(id);
    if (!r) return;
    r.faceToken++;
    this.group.remove(r.character.object);
    this.group.remove(r.label, r.bubble.sprite);
    r.bubble.dispose();
    r.character.dispose();
    r.faceTexture?.dispose();
    r.labelTexture.dispose();
    r.label.material.dispose();
    this.players.delete(id);
    if (this.shootingId === id) this.shootingId = null;
  }

  setFace(id: string, dataUrl: string | null): void {
    const r = this.players.get(id);
    if (!r) return;
    const token = ++r.faceToken;
    if (!dataUrl) {
      this.applyFace(r, null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const current = this.players.get(id);
      if (!current || current.faceToken !== token) return;
      this.applyFace(current, createFaceTexture(img));
    };
    img.src = dataUrl;
  }

  private applyFace(r: Remote, texture: THREE.Texture | null): void {
    r.character.setFace(texture);
    r.faceTexture?.dispose();
    r.faceTexture = texture;
  }

  say(id: string, text: string): void {
    this.players.get(id)?.bubble.say(text);
  }

  setPose(id: string, pose: Pose): void {
    const r = this.players.get(id);
    if (r) r.pose = pose;
  }

  setShooting(id: string | null, cueX: number, cueZ: number, dirX: number, dirZ: number): void {
    this.shootingId = id;
    if (id === null) return;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) {
      this.shootingId = null;
      return;
    }
    const dx = -dirX / len;
    const dz = -dirZ / len;
    let t = Infinity;
    if (dx > 1e-9) t = Math.min(t, (TABLE_EXTENT.x - cueX) / dx);
    else if (dx < -1e-9) t = Math.min(t, (-TABLE_EXTENT.x - cueX) / dx);
    if (dz > 1e-9) t = Math.min(t, (TABLE_EXTENT.z - cueZ) / dz);
    else if (dz < -1e-9) t = Math.min(t, (-TABLE_EXTENT.z - cueZ) / dz);
    t = Math.max(0, t) + TABLE_STANDOFF;
    this.shootX = cueX + dx * t;
    this.shootZ = cueZ + dz * t;
    this.shootYaw = Math.atan2(cueX - this.shootX, cueZ - this.shootZ);
  }

  colliders(): { x: number; z: number; r: number }[] {
    const list = this.colliderList;
    if (list.length !== this.players.size) {
      while (list.length < this.players.size) list.push({ x: 0, z: 0, r: COLLIDER_RADIUS });
      list.length = this.players.size;
    }
    let i = 0;
    for (const r of this.players.values()) {
      const c = list[i++];
      c.x = r.x;
      c.z = r.z;
    }
    return list;
  }

  update(dt: number, time: number, camera: THREE.Camera): void {
    this.time = time;
    const posAlpha = 1 - Math.exp(-POSITION_K * dt);
    const yawAlpha = 1 - Math.exp(-YAW_K * dt);
    const speedAlpha = Math.min(1, dt * SPEED_SMOOTHING);
    camera.getWorldPosition(tmpVec);
    const camX = tmpVec.x;
    const camY = tmpVec.y;
    const camZ = tmpVec.z;

    for (const r of this.players.values()) {
      const shooting = r.id === this.shootingId;
      if (!r.pose && !shooting) {
        r.character.object.visible = false;
        r.label.visible = false;
        r.bubble.update(dt, r.x, FLOOR_Y, r.z, tmpVec, false);
        continue;
      }

      let tx: number;
      let tz: number;
      let tyaw: number;
      let action: CharacterAction;
      let poseSpeed = 0;
      if (shooting) {
        tx = this.shootX;
        tz = this.shootZ;
        tyaw = this.shootYaw;
        action = 'lean';
      } else {
        const p = r.pose as Pose;
        tx = p.x;
        tz = p.z;
        tyaw = p.yaw;
        action = p.atTable ? 'lean' : p.action;
        poseSpeed = p.speed;
      }

      const prevX = r.x;
      const prevZ = r.z;
      if (!r.placed || Math.hypot(tx - r.x, tz - r.z) > TELEPORT_DISTANCE) {
        r.x = tx;
        r.z = tz;
        r.yaw = tyaw;
        r.placed = true;
        r.speed = 0;
        r.character.setAction(action, true);
      } else {
        r.x += (tx - r.x) * posAlpha;
        r.z += (tz - r.z) * posAlpha;
        r.yaw += shortestAngle(r.yaw, tyaw) * yawAlpha;
        if (dt > 0) r.speed += (Math.hypot(r.x - prevX, r.z - prevZ) / dt - r.speed) * speedAlpha;
      }

      const moving = action === 'walk' || action === 'run';
      r.character.setAction(action);
      r.character.setSpeed(moving ? Math.max(r.speed, poseSpeed * 0.5) : 0);

      const obj = r.character.object;
      obj.visible = true;
      obj.position.set(r.x, FLOOR_Y, r.z);
      obj.rotation.y = r.yaw;
      r.character.update(dt, this.time);

      const dx = r.x - camX;
      const dz = r.z - camZ;
      const dy = FLOOR_Y + r.character.height + LABEL_LIFT - camY;
      const dist = Math.hypot(dx, dy, dz);
      const labelY = FLOOR_Y + r.character.height + LABEL_LIFT;
      const h = THREE.MathUtils.clamp(dist * LABEL_DISTANCE_K, LABEL_HEIGHT_MIN, LABEL_HEIGHT_MAX);
      r.bubble.update(dt, r.x, labelY + h * 0.6, r.z, tmpVec);
      if (dist < LABEL_HIDE_DISTANCE) {
        r.label.visible = false;
        continue;
      }
      r.label.visible = true;
      r.label.scale.set(h * LABEL_ASPECT, h, 1);
      r.label.position.set(r.x, labelY, r.z);
    }
  }
}
