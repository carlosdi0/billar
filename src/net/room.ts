import {
  PROTOCOL_VERSION,
  type AimState,
  type ClientMessage,
  type Pose,
  type ServerMessage,
} from './protocol';

export type RoomStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Profile {
  name: string;
  look: number;
}

const DEFAULT_SERVER = 'wss://billar-rooms.carlosdi0.workers.dev';
/** Server close codes after which reconnecting would be pointless or harmful. */
const FINAL_CLOSE_CODES = new Set([1008, 4000, 4001, 4002]);
export const ROOM_SERVER_URL: string = import.meta.env.VITE_ROOM_SERVER ?? DEFAULT_SERVER;

const STREAM_INTERVAL = 100;
/** Unchanged poses are only re-sent this often, so idle players cost almost nothing. */
const POSE_KEEPALIVE = 2_000;
const PING_INTERVAL = 20_000;
const MAX_BACKOFF = 8_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomRoomCode(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function playerToken(): string {
  const key = 'billar.token';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const token = crypto.randomUUID();
    localStorage.setItem(key, token);
    return token;
  } catch {
    return crypto.randomUUID();
  }
}

export class RoomClient {
  onMessage: (message: ServerMessage) => void = () => undefined;
  onStatus: (status: RoomStatus) => void = () => undefined;
  onKicked: (code: number) => void = () => undefined;

  private socket: WebSocket | null = null;
  private status: RoomStatus = 'closed';
  private backoff = 500;
  private closedByUser = false;
  private pingTimer = 0;
  private streamTimer = 0;
  private pendingPose: Pose | null = null;
  private pendingAim: AimState | null = null;
  private pendingPlace: { x: number; z: number } | null = null;
  private face: string | null = null;
  private lastPose = '';
  private lastPoseAt = 0;
  private lastAim = '';

  constructor(
    readonly code: string,
    private profile: Profile,
    private readonly token = playerToken(),
  ) {}

  get connected(): boolean {
    return this.status === 'open';
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.streamTimer);
    this.socket?.close();
    this.setStatus('closed');
  }

  setFace(dataUrl: string | null): void {
    this.face = dataUrl;
    if (dataUrl) this.send({ t: 'face', data: dataUrl });
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** High-frequency updates are coalesced and sent at most every STREAM_INTERVAL ms. */
  streamPose(pose: Pose): void {
    this.pendingPose = pose;
  }

  streamAim(aim: AimState): void {
    this.pendingAim = aim;
  }

  streamPlace(x: number, z: number): void {
    this.pendingPlace = { x, z };
  }

  private open(): void {
    this.setStatus(this.status === 'closed' ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(`${ROOM_SERVER_URL.replace(/\/$/, '')}/room/${encodeURIComponent(this.code)}`);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.backoff = 500;
      this.lastPose = this.lastAim = '';
      this.send({ t: 'hello', v: PROTOCOL_VERSION, token: this.token, name: this.profile.name, look: this.profile.look });
      if (this.face) this.send({ t: 'face', data: this.face });
      this.setStatus('open');
      window.clearInterval(this.pingTimer);
      window.clearInterval(this.streamTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), PING_INTERVAL);
      this.streamTimer = window.setInterval(() => this.flush(), STREAM_INTERVAL);
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        this.onMessage(JSON.parse(event.data) as ServerMessage);
      } catch (error) {
        console.warn('[room] bad message', error);
      }
    });
    socket.addEventListener('close', (event) => {
      window.clearInterval(this.pingTimer);
      window.clearInterval(this.streamTimer);
      if (this.closedByUser || socket !== this.socket) return;
      if (FINAL_CLOSE_CODES.has(event.code)) {
        this.setStatus('closed');
        this.onKicked(event.code);
        return;
      }
      this.setStatus('reconnecting');
      window.setTimeout(() => this.open(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
    });
  }

  private flush(): void {
    const now = performance.now();
    if (this.pendingPose) {
      const p = this.pendingPose;
      const key = `${p.x.toFixed(2)},${p.z.toFixed(2)},${p.yaw.toFixed(2)},${p.action},${p.atTable}`;
      if (key !== this.lastPose || now - this.lastPoseAt > POSE_KEEPALIVE) {
        this.send({ t: 'pose', pose: p });
        this.lastPose = key;
        this.lastPoseAt = now;
      }
    }
    if (this.pendingAim) {
      const a = this.pendingAim;
      const key = `${a.dirX.toFixed(4)},${a.dirZ.toFixed(4)},${a.power.toFixed(2)},${a.side.toFixed(2)},${a.vertical.toFixed(2)},${a.cueX.toFixed(3)},${a.cueZ.toFixed(3)}`;
      if (key !== this.lastAim) {
        this.send({ t: 'aim', aim: a });
        this.lastAim = key;
      }
    }
    if (this.pendingPlace) this.send({ t: 'place', ...this.pendingPlace });
    this.pendingPose = this.pendingAim = this.pendingPlace = null;
  }

  private setStatus(status: RoomStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}
