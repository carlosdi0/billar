import { DurableObject } from 'cloudflare:workers';
import {
  MAX_CONNECTIONS,
  MAX_FACE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  MAX_SEATS,
  POSE_ACTIONS,
  PROTOCOL_VERSION,
  ROOM_CODE_PATTERN,
  YOUTUBE_LIST_PATTERN,
  YOUTUBE_VIDEO_PATTERN,
} from '../../src/net/protocol';
import type {
  AimState,
  BallsState,
  MusicState,
  SharedMusic,
  MatchSnapshot,
  PlayerInfo,
  Pose,
  PoseAction,
  ServerMessage,
  ShotMessage,
  ShotResult,
} from '../../src/net/protocol';
import type { Group, MatchState, PlayerIndex } from '../../src/game/rules';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

const SEAT_RELEASE_MS = 2 * 60_000;
const EMPTY_ROOM_TTL_MS = 24 * 60 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 1_000;
const RATE_MAX_MESSAGES = 60;
const MAX_PENDING_SOCKETS = MAX_CONNECTIONS + 4;
const BALL_COUNT = 16;
const MAX_RESULT_MESSAGES = 20;
const MAX_RESULT_TEXT = 200;
const MAX_REASON_LENGTH = 200;
const FALLBACK_NAME = 'Forastero';
const LOOK_COUNT = 8;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const FACE_PATTERN = /^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const RESULT_KINDS = ['info', 'foul', 'good'] as const;
const GROUPS: readonly Group[] = ['solids', 'stripes'];

const CLOSE_POLICY = 1008;
const CLOSE_REPLACED = 4000;
const CLOSE_FULL = 4001;
const CLOSE_VERSION = 4002;

const encoder = new TextEncoder();

// ---------------------------------------------------------------- Worker

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return request.method === 'GET' ? new Response('ok') : new Response('Method Not Allowed', { status: 405 });
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return new Response('Not Found', { status: 404 });

    if (!isAllowedOrigin(request.headers.get('Origin'))) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const code = (match[1] ?? '').toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) return new Response('Invalid room code', { status: 400 });

    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

const PRIVATE_IPV4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

export function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === 'https://carlosdi0.github.io') return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.origin !== origin) return false;
  const host = parsed.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  return PRIVATE_IPV4.test(host) && host.split('.').every((octet) => Number(octet) <= 255);
}

// ---------------------------------------------------------------- Room

interface Attachment {
  conn: string;
  acceptedAt: number;
  token?: string;
  id?: string;
  name?: string;
  look?: number;
  seat?: number | null;
}

interface Member {
  id: string;
  seat: number | null;
  name: string;
  look: number;
  hasFace: boolean;
  disconnectedAt: number | null;
}

interface PendingShot {
  seq: number;
  token: string;
}

interface Live {
  ws: WebSocket;
  att: Attachment & { token: string; id: string };
}

type Members = Record<string, Member>;

const KEY_MEMBERS = 'members';
const KEY_SNAPSHOT = 'snapshot';
const KEY_PENDING = 'pending';
const KEY_EMPTY_SINCE = 'emptySince';
const KEY_MUSIC = 'music';

interface StoredMusic {
  music: MusicState;
  by: string;
  at: number;
}
const faceKey = (token: string) => `face:${token}`;

export class Room extends DurableObject<Env> {
  private members: Members = {};
  private snapshot: MatchSnapshot | null = null;
  private pending: PendingShot | null = null;
  private emptySince: number | null = null;
  private music: StoredMusic | null = null;
  private readonly rate = new Map<string, { windowStart: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get([KEY_MEMBERS, KEY_SNAPSHOT, KEY_PENDING, KEY_EMPTY_SINCE, KEY_MUSIC]);
      this.music = (stored.get(KEY_MUSIC) as StoredMusic | undefined) ?? null;
      this.members = (stored.get(KEY_MEMBERS) as Members | undefined) ?? {};
      this.snapshot = (stored.get(KEY_SNAPSHOT) as MatchSnapshot | undefined) ?? null;
      this.pending = (stored.get(KEY_PENDING) as PendingShot | undefined) ?? null;
      this.emptySince = (stored.get(KEY_EMPTY_SINCE) as number | undefined) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const now = Date.now();
    this.closeStaleHandshakes(now);

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    const att: Attachment = { conn: randomId(12), acceptedAt: now };
    server.serializeAttachment(att);

    if (this.openSockets().length > MAX_PENDING_SOCKETS) {
      this.reject(server, 'full', 'Room is full', CLOSE_FULL);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = readAttachment(ws);
    if (!att) return;
    if (this.isRateLimited(att.conn)) return;

    const msg = parseMessage(raw);
    if (!att.token) {
      if (!msg || msg.t !== 'hello') {
        this.reject(ws, 'bad', 'Expected hello', CLOSE_POLICY);
        return;
      }
      await this.handleHello(ws, att, msg);
      return;
    }

    if (!msg) {
      this.sendError(ws, 'bad', 'Malformed message');
      return;
    }
    const live: Live = { ws, att: att as Live['att'] };
    switch (msg.t) {
      case 'pose':
        return this.handlePose(live, msg);
      case 'aim':
        return this.handleAim(live, msg);
      case 'place':
        return this.handlePlace(live, msg);
      case 'face':
        return this.handleFace(live, msg);
      case 'start':
        return this.handleStart(live, msg);
      case 'shot':
        return this.handleShot(live, msg);
      case 'result':
        return this.handleResult(live, msg);
      case 'music':
        return this.handleMusic(live, msg);
      case 'ping':
        this.send(ws, { t: 'pong' });
        return;
      default:
        this.sendError(ws, 'bad', 'Unknown message');
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // already closed
    }
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const live = this.liveSockets();

    if (live.length === 0 && this.emptySince !== null && now - this.emptySince >= EMPTY_ROOM_TTL_MS) {
      for (const { ws } of this.openSockets()) this.safeClose(ws, 1001, 'Room expired');
      await this.ctx.storage.deleteAll();
      this.members = {};
      this.snapshot = null;
      this.pending = null;
      this.emptySince = null;
      return;
    }

    if (!this.matchInProgress()) {
      const connected = new Set(live.map((l) => l.att.token));
      const released: string[] = [];
      for (const [token, member] of Object.entries(this.members)) {
        if (connected.has(token) || member.disconnectedAt === null) continue;
        if (now - member.disconnectedAt >= SEAT_RELEASE_MS) released.push(token);
      }
      if (released.length > 0) {
        for (const token of released) delete this.members[token];
        await this.ctx.storage.put(KEY_MEMBERS, this.members);
        await this.ctx.storage.delete(released.map(faceKey));
        this.broadcastPlayers();
      }
    }

    await this.scheduleAlarm();
  }

  // ------------------------------------------------------------ handshake

  private async handleHello(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    if (msg.v !== PROTOCOL_VERSION) {
      this.reject(ws, 'version', `Protocol version ${PROTOCOL_VERSION} required`, CLOSE_VERSION);
      return;
    }
    const token = msg.token;
    const look = msg.look;
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      this.reject(ws, 'bad', 'Invalid token', CLOSE_POLICY);
      return;
    }
    if (typeof look !== 'number' || !Number.isInteger(look) || look < 0 || look >= LOOK_COUNT) {
      this.reject(ws, 'bad', 'Invalid look', CLOSE_POLICY);
      return;
    }
    const name = sanitizeName(msg.name);

    const others = this.liveSockets().filter((l) => l.att.token !== token);
    if (others.length >= MAX_CONNECTIONS) {
      this.reject(ws, 'full', 'Room is full', CLOSE_FULL);
      return;
    }

    for (const previous of this.liveSockets()) {
      if (previous.att.token === token && previous.att.conn !== att.conn) {
        previous.ws.serializeAttachment({ conn: previous.att.conn, acceptedAt: previous.att.acceptedAt });
        this.safeClose(previous.ws, CLOSE_REPLACED, 'Replaced by a new connection');
      }
    }

    let member = this.members[token];
    if (member) {
      member.name = name;
      member.look = look;
      member.disconnectedAt = null;
    } else {
      member = {
        id: this.uniqueMemberId(),
        seat: this.firstFreeSeat(),
        name,
        look,
        hasFace: false,
        disconnectedAt: null,
      };
      this.members[token] = member;
    }

    const full: Attachment = { ...att, token, id: member.id, name, look, seat: member.seat };
    ws.serializeAttachment(full);

    this.emptySince = null;
    await this.ctx.storage.put({ [KEY_MEMBERS]: this.members });
    await this.ctx.storage.delete(KEY_EMPTY_SINCE);

    this.send(ws, { t: 'welcome', you: member.id, players: this.playerList(), snapshot: this.snapshot, music: this.sharedMusic() });

    const faceTokens = Object.entries(this.members).filter(([, m]) => m.hasFace);
    if (faceTokens.length > 0) {
      const faces = await this.ctx.storage.get<string>(faceTokens.map(([t]) => faceKey(t)));
      for (const [t, m] of faceTokens) {
        const data = faces.get(faceKey(t));
        if (data) this.send(ws, { t: 'face', id: m.id, data });
      }
    }

    this.broadcastPlayers();
    await this.scheduleAlarm();
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    const att = readAttachment(ws);
    this.rate.delete(att?.conn ?? '');
    ws.serializeAttachment(att ? { conn: att.conn, acceptedAt: att.acceptedAt } : null);
    const token = att?.token;
    if (!token) return;

    const member = this.members[token];
    const stillConnected = this.liveSockets().some((l) => l.att.token === token && l.att.conn !== att.conn);
    if (!member || stillConnected) return;

    const now = Date.now();
    if (member.seat === null) {
      delete this.members[token];
      await this.ctx.storage.delete(faceKey(token));
    } else {
      member.disconnectedAt = now;
    }
    await this.ctx.storage.put(KEY_MEMBERS, this.members);

    if (this.liveSockets().length === 0) {
      this.emptySince = now;
      await this.ctx.storage.put(KEY_EMPTY_SINCE, now);
    }

    this.broadcastPlayers();
    await this.scheduleAlarm();
  }

  // ------------------------------------------------------------ ephemeral relays

  private handlePose(from: Live, msg: Record<string, unknown>): void {
    const pose = parsePose(msg.pose);
    if (!pose) return this.sendError(from.ws, 'bad', 'Invalid pose');
    this.broadcast({ t: 'pose', id: from.att.id, pose }, from.ws);
  }

  private handleAim(from: Live, msg: Record<string, unknown>): void {
    const aim = parseAim(msg.aim);
    if (!aim) return this.sendError(from.ws, 'bad', 'Invalid aim');
    this.broadcast({ t: 'aim', id: from.att.id, aim }, from.ws);
  }

  private handlePlace(from: Live, msg: Record<string, unknown>): void {
    if (!isFiniteNumber(msg.x) || !isFiniteNumber(msg.z)) return this.sendError(from.ws, 'bad', 'Invalid place');
    this.broadcast({ t: 'place', id: from.att.id, x: msg.x, z: msg.z }, from.ws);
  }

  private async handleFace(from: Live, msg: Record<string, unknown>): Promise<void> {
    const data = msg.data;
    if (typeof data !== 'string' || data.length > MAX_FACE_BYTES || !FACE_PATTERN.test(data)) {
      return this.sendError(from.ws, 'bad', 'Invalid face');
    }
    const member = this.members[from.att.token];
    if (!member) return this.sendError(from.ws, 'forbidden', 'Unknown member');

    member.hasFace = true;
    await this.ctx.storage.put({ [faceKey(from.att.token)]: data, [KEY_MEMBERS]: this.members });
    this.broadcast({ t: 'face', id: from.att.id, data }, from.ws);
    this.broadcastPlayers();
  }

  private async handleMusic(from: Live, msg: Record<string, unknown>): Promise<void> {
    if (msg.music === null) {
      this.music = null;
      await this.ctx.storage.delete(KEY_MUSIC);
    } else {
      const music = parseMusic(msg.music);
      if (!music) return this.sendError(from.ws, 'bad', 'Invalid music');
      this.music = { music, by: from.att.id, at: Date.now() };
      await this.ctx.storage.put(KEY_MUSIC, this.music);
    }
    this.broadcast({ t: 'music', shared: this.sharedMusic() }, from.ws);
  }

  private sharedMusic(): SharedMusic | null {
    const m = this.music;
    return m ? { music: m.music, by: m.by, age: Date.now() - m.at } : null;
  }

  // ------------------------------------------------------------ match flow

  private async handleStart(from: Live, msg: Record<string, unknown>): Promise<void> {
    const snapshot = parseSnapshot(msg.snapshot);
    if (!snapshot) return this.sendError(from.ws, 'bad', 'Invalid snapshot');

    const players = this.playerList();
    const host = players.find((p) => p.host);
    const seatedConnected = players.filter((p) => p.connected && p.seat !== null).length;
    if (!host || host.id !== from.att.id) return this.sendError(from.ws, 'forbidden', 'Only the host can start');
    if (seatedConnected < 2) return this.sendError(from.ws, 'forbidden', 'At least two seated players required');

    await this.setSnapshot(snapshot, null);
    this.broadcast({ t: 'start', snapshot });
  }

  private async handleShot(from: Live, msg: Record<string, unknown>): Promise<void> {
    const shot = parseShot(msg.shot);
    if (!shot) return this.sendError(from.ws, 'bad', 'Invalid shot');

    const snapshot = this.snapshot;
    const seat = this.members[from.att.token]?.seat ?? null;
    if (!snapshot || snapshot.over) return this.sendError(from.ws, 'forbidden', 'No match in progress');
    if (seat === null || seat !== snapshot.match.current) return this.sendError(from.ws, 'forbidden', 'Not your turn');
    if (shot.seq !== snapshot.shotSeq + 1) return this.sendError(from.ws, 'forbidden', 'Unexpected shot sequence');
    if (this.pending && this.pending.token !== from.att.token) {
      return this.sendError(from.ws, 'forbidden', 'Another shot is pending');
    }

    this.pending = { seq: shot.seq, token: from.att.token };
    await this.ctx.storage.put(KEY_PENDING, this.pending);
    this.broadcast({ t: 'shot', id: from.att.id, shot }, from.ws);
  }

  private async handleResult(from: Live, msg: Record<string, unknown>): Promise<void> {
    const result = parseResult(msg.result);
    if (!result) return this.sendError(from.ws, 'bad', 'Invalid result');

    const pending = this.pending;
    if (!pending || pending.token !== from.att.token || pending.seq !== result.seq) {
      return this.sendError(from.ws, 'forbidden', 'No matching pending shot');
    }
    if (result.snapshot.shotSeq !== result.seq) return this.sendError(from.ws, 'bad', 'Snapshot sequence mismatch');

    await this.setSnapshot(result.snapshot, null);
    this.broadcast({ t: 'result', id: from.att.id, result }, from.ws);
  }

  private async setSnapshot(snapshot: MatchSnapshot, pending: PendingShot | null): Promise<void> {
    const wasInProgress = this.matchInProgress();
    this.snapshot = snapshot;
    this.pending = pending;

    if (wasInProgress && snapshot.over) {
      const now = Date.now();
      for (const member of Object.values(this.members)) {
        if (member.disconnectedAt !== null) member.disconnectedAt = now;
      }
    }

    await this.ctx.storage.put({ [KEY_SNAPSHOT]: snapshot, [KEY_MEMBERS]: this.members });
    await this.ctx.storage.delete(KEY_PENDING);
    await this.scheduleAlarm();
  }

  // ------------------------------------------------------------ state helpers

  private matchInProgress(): boolean {
    return this.snapshot !== null && this.snapshot.over === null;
  }

  private openSockets(): { ws: WebSocket; att: Attachment }[] {
    const result: { ws: WebSocket; att: Attachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = readAttachment(ws);
      if (att) result.push({ ws, att });
    }
    return result;
  }

  private liveSockets(): Live[] {
    return this.openSockets().filter((s): s is Live => typeof s.att.token === 'string' && typeof s.att.id === 'string');
  }

  private playerList(): PlayerInfo[] {
    const connected = new Set(this.liveSockets().map((l) => l.att.token));
    const players = Object.entries(this.members).map(([token, m]) => ({
      id: m.id,
      name: m.name,
      look: m.look,
      seat: m.seat,
      host: false,
      connected: connected.has(token),
      hasFace: m.hasFace,
    }));
    players.sort((a, b) => (a.seat ?? MAX_SEATS) - (b.seat ?? MAX_SEATS) || a.id.localeCompare(b.id));
    const host = players.find((p) => p.connected && p.seat !== null);
    if (host) host.host = true;
    return players;
  }

  private firstFreeSeat(): number | null {
    const taken = new Set(Object.values(this.members).map((m) => m.seat));
    for (let seat = 0; seat < MAX_SEATS; seat++) if (!taken.has(seat)) return seat;
    return null;
  }

  private uniqueMemberId(): string {
    const used = new Set(Object.values(this.members).map((m) => m.id));
    let id = randomId(6);
    while (used.has(id)) id = randomId(6);
    return id;
  }

  private async scheduleAlarm(): Promise<void> {
    const deadlines: number[] = [];
    if (!this.matchInProgress()) {
      const connected = new Set(this.liveSockets().map((l) => l.att.token));
      for (const [token, m] of Object.entries(this.members)) {
        if (m.disconnectedAt !== null && !connected.has(token)) deadlines.push(m.disconnectedAt + SEAT_RELEASE_MS);
      }
    }
    if (this.emptySince !== null) deadlines.push(this.emptySince + EMPTY_ROOM_TTL_MS);

    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...deadlines));
    }
  }

  private closeStaleHandshakes(now: number): void {
    for (const { ws, att } of this.openSockets()) {
      if (!att.token && now - att.acceptedAt > HELLO_TIMEOUT_MS) this.safeClose(ws, CLOSE_POLICY, 'Handshake timeout');
    }
  }

  private isRateLimited(conn: string): boolean {
    const now = Date.now();
    const entry = this.rate.get(conn);
    if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
      this.rate.set(conn, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > RATE_MAX_MESSAGES;
  }

  // ------------------------------------------------------------ transport

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket went away; close handler cleans up
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(msg);
    for (const { ws } of this.liveSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        // ignore
      }
    }
  }

  private broadcastPlayers(): void {
    this.broadcast({ t: 'players', players: this.playerList() });
  }

  private sendError(ws: WebSocket, code: 'full' | 'version' | 'bad' | 'forbidden', message: string): void {
    this.send(ws, { t: 'error', code, message });
  }

  private reject(ws: WebSocket, code: 'full' | 'version' | 'bad' | 'forbidden', message: string, closeCode: number): void {
    this.sendError(ws, code, message);
    this.safeClose(ws, closeCode, message);
  }

  private safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

// ---------------------------------------------------------------- validation

function readAttachment(ws: WebSocket): Attachment | null {
  const att = ws.deserializeAttachment() as Attachment | null;
  return att && typeof att.conn === 'string' ? att : null;
}

function parseMessage(raw: string | ArrayBuffer): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_MESSAGE_BYTES || encoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(value) && typeof value.t === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return FALLBACK_NAME;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const clipped = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('').trim();
  return clipped || FALLBACK_NAME;
}

function parsePose(value: unknown): Pose | null {
  if (!isRecord(value)) return null;
  const { x, z, yaw, action, speed, atTable } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(z) || !isFiniteNumber(yaw) || !isFiniteNumber(speed)) return null;
  if (typeof action !== 'string' || !POSE_ACTIONS.includes(action as PoseAction)) return null;
  if (typeof atTable !== 'boolean') return null;
  return { x, z, yaw, action: action as PoseAction, speed, atTable };
}

function parseAim(value: unknown): AimState | null {
  if (!isRecord(value)) return null;
  const { dirX, dirZ, power, side, vertical, cueX, cueZ } = value;
  const nums = [dirX, dirZ, power, side, vertical, cueX, cueZ];
  if (!nums.every(isFiniteNumber)) return null;
  return {
    dirX: dirX as number,
    dirZ: dirZ as number,
    power: power as number,
    side: side as number,
    vertical: vertical as number,
    cueX: cueX as number,
    cueZ: cueZ as number,
  };
}

function parseBalls(value: unknown): BallsState | null {
  if (!Array.isArray(value) || value.length !== BALL_COUNT) return null;
  const balls: BallsState = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const [x, z, on] = entry as unknown[];
    if (!isFiniteNumber(x) || !isFiniteNumber(z) || (on !== 0 && on !== 1)) return null;
    balls.push([x, z, on]);
  }
  return balls;
}

function parseGroup(value: unknown): Group | null | undefined {
  if (value === null) return null;
  return GROUPS.includes(value as Group) ? (value as Group) : undefined;
}

function parseMatch(value: unknown): MatchState | null {
  if (!isRecord(value)) return null;
  const { current, groups, isBreak, ballInHand, kitchenOnly, winner } = value;
  if (!isInteger(current) || current < 0 || current >= MAX_SEATS) return null;
  if (!Array.isArray(groups) || groups.length !== 2) return null;
  const g0 = parseGroup(groups[0]);
  const g1 = parseGroup(groups[1]);
  if (g0 === undefined || g1 === undefined) return null;
  if (typeof isBreak !== 'boolean' || typeof ballInHand !== 'boolean' || typeof kitchenOnly !== 'boolean') return null;
  if (winner !== null && (!isInteger(winner) || winner < 0 || winner >= MAX_SEATS)) return null;
  return {
    current: current as PlayerIndex,
    groups: [g0, g1],
    isBreak,
    ballInHand,
    kitchenOnly,
    winner: winner as PlayerIndex | null,
  };
}

function parseSnapshot(value: unknown): MatchSnapshot | null {
  if (!isRecord(value)) return null;
  const match = parseMatch(value.match);
  const balls = parseBalls(value.balls);
  const { assisted, shotSeq, over } = value;
  if (!match || !balls || typeof assisted !== 'boolean' || !isInteger(shotSeq) || shotSeq < 0) return null;

  let parsedOver: MatchSnapshot['over'] = null;
  if (over !== null) {
    if (!isRecord(over) || !isInteger(over.winner) || typeof over.reason !== 'string') return null;
    parsedOver = { winner: over.winner, reason: over.reason.slice(0, MAX_REASON_LENGTH) };
  }
  return { match, balls, assisted, shotSeq, over: parsedOver };
}

function parseShot(value: unknown): ShotMessage | null {
  if (!isRecord(value)) return null;
  const before = parseBalls(value.before);
  const { seq, dirX, dirZ, speed, side, vertical } = value;
  if (!before || !isInteger(seq)) return null;
  if (![dirX, dirZ, speed, side, vertical].every(isFiniteNumber)) return null;
  return {
    seq,
    before,
    dirX: dirX as number,
    dirZ: dirZ as number,
    speed: speed as number,
    side: side as number,
    vertical: vertical as number,
  };
}

function parseResult(value: unknown): ShotResult | null {
  if (!isRecord(value)) return null;
  const snapshot = parseSnapshot(value.snapshot);
  const { seq, messages } = value;
  if (!snapshot || !isInteger(seq) || !Array.isArray(messages) || messages.length > MAX_RESULT_MESSAGES) return null;

  const parsed: ShotResult['messages'] = [];
  for (const m of messages) {
    if (!isRecord(m) || typeof m.text !== 'string') return null;
    const kind = RESULT_KINDS.find((k) => k === m.kind);
    if (!kind) return null;
    parsed.push({ text: m.text.slice(0, MAX_RESULT_TEXT), kind });
  }
  return { seq, snapshot, messages: parsed };
}

function parseMusic(value: unknown): MusicState | null {
  if (!isRecord(value)) return null;
  const { list, video, index, time, playing } = value;
  if (list !== null && (typeof list !== 'string' || !YOUTUBE_LIST_PATTERN.test(list))) return null;
  if (video !== null && (typeof video !== 'string' || !YOUTUBE_VIDEO_PATTERN.test(video))) return null;
  if (list === null && video === null) return null;
  if (!isInteger(index) || index < 0 || index > 5000) return null;
  if (!isFiniteNumber(time) || time < 0 || time > 86_400) return null;
  if (typeof playing !== 'boolean') return null;
  return { list, video, index, time, playing };
}

function randomId(length: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (const b of bytes) id += alphabet[b % alphabet.length];
  return id;
}
