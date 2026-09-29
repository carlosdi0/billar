import type { MatchState } from '../game/rules';

export const PROTOCOL_VERSION = 1;
export const MAX_SEATS = 4;
export const MAX_CONNECTIONS = 8;
export const MAX_NAME_LENGTH = 16;
export const MAX_FACE_BYTES = 60_000;
export const MAX_MESSAGE_BYTES = 80_000;

export type PoseAction = 'idle' | 'walk' | 'run' | 'lean' | 'wave' | 'drink';
export const POSE_ACTIONS: readonly PoseAction[] = ['idle', 'walk', 'run', 'lean', 'wave', 'drink'];

export interface PlayerInfo {
  id: string;
  name: string;
  look: number;
  /** 0-3 for players, null for spectators. */
  seat: number | null;
  host: boolean;
  connected: boolean;
  hasFace: boolean;
}

export interface Pose {
  x: number;
  z: number;
  yaw: number;
  action: PoseAction;
  speed: number;
  atTable: boolean;
}

export interface AimState {
  dirX: number;
  dirZ: number;
  power: number;
  side: number;
  vertical: number;
  cueX: number;
  cueZ: number;
}

/** 16 entries indexed by ball id: [x, z, onTable ? 1 : 0]. */
export type BallsState = [number, number, number][];

export interface MatchSnapshot {
  match: MatchState;
  balls: BallsState;
  assisted: boolean;
  /** Increments with every shot; stale results are ignored. */
  shotSeq: number;
  over: { winner: number; reason: string } | null;
}

export interface ShotMessage {
  seq: number;
  before: BallsState;
  dirX: number;
  dirZ: number;
  speed: number;
  side: number;
  vertical: number;
}

export interface ShotResult {
  seq: number;
  snapshot: MatchSnapshot;
  messages: { text: string; kind: 'info' | 'foul' | 'good' }[];
}

export type ClientMessage =
  | { t: 'hello'; v: number; token: string; name: string; look: number }
  | { t: 'face'; data: string }
  | { t: 'pose'; pose: Pose }
  | { t: 'aim'; aim: AimState }
  | { t: 'place'; x: number; z: number }
  | { t: 'start'; snapshot: MatchSnapshot }
  | { t: 'shot'; shot: ShotMessage }
  | { t: 'result'; result: ShotResult }
  | { t: 'music'; music: MusicState | null }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'welcome'; you: string; players: PlayerInfo[]; snapshot: MatchSnapshot | null; music?: SharedMusic | null }
  | { t: 'players'; players: PlayerInfo[] }
  | { t: 'face'; id: string; data: string }
  | { t: 'pose'; id: string; pose: Pose }
  | { t: 'aim'; id: string; aim: AimState }
  | { t: 'place'; id: string; x: number; z: number }
  | { t: 'start'; snapshot: MatchSnapshot }
  | { t: 'shot'; id: string; shot: ShotMessage }
  | { t: 'result'; id: string; result: ShotResult }
  | { t: 'music'; shared: SharedMusic | null }
  | { t: 'error'; code: 'full' | 'version' | 'bad' | 'forbidden'; message: string }
  | { t: 'pong' };

export const ROOM_CODE_PATTERN = /^[A-Z0-9]{4,8}$/;

/** What the room's YouTube jukebox is playing. `time` is the position when the state was captured. */
export interface MusicState {
  list: string | null;
  video: string | null;
  index: number;
  time: number;
  playing: boolean;
}

export interface SharedMusic {
  music: MusicState;
  /** Player id of the current DJ (the last one to change the music). */
  by: string;
  /** Milliseconds since the server stored the state, so late joiners can catch up. */
  age: number;
}

export const YOUTUBE_LIST_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
export const YOUTUBE_VIDEO_PATTERN = /^[A-Za-z0-9_-]{11}$/;
