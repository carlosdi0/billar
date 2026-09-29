import type { MusicState } from '../net/protocol';
import { YOUTUBE_LIST_PATTERN, YOUTUBE_VIDEO_PATTERN } from '../net/protocol';

interface YTPlayer {
  loadPlaylist(options: { list: string; listType: 'playlist'; index?: number; startSeconds?: number }): void;
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  previousVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlaylistIndex(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string; title?: string };
  setVolume(volume: number): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    element: HTMLElement,
    options: {
      width: string;
      height: string;
      playerVars: Record<string, number | string>;
      events: {
        onReady: () => void;
        onStateChange: (event: { data: number }) => void;
        onError: (event: { data: number }) => void;
      };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;
const DRIFT_TOLERANCE = 2.5;
const SUPPRESS_MS = 2500;
const UNEMBEDDABLE_ERRORS = new Set([2, 5, 100, 101, 150]);

let apiPromise: Promise<YTNamespace> | null = null;

function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error('No se pudo cargar YouTube'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

/** Accepts playlist, watch, youtu.be, shorts and music.youtube.com links. */
export function parseYouTubeUrl(input: string): { list: string | null; video: string | null } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (!['youtube.com', 'music.youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
  const list = url.searchParams.get('list');
  let video = url.searchParams.get('v');
  if (host === 'youtu.be') video = url.pathname.slice(1).split('/')[0] || null;
  const shorts = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  if (shorts) video = shorts[1];
  const validList = list && YOUTUBE_LIST_PATTERN.test(list) ? list : null;
  const validVideo = video && YOUTUBE_VIDEO_PATTERN.test(video) ? video : null;
  if (!validList && !validVideo) return null;
  return { list: validList, video: validVideo };
}

/**
 * A YouTube IFrame player that can lead or follow a shared MusicState.
 * The DJ plays the playlist itself; everyone else plays the DJ's current video by id,
 * so personalised lists (YouTube Mixes) still sound the same for the whole room.
 */
export class Jukebox {
  /** Fired when the local player changes on its own (next track, skipped error) or through our controls. */
  onLocalChange: () => void = () => undefined;
  onTitle: (title: string) => void = () => undefined;
  onError: (message: string) => void = () => undefined;

  private player: YTPlayer | null = null;
  private ready = false;
  private list: string | null = null;
  private index = 0;
  private leading = false;
  /** Set by the game when this client is the room's DJ: it then keeps the playlist going on its own. */
  dj = true;
  private suppressUntil = 0;
  private queued: { state: MusicState; age: number; lead: boolean } | null = null;
  private lastTitle = '';
  private volume = 70;

  constructor(private readonly mount: HTMLElement) {}

  get active(): boolean {
    return this.player !== null;
  }

  get isLeading(): boolean {
    return this.leading;
  }

  /** Bring the local player in line with a shared state that is `ageSeconds` old. */
  async apply(state: MusicState, ageSeconds: number, lead: boolean): Promise<void> {
    if (!this.player || !this.ready) {
      this.queued = { state, age: ageSeconds, lead };
      if (!this.player) await this.create();
      return;
    }
    const p = this.player;
    const expected = state.time + (state.playing ? ageSeconds : 0);
    this.list = state.list;
    this.index = state.index;
    this.suppress();

    if (lead) {
      this.leading = true;
      if (state.list) p.loadPlaylist({ list: state.list, listType: 'playlist', index: state.index, startSeconds: expected });
      else if (state.video) p.loadVideoById({ videoId: state.video, startSeconds: expected });
      if (!state.playing) setTimeout(() => this.player?.pauseVideo(), 800);
      return;
    }

    this.leading = false;
    if (!state.video) return;
    if (p.getVideoData().video_id !== state.video) {
      p.loadVideoById({ videoId: state.video, startSeconds: expected });
      if (!state.playing) setTimeout(() => this.player?.pauseVideo(), 800);
      return;
    }
    if (Math.abs(p.getCurrentTime() - expected) > DRIFT_TOLERANCE) p.seekTo(expected, true);
    const playerState = p.getPlayerState();
    if (state.playing && playerState !== PLAYING && playerState !== BUFFERING) p.playVideo();
    if (!state.playing && playerState === PLAYING) p.pauseVideo();
  }

  state(): MusicState | null {
    const p = this.player;
    if (!p || !this.ready) return null;
    const video = p.getVideoData().video_id ?? null;
    if (!video && !this.list) return null;
    const playerState = p.getPlayerState();
    if (this.leading && this.list) this.index = Math.max(0, p.getPlaylistIndex());
    return {
      list: this.list,
      video,
      index: this.index,
      time: Math.max(0, p.getCurrentTime() || 0),
      playing: playerState === PLAYING || playerState === BUFFERING,
    };
  }

  /** Our own buttons: pausing works either way; skipping makes us the DJ of the playlist. */
  setVolume(volume: number): void {
    this.volume = volume;
    this.player?.setVolume(volume);
  }

  togglePlay(): void {
    const p = this.player;
    if (!p || !this.ready) return;
    if (p.getPlayerState() === PLAYING) p.pauseVideo();
    else p.playVideo();
    this.notifySoon();
  }

  skip(delta: 1 | -1): void {
    const p = this.player;
    if (!p || !this.ready) return;
    if (this.leading) {
      if (delta > 0) p.nextVideo();
      else p.previousVideo();
    } else if (this.list) {
      this.leading = true;
      this.index = Math.max(0, this.index + delta);
      p.loadPlaylist({ list: this.list, listType: 'playlist', index: this.index, startSeconds: 0 });
    } else {
      return;
    }
    this.notifySoon();
  }

  stop(): void {
    this.player?.destroy();
    this.player = null;
    this.ready = false;
    this.list = null;
    this.index = 0;
    this.leading = false;
    this.queued = null;
    this.lastTitle = '';
    this.mount.replaceChildren();
  }

  private suppress(): void {
    this.suppressUntil = performance.now() + SUPPRESS_MS;
  }

  private notifySoon(): void {
    setTimeout(() => this.onLocalChange(), 900);
  }

  private async create(): Promise<void> {
    let YT: YTNamespace;
    try {
      YT = await loadApi();
    } catch (error) {
      this.onError((error as Error).message);
      return;
    }
    if (this.player || !this.queued) return;
    const target = document.createElement('div');
    this.mount.replaceChildren(target);
    this.player = new YT.Player(target, {
      width: '100%',
      height: '100%',
      playerVars: { autoplay: 1, controls: 1, disablekb: 1, playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          this.ready = true;
          this.player?.setVolume(this.volume);
          const queued = this.queued;
          this.queued = null;
          if (queued) void this.apply(queued.state, queued.age, queued.lead);
        },
        onStateChange: (event) => {
          const title = this.player?.getVideoData().title ?? '';
          if (title && title !== this.lastTitle) {
            this.lastTitle = title;
            this.onTitle(title);
          }
          if (event.data === ENDED && this.dj && !this.leading && this.list) {
            this.skip(1);
            return;
          }
          if (performance.now() < this.suppressUntil) return;
          if (event.data === PLAYING || event.data === PAUSED) this.onLocalChange();
        },
        onError: (event) => {
          if (UNEMBEDDABLE_ERRORS.has(event.data) && this.leading && this.list) {
            this.player?.nextVideo();
            this.notifySoon();
          } else {
            this.onError('Este vídeo no se puede reproducir fuera de YouTube');
          }
        },
      },
    });
  }
}
