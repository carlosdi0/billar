import * as THREE from 'three';
import { Sfx } from '../audio/sfx';
import { Jukebox } from '../audio/youtube';
import { BALL_RADIUS as R, HALF_L, HALF_W, HEAD_STRING_X, SHOT } from '../config';
import { PointerControls } from '../input/pointer';
import type {
  AimState,
  BallsState,
  MusicState,
  SharedMusic,
  MatchSnapshot,
  PlayerInfo,
  Pose,
  ServerMessage,
  ShotMessage,
  ShotResult,
} from '../net/protocol';
import { RoomClient, randomRoomCode } from '../net/room';
import { predictAim } from '../physics/predict';
import { Simulation, type SimEvent } from '../physics/simulation';
import { buildTableGeometry } from '../physics/tableGeometry';
import { AimGuide } from '../render/aimGuide';
import { BallViews } from '../render/balls';
import { CameraRig } from '../render/cameraRig';
import { CueView } from '../render/cue';
import { Drinks } from '../render/drinks';
import { createPatrons, type Patrons } from '../render/patrons';
import { RemotePlayers } from '../render/remotePlayers';
import { createEnvironmentMap, createSaloon, type Saloon } from '../render/saloon';
import { Stage, type Quality } from '../render/stage';
import { createTable } from '../render/table';
import { Hud } from '../ui/hud';
import { JukeboxPanel } from '../ui/jukeboxPanel';
import { LobbyPanel, roomLink, type OnlineChoice } from '../ui/lobby';
import { HEAD_SPOT, isFreeSpot, isInsidePlayArea, rackPositions, respotPosition } from './rack';
import {
  evaluateShot,
  groupOf,
  isOnEight,
  newMatch,
  playerLabel,
  type MatchState,
  type PlayerIndex,
  type ShotReport,
} from './rules';
import { Stroll } from './stroll';

type Phase = 'menu' | 'aim' | 'strike' | 'roll' | 'over';
type Toast = ShotResult['messages'][number];

interface OnlineSession {
  client: RoomClient;
  lobby: LobbyPanel;
  myId: string;
  players: PlayerInfo[];
}

const CUE = 0;
const LAMP_HIDE_HEIGHT = 0.75;
const DJ_BROADCAST_INTERVAL = 5;
const POWER_EXPONENT = 1.6;
const SPECTATOR_SPOTS = [
  { x: -2.1, z: 1.4 },
  { x: 2.1, z: -1.4 },
  { x: -2.1, z: -1.4 },
  { x: 2.1, z: 1.4 },
];

function speedForPower(power: number): number {
  return SHOT.minSpeed + (SHOT.maxSpeed - SHOT.minSpeed) * Math.pow(power, POWER_EXPONENT);
}

function powerForSpeed(speed: number): number {
  const k = (speed - SHOT.minSpeed) / (SHOT.maxSpeed - SHOT.minSpeed);
  return Math.pow(THREE.MathUtils.clamp(k, 0, 1), 1 / POWER_EXPONENT);
}

export class Game {
  private readonly sim = new Simulation();
  private readonly rig = new CameraRig();
  private readonly balls: BallViews;
  private readonly cue = new CueView();
  private readonly guide = new AimGuide();
  private readonly saloon: Saloon;
  private readonly patrons: Patrons;
  private readonly remotes: RemotePlayers;
  private readonly stroll: Stroll;
  private readonly sfx = new Sfx();
  private readonly hud: Hud;
  private readonly stage: Stage;
  private readonly drinks = new Drinks();
  private readonly handMarker: THREE.Mesh;
  private readonly kitchenLine: THREE.Mesh;

  private phase: Phase = 'menu';
  private assisted = true;
  private match: MatchState = newMatch();
  private aimAngle = 0;
  private power = 0;
  private spinSide = 0;
  private spinVertical = 0;
  private report: ShotReport = { firstHit: null, pocketed: [], railAfterContact: false };
  private onTableBefore = new Set<number>();
  private strikeOrigin = { x: 0, z: 0 };
  private time = 0;
  private rollingLevel = 0;
  /** Walk the player back to the table as soon as their turn can start. */
  private seatWhenFree = false;

  private online: OnlineSession | null = null;
  private shotSeq = 0;
  private shooterIsMe = true;
  private pendingResult: ShotResult | null = null;
  private remoteShooter: string | null = null;
  private readonly jukeboxPanel: JukeboxPanel;
  private readonly jukebox: Jukebox;
  private djId: string | null = null;
  private djTimer = 0;

  constructor(container: HTMLElement, quality: Quality) {
    const stage = new Stage(container, this.rig.camera, quality);
    this.stage = stage;
    const scene = stage.scene;
    scene.environment = createEnvironmentMap(stage.renderer);

    this.saloon = createSaloon({ quality: stage.quality });
    scene.add(this.saloon.group);
    this.patrons = createPatrons({ quality: stage.quality });
    scene.add(this.patrons.group);
    scene.add(createTable(buildTableGeometry()));
    this.remotes = new RemotePlayers(stage.quality);
    scene.add(this.remotes.group);
    this.stroll = new Stroll(scene, stage.canvas, this.saloon, this.patrons, stage.quality);
    this.stroll.setExtraColliders(() => this.remotes.colliders());

    this.balls = new BallViews(stage.quality);
    scene.add(this.balls.group, this.cue.object, this.guide.group, this.drinks.group);

    this.handMarker = new THREE.Mesh(
      new THREE.RingGeometry(R * 1.25, R * 1.45, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.handMarker.position.y = 0.002;
    this.kitchenLine = new THREE.Mesh(
      new THREE.PlaneGeometry(0.004, HALF_W * 2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf6e7c1, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.kitchenLine.position.set(HEAD_STRING_X, 0.0015, 0);
    scene.add(this.handMarker, this.kitchenLine);

    this.hud = new Hud(document.body, {
      onPowerChange: (p) => (this.power = p),
      onShoot: (p) => this.shoot(p),
      onSpinChange: (side, vertical) => {
        this.spinSide = side * SHOT.maxTipOffset;
        this.spinVertical = vertical * SHOT.maxTipOffset;
      },
      onFineAim: (d) => {
        if (this.canControl()) this.aimAngle += d;
      },
      onToggleView: () => this.toggleView(),
      onToggleSound: () => {
        this.sfx.unlock();
        this.sfx.setMuted(!this.sfx.muted);
        this.hud.setMuted(this.sfx.muted);
      },
      onToggleMusic: () => {
        this.sfx.unlock();
        this.sfx.setMusic(!this.sfx.musicOn);
        this.hud.setMusic(this.sfx.musicOn);
      },
      onStandUp: () => this.standUp(),
      onRestart: () => this.restart(),
      onStart: (assisted) => {
        this.assisted = assisted;
        this.sfx.unlock();
        this.sfx.setAmbient(true);
        this.newLocalGame();
        if (!assisted) this.hud.toast('Modo difícil: sin guía de tiro');
      },
      onOnline: (choice) => this.joinOnline(choice),
      onJukebox: () => this.jukeboxPanel.open(),
    });
    this.jukeboxPanel = new JukeboxPanel(document.body, {
      onLoad: (source) => this.startJukebox({ ...source, index: 0, time: 0, playing: true }),
      onToggle: () => this.takeDj(() => this.jukebox.togglePlay()),
      onNext: () => this.takeDj(() => this.jukebox.skip(1)),
      onPrevious: () => this.takeDj(() => this.jukebox.skip(-1)),
      onClose: () => this.stopJukebox(true),
      onVolume: (volume) => this.jukebox.setVolume(volume),
    });
    this.jukebox = new Jukebox(this.jukeboxPanel.screen);
    this.jukebox.onLocalChange = () => this.broadcastMusic();
    this.jukebox.onTitle = (title) => this.jukeboxPanel.setTrack(title);
    this.jukebox.onError = (message) => this.hud.toast(message, 'foul');
    this.hud.setMuted(this.sfx.muted);
    this.hud.setMusic(this.sfx.musicOn);
    this.hud.setViewMode(this.rig.mode);
    this.hud.setStandUpAvailable(this.stroll.available);
    window.addEventListener('keydown', (e) => this.onKey(e));

    new PointerControls(stage.canvas, this.rig, {
      canAim: () => this.canControl(),
      canPlaceCue: () => this.match.ballInHand && this.canControl(),
      cuePosition: () => this.sim.balls[CUE],
      placeCue: (x, z) => this.placeCue(x, z),
      rotateAim: (d) => (this.aimAngle += d),
      aimAt: (x, z) => {
        const c = this.sim.balls[CUE];
        if (Math.hypot(x - c.x, z - c.z) > R * 1.5) this.aimAngle = Math.atan2(z - c.z, x - c.x);
      },
      toggleView: () => this.toggleView(),
      unlockAudio: () => this.sfx.unlock(),
    });

    stage.addResizeListener((w, h) => {
      this.rig.resize(w, h);
      this.guide.setResolution(w, h);
    });
    stage.resize();

    this.setupRack();
    this.aimAngle = Math.PI;
    this.rig.mode = 'aim';
    this.rig.followShot = true;
    this.rig.beginShot(0, 0, 0.35);
    this.rig.update(1, 0, 0, 0);
    this.rig.snap();
    this.hud.setControlsEnabled(false);
    this.hud.updatePlayers(this.match, this.onTableSet(), this.names());
    this.hud.showStart();
  }

  // ---------------------------------------------------------------- players

  private names(): string[] {
    const online = this.online;
    return [0, 1].map((seat) => online?.players.find((p) => p.seat === seat)?.name ?? playerLabel(seat as PlayerIndex));
  }

  private nameOf(player: number): string {
    return this.names()[player] ?? playerLabel(player as PlayerIndex);
  }

  private get me(): PlayerInfo | undefined {
    return this.online?.players.find((p) => p.id === this.online?.myId);
  }

  private isMyTurn(): boolean {
    return !this.online || this.me?.seat === this.match.current;
  }

  /** Shots make the cue tremble: a slow sway plus a faster jitter, scaled by how tipsy we are. */
  private shotAngle(): number {
    const t = this.time;
    const k = this.stroll.tipsyLevel;
    return this.aimAngle + k * (Math.sin(t * 1.9) * 0.0035 + Math.sin(t * 4.7 + 1) * 0.0015);
  }

  private canControl(): boolean {
    return this.phase === 'aim' && this.isMyTurn() && !this.stroll.active;
  }

  // ---------------------------------------------------------------- table state

  private setupRack(): void {
    for (let id = 1; id < 16; id++) this.sim.remove(id);
    for (const p of rackPositions()) {
      this.sim.place(p.id, p.x, p.z);
      this.randomizeOrientation(p.id);
    }
    this.sim.place(CUE, HEAD_SPOT.x, HEAD_SPOT.z);
    this.balls.clearDrops();
  }

  private randomizeOrientation(id: number): void {
    const q = new THREE.Quaternion()
      .setFromEuler(new THREE.Euler(Math.PI / 2 + (Math.random() - 0.5) * 0.6, Math.random() * Math.PI * 2, 0))
      .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2));
    this.sim.balls[id].q = [q.x, q.y, q.z, q.w];
  }

  private ballsState(): BallsState {
    return this.sim.balls.map((b) => [b.x, b.z, b.onTable ? 1 : 0]);
  }

  private applyBalls(state: BallsState): void {
    state.forEach(([x, z, on], id) => {
      if (on) this.sim.place(id, x, z);
      else this.sim.remove(id);
    });
    this.balls.clearDrops();
  }

  private snapshot(over: MatchSnapshot['over'] = null): MatchSnapshot {
    return { match: this.match, balls: this.ballsState(), assisted: this.assisted, shotSeq: this.shotSeq, over };
  }

  private onTableSet(): Set<number> {
    return new Set(this.sim.balls.filter((b) => b.onTable).map((b) => b.id));
  }

  // ---------------------------------------------------------------- local games

  private newLocalGame(): void {
    this.hud.hideOverlay();
    this.setupRack();
    this.match = newMatch(Math.random() < 0.5 ? 0 : 1);
    this.shotSeq = 0;
    this.resetSpin();
    this.rig.followShot = false;
    this.enterAim();
    this.hud.toast(`${this.nameOf(this.match.current)} rompe`, 'good');
  }

  private restart(): void {
    this.sfx.uiClick();
    if (!this.online) {
      this.newLocalGame();
      return;
    }
    if (this.me?.host) this.hostStart(this.assisted);
    else this.hud.toast('Solo el anfitrión puede empezar otra partida');
  }

  private resetSpin(): void {
    this.spinSide = this.spinVertical = 0;
    this.hud.setSpin(0, 0);
  }

  // ---------------------------------------------------------------- online

  private joinOnline(choice: OnlineChoice): void {
    const code = choice.code ?? randomRoomCode();
    history.replaceState(null, '', roomLink(code));
    this.sfx.unlock();
    this.sfx.setAmbient(true);

    const client = new RoomClient(code, { name: choice.name, look: choice.look });
    const lobby = new LobbyPanel(document.body, code, {
      onStartMatch: (assisted) => this.hostStart(assisted),
      onLeave: () => this.leaveOnline(),
    });
    this.online = { client, lobby, myId: '', players: [] };
    client.onStatus = (status) => lobby.setStatus(status);
    client.onMessage = (message) => this.onServer(message);
    client.onKicked = (code) => {
      if (code === 4000) this.hud.toast('Has abierto la sala en otra pestaña: esta se desconecta', 'foul');
      else this.leaveOnline();
    };
    client.connect();

    this.stroll.setLook(choice.look);
    this.phase = 'menu';
    this.hud.setControlsEnabled(false);
    if (this.stroll.available) {
      const spawn = this.saloon.spawn;
      this.stroll.enterAt(spawn.x, spawn.z, spawn.yaw);
      this.rig.walking = true;
      this.hud.setWalkMode(true);
    }
    this.hud.toast(choice.code ? `Entrando en la sala ${code}…` : `Sala ${code} creada: comparte el enlace`, 'good');
  }

  private leaveOnline(): void {
    const online = this.online;
    if (!online) return;
    online.client.close();
    online.lobby.dispose();
    for (const p of online.players) this.remotes.remove(p.id);
    this.online = null;
    this.djId = null;
    this.jukebox.dj = true;
    this.leaveStroll();
    history.replaceState(null, '', location.pathname);
    this.phase = 'menu';
    this.hud.setControlsEnabled(false);
    this.hud.setHint(null);
    this.hud.showStart();
  }

  private onServer(message: ServerMessage): void {
    const online = this.online;
    if (!online) return;
    switch (message.t) {
      case 'welcome':
        online.myId = message.you;
        this.syncPlayers(message.players);
        if (message.music) this.followMusic(message.music, true);
        else if (this.jukebox.active) {
          this.djId = online.myId;
          this.broadcastMusic();
        }
        if (message.snapshot) this.applySnapshot(message.snapshot, false);
        break;
      case 'players':
        this.syncPlayers(message.players);
        break;
      case 'face':
        this.remotes.setFace(message.id, message.data);
        break;
      case 'pose':
        this.remotes.setPose(message.id, message.pose);
        if (!message.pose.atTable && this.remoteShooter === message.id && this.phase === 'aim') {
          this.remoteShooter = null;
          this.remotes.setShooting(null, 0, 0, 0, 0);
        }
        break;
      case 'aim':
        this.onRemoteAim(message.id, message.aim);
        break;
      case 'place':
        if (this.match.ballInHand && !this.isMyTurn() && this.phase === 'aim') this.sim.place(CUE, message.x, message.z);
        break;
      case 'start':
        this.applySnapshot(message.snapshot, true);
        this.hud.toast(`${this.nameOf(this.match.current)} rompe`, 'good');
        break;
      case 'shot':
        this.playRemoteShot(message.id, message.shot);
        break;
      case 'result':
        if (message.result.seq === this.shotSeq) {
          this.pendingResult = message.result;
          this.tryFinishRemoteShot();
        }
        break;
      case 'error':
        this.hud.toast(message.message || 'Error de conexión', 'foul');
        if (message.code === 'full' || message.code === 'version') this.leaveOnline();
        break;
      case 'music':
        this.followMusic(message.shared, true);
        break;
      case 'pong':
        break;
    }
  }

  private syncPlayers(players: PlayerInfo[]): void {
    const online = this.online;
    if (!online) return;
    const previous = new Set(online.players.map((p) => p.id));
    online.players = players;
    for (const p of players) {
      previous.delete(p.id);
      if (p.id === online.myId) continue;
      this.remotes.upsert(p.id, p.name, p.look, p.seat, p.connected);
    }
    for (const gone of previous) this.remotes.remove(gone);
    online.lobby.update(players, online.myId, this.phase !== 'menu');
    this.hud.updatePlayers(this.match, this.onTableSet(), this.names());
  }

  // ---------------------------------------------------------------- jukebox

  private get amDj(): boolean {
    return !this.online || this.djId === this.online.myId;
  }

  private startJukebox(state: MusicState): void {
    this.sfx.unlock();
    this.djId = this.online?.myId ?? null;
    this.jukebox.dj = true;
    void this.jukebox.apply(state, 0, !state.video);
    this.jukeboxPanel.showPlaying(this.online ? 'tú' : '');
    this.duckMusic(true);
    this.djTimer = DJ_BROADCAST_INTERVAL - 2.5;
  }

  /** Pressing any jukebox control makes you the DJ everyone follows. */
  private takeDj(action: () => void): void {
    this.djId = this.online?.myId ?? null;
    this.jukebox.dj = true;
    this.jukeboxPanel.showPlaying(this.online ? 'tú' : '');
    action();
  }

  private broadcastMusic(): void {
    const online = this.online;
    if (!online || !this.amDj) return;
    const music = this.jukebox.state();
    if (music) online.client.send({ t: 'music', music });
  }

  private followMusic(shared: SharedMusic | null, announce: boolean): void {
    const online = this.online;
    if (!online) return;
    if (!shared) {
      if (this.jukebox.active && announce) this.hud.toast('Se acabó la música de la gramola');
      this.stopJukebox(false);
      return;
    }
    const fresh = !this.jukebox.active;
    this.djId = shared.by;
    this.jukebox.dj = shared.by === online.myId;
    void this.jukebox.apply(shared.music, shared.age / 1000, false);
    const dj = online.players.find((p) => p.id === shared.by)?.name ?? 'alguien';
    this.jukeboxPanel.showPlaying(dj);
    this.duckMusic(true);
    if (fresh && announce) this.hud.toast(`🎵 ${dj} ha puesto música en la gramola`, 'good');
  }

  private stopJukebox(share: boolean): void {
    const wasActive = this.jukebox.active;
    this.jukebox.stop();
    this.jukeboxPanel.showForm();
    this.jukeboxPanel.hide();
    this.djId = null;
    this.duckMusic(false);
    if (share && wasActive) this.online?.client.send({ t: 'music', music: null });
  }

  /** The generative saloon music steps aside while the jukebox plays. */
  private duckMusic(duck: boolean): void {
    this.sfx.setDucked(duck);
  }

  private updateJukebox(dt: number): void {
    const online = this.online;
    if (!online || !this.jukebox.active) return;
    const dj = this.djId ? online.players.find((p) => p.id === this.djId) : undefined;
    if ((!dj || !dj.connected) && this.me?.host && this.djId !== online.myId) {
      this.djId = online.myId;
      this.jukebox.dj = true;
      this.jukeboxPanel.showPlaying('tú');
    }
    if (!this.amDj) return;
    this.djTimer += dt;
    if (this.djTimer >= DJ_BROADCAST_INTERVAL) {
      this.djTimer = 0;
      this.broadcastMusic();
    }
  }

  private hostStart(assisted: boolean): void {
    const online = this.online;
    if (!online || !this.me?.host) return;
    this.setupRack();
    this.match = newMatch(Math.random() < 0.5 ? 0 : 1);
    this.assisted = assisted;
    this.shotSeq = 0;
    online.client.send({ t: 'start', snapshot: this.snapshot() });
  }

  private applySnapshot(snapshot: MatchSnapshot, turnAnnounce: boolean): void {
    const previousPlayer = this.match.current;
    this.applyBalls(snapshot.balls);
    this.match = snapshot.match;
    this.assisted = snapshot.assisted;
    this.shotSeq = snapshot.shotSeq;
    this.pendingResult = null;
    this.remoteShooter = null;
    this.remotes.setShooting(null, 0, 0, 0, 0);
    this.hud.hideOverlay();
    this.hud.updatePlayers(this.match, this.onTableSet(), this.names());
    if (this.online) this.online.lobby.update(this.online.players, this.online.myId, true);

    if (snapshot.over) {
      this.showGameOver(snapshot.over.winner, snapshot.over.reason);
      return;
    }
    this.phase = 'aim';
    this.rig.followShot = false;
    const changed = turnAnnounce || previousPlayer !== this.match.current;
    if (this.isMyTurn()) this.beginMyTurn(changed);
    else this.beginOtherTurn();
  }

  private beginMyTurn(announce: boolean): void {
    if (this.online && announce) {
      this.sfx.turnChange();
      this.hud.toast('¡Te toca!', 'good');
      this.resetSpin();
    }
    if (this.stroll.active) this.seatWhenFree = true;
    else this.enterAim();
  }

  private beginOtherTurn(): void {
    this.power = 0;
    this.hud.setPower(0);
    this.hud.setControlsEnabled(false);
    if (this.stroll.available && !this.stroll.active) this.standUp();
    else if (!this.stroll.active) this.hud.setHint(`Turno de ${this.nameOf(this.match.current)}`);
  }

  private onRemoteAim(id: string, aim: AimState): void {
    if (this.phase !== 'aim' || this.isMyTurn()) return;
    this.aimAngle = Math.atan2(aim.dirZ, aim.dirX);
    this.power = aim.power;
    this.spinSide = aim.side;
    this.spinVertical = aim.vertical;
    const cue = this.sim.balls[CUE];
    if (this.match.ballInHand && (cue.x !== aim.cueX || cue.z !== aim.cueZ)) this.sim.place(CUE, aim.cueX, aim.cueZ);
    this.remoteShooter = id;
    this.remotes.setShooting(id, aim.cueX, aim.cueZ, aim.dirX, aim.dirZ);
  }

  private playRemoteShot(id: string, shot: ShotMessage): void {
    this.applyBalls(shot.before);
    const cue = this.sim.balls[CUE];
    this.strikeOrigin = { x: cue.x, z: cue.z };
    this.aimAngle = Math.atan2(shot.dirZ, shot.dirX);
    this.spinSide = shot.side;
    this.spinVertical = shot.vertical;
    this.power = powerForSpeed(shot.speed);
    this.onTableBefore = this.onTableSet();
    this.report = { firstHit: null, pocketed: [], railAfterContact: false };
    this.shotSeq = shot.seq;
    this.shooterIsMe = false;
    this.pendingResult = null;
    this.phase = 'strike';
    this.hud.setControlsEnabled(false);
    this.remotes.setShooting(id, cue.x, cue.z, shot.dirX, shot.dirZ);
    this.cue.strike(this.power, () => {
      this.sim.strike(CUE, shot.dirX, shot.dirZ, shot.speed, shot.side, shot.vertical);
      this.sfx.cueStrike(Math.min(1, 0.2 + this.power));
      this.phase = 'roll';
      this.rig.beginShot(this.strikeOrigin.x, this.strikeOrigin.z, this.aimAngle);
    });
  }

  private tryFinishRemoteShot(): void {
    if (this.phase !== 'roll' || !this.pendingResult) return;
    const dropping = this.sim.balls.some((b) => this.balls.isDropping(b.id));
    if (!this.sim.isSettled() || dropping) return;
    const result = this.pendingResult;
    this.pendingResult = null;
    this.finishShot(result.snapshot, result.messages);
  }

  private streamState(): void {
    const online = this.online;
    if (!online?.client.connected) return;
    let pose: Pose;
    if (this.stroll.active) {
      pose = this.stroll.pose();
    } else if (this.isMyTurn() && (this.phase === 'aim' || this.phase === 'strike')) {
      const cam = this.rig.camera.position;
      pose = { x: cam.x, z: cam.z, yaw: Math.PI / 2 - this.aimAngle, action: 'lean', speed: 0, atTable: true };
    } else {
      const spot = SPECTATOR_SPOTS[(this.me?.seat ?? 0) % SPECTATOR_SPOTS.length];
      pose = { x: spot.x, z: spot.z, yaw: Math.atan2(-spot.x, -spot.z), action: 'idle', speed: 0, atTable: false };
    }
    online.client.streamPose(pose);

    if (this.canControl()) {
      const cue = this.sim.balls[CUE];
      online.client.streamAim({
        dirX: Math.cos(this.shotAngle()),
        dirZ: Math.sin(this.shotAngle()),
        power: this.power,
        side: this.spinSide,
        vertical: this.spinVertical,
        cueX: cue.x,
        cueZ: cue.z,
      });
    }
  }

  // ---------------------------------------------------------------- turns

  private enterAim(): void {
    this.phase = 'aim';
    this.rig.followShot = false;
    this.power = 0;
    this.hud.setPower(0);
    const mine = this.isMyTurn();
    this.hud.setControlsEnabled(mine);
    this.hud.updatePlayers(this.match, this.onTableSet(), this.names());
    if (!mine) this.hud.setHint(`Turno de ${this.nameOf(this.match.current)}`);
    else if (this.match.ballInHand) {
      this.hud.setHint(
        this.match.kitchenOnly
          ? 'Bola en mano: arrastra la blanca detrás de la línea'
          : 'Bola en mano: arrastra la blanca donde quieras',
      );
    } else {
      this.hud.setHint(null);
    }
  }

  private showGameOver(winner: number, reason: string): void {
    this.phase = 'over';
    this.hud.setControlsEnabled(false);
    this.sfx.win();
    const title = `¡Gana ${this.nameOf(winner)}!`;
    if (!this.online) {
      this.hud.showOverlay(title, reason, [
        { label: 'Otra partida', onAction: () => this.newLocalGame() },
        { label: 'Cambiar modo', onAction: () => this.hud.showStart(), secondary: true },
      ]);
    } else if (this.me?.host) {
      this.hud.showOverlay(title, reason, [
        { label: 'Otra partida', onAction: () => this.hostStart(this.assisted) },
        { label: 'Seguir en el bar', onAction: () => undefined, secondary: true },
      ]);
    } else {
      this.hud.showOverlay(title, `${reason}. El anfitrión puede empezar otra partida.`, [
        { label: 'Seguir en el bar', onAction: () => undefined },
      ]);
    }
  }

  // ---------------------------------------------------------------- walking

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.target instanceof HTMLInputElement) return;
    if (e.code === 'KeyQ' && !this.stroll.active) this.standUp();
    else if (e.code === 'KeyE' && this.stroll.active) {
      if (this.stroll.nearBar()) this.orderShot();
      else this.takeCue();
    }
  }

  private standUp(): void {
    if (!this.stroll.available || this.stroll.active || this.phase === 'strike') return;
    if (!this.online && this.phase !== 'aim' && this.phase !== 'roll') return;
    const cue = this.sim.balls[CUE];
    this.stroll.enter(this.rig.camera.position, cue.x, cue.z);
    this.rig.walking = true;
    this.hud.setWalkMode(true);
  }

  private orderShot(): void {
    if (!this.stroll.orderShot()) return;
    this.sfx.shot();
    const n = this.stroll.shots;
    const lines = ['¡Salud!', 'Otro más, vaquero', 'El camarero te mira de reojo', 'El suelo se mueve un poco…', 'Dicen que así se apunta mejor', 'El saloon da vueltas'];
    this.hud.toast(`🥃 ${lines[Math.min(n, lines.length) - 1]} · ${n} ${n === 1 ? 'chupito' : 'chupitos'}`);
  }

  private leaveStroll(): void {
    if (!this.stroll.active) return;
    this.stroll.exit();
    this.rig.walking = false;
    this.hud.setWalkMode(false);
  }

  private takeCue(): void {
    if (this.phase !== 'aim' || !this.stroll.nearTable()) return;
    if (!this.isMyTurn()) {
      this.hud.toast(`Aún no te toca: juega ${this.nameOf(this.match.current)}`);
      return;
    }
    this.sitAtTable();
  }

  private trySeat(): void {
    if (!this.stroll.active || this.phase !== 'aim' || !this.isMyTurn()) {
      this.seatWhenFree = false;
      return;
    }
    if (this.stroll.drinking) return;
    this.seatWhenFree = false;
    this.sitAtTable();
  }

  private sitAtTable(): void {
    const p = this.stroll.position;
    const cue = this.sim.balls[CUE];
    this.aimAngle = Math.atan2(cue.z - p.y, cue.x - p.x);
    this.leaveStroll();
    this.rig.mode = 'aim';
    this.hud.setViewMode('aim');
    this.enterAim();
  }

  private walkHint(): string {
    if (!this.stroll.pointerLocked) return 'Haz clic para mirar con el ratón · WASD para moverte';
    if (this.stroll.drinking) return '¡Salud!';
    if (this.stroll.nearBar()) return 'Pulsa E para pedir un chupito 🥃';
    if (this.phase === 'menu') return this.online ? 'Esperando a que empiece la partida…' : '';
    if (this.phase === 'over') return 'Partida terminada';
    if (this.phase !== 'aim') return 'Las bolas están rodando…';
    if (!this.isMyTurn()) return `Turno de ${this.nameOf(this.match.current)}`;
    if (this.stroll.nearTable()) return this.online ? '¡Te toca! Pulsa E para coger el taco' : `Pulsa E para jugar · turno de ${this.nameOf(this.match.current)}`;
    return this.online ? '¡Te toca! Acércate a la mesa' : `Turno de ${this.nameOf(this.match.current)}: acércate a la mesa`;
  }

  private toggleView(): void {
    if (this.stroll.active) return;
    this.sfx.uiClick();
    this.rig.mode = this.rig.mode === 'aim' ? 'top' : 'aim';
    this.hud.setViewMode(this.rig.mode);
  }

  // ---------------------------------------------------------------- shooting

  private placeCue(x: number, z: number): void {
    const margin = R + 0.002;
    let cx = THREE.MathUtils.clamp(x, -HALF_L + margin, HALF_L - margin);
    const cz = THREE.MathUtils.clamp(z, -HALF_W + margin, HALF_W - margin);
    if (this.match.kitchenOnly) cx = Math.min(cx, HEAD_STRING_X);
    const others = this.sim.balls.filter((b) => b.id !== CUE && b.onTable);
    if (isInsidePlayArea(cx, cz, this.match.kitchenOnly) && isFreeSpot(cx, cz, others)) {
      this.sim.place(CUE, cx, cz);
      this.online?.client.streamPlace(cx, cz);
    }
  }

  private shoot(power: number): void {
    if (!this.canControl()) return;
    this.phase = 'strike';
    this.hud.setControlsEnabled(false);
    this.hud.setHint(null);
    const cueBall = this.sim.balls[CUE];
    this.strikeOrigin = { x: cueBall.x, z: cueBall.z };
    this.onTableBefore = this.onTableSet();
    this.report = { firstHit: null, pocketed: [], railAfterContact: false };
    this.power = power;
    this.shooterIsMe = true;

    const shot: ShotMessage = {
      seq: this.shotSeq + 1,
      before: this.ballsState(),
      dirX: Math.cos(this.shotAngle()),
      dirZ: Math.sin(this.shotAngle()),
      speed: speedForPower(power),
      side: this.spinSide,
      vertical: this.spinVertical,
    };
    this.shotSeq = shot.seq;
    this.aimAngle = Math.atan2(shot.dirZ, shot.dirX);
    this.online?.client.send({ t: 'shot', shot });

    this.cue.strike(power, () => {
      this.sim.strike(CUE, shot.dirX, shot.dirZ, shot.speed, shot.side, shot.vertical);
      this.sfx.cueStrike(Math.min(1, 0.2 + power));
      this.phase = 'roll';
      this.rig.beginShot(this.strikeOrigin.x, this.strikeOrigin.z, this.aimAngle);
    });
  }

  private handleEvents(events: SimEvent[]): void {
    for (const e of events) {
      if (e.type === 'ballBall') {
        if (this.report.firstHit === null && (e.a === CUE || e.b === CUE)) {
          this.report.firstHit = e.a === CUE ? e.b : e.a;
        }
        this.sfx.ballHit(Math.min(1, e.speed / 4), e.x / HALF_L);
      } else if (e.type === 'cushion') {
        if (this.report.firstHit !== null) this.report.railAfterContact = true;
        this.sfx.cushionHit(Math.min(1, e.speed / 3.5), e.x / HALF_L);
      } else {
        this.report.pocketed.push(e.ball);
        const pocket = this.sim.pockets[e.pocket];
        this.balls.startDrop(this.sim.balls[e.ball], pocket);
        this.sfx.pocket(Math.min(1, 0.3 + e.speed / 3), pocket.x / HALF_L);
      }
    }
  }

  /** Evaluate our own shot (or any shot offline) and share the outcome. */
  private resolveShot(): void {
    const verdict = evaluateShot(this.match, this.report, this.onTableBefore, this.names());
    const others = () => this.sim.balls.filter((b) => b.onTable && b.id !== CUE);
    if (verdict.respotEight) {
      const spot = respotPosition(others());
      this.sim.place(8, spot.x, spot.z);
    }
    if (verdict.respotCue || !this.sim.balls[CUE].onTable) {
      const spot = isFreeSpot(HEAD_SPOT.x, HEAD_SPOT.z, others()) ? HEAD_SPOT : this.freeKitchenSpot();
      this.sim.place(CUE, spot.x, spot.z);
    }

    this.match = verdict.state;
    const over =
      verdict.gameOverReason !== null && verdict.state.winner !== null
        ? { winner: verdict.state.winner, reason: verdict.gameOverReason }
        : null;
    const messages: Toast[] = verdict.messages.map((text, i) => ({ text, kind: verdict.foul && i === 0 ? 'foul' : 'info' }));
    const snapshot = this.snapshot(over);
    this.online?.client.send({ t: 'result', result: { seq: this.shotSeq, snapshot, messages } });
    this.finishShot(snapshot, messages);
  }

  private finishShot(snapshot: MatchSnapshot, messages: Toast[]): void {
    const previous = this.match.current;
    const shooterWasMe = this.shooterIsMe;
    this.shooterIsMe = true;
    for (const m of messages) this.hud.toast(m.text, m.kind);
    if (snapshot.over) {
      this.applySnapshot(snapshot, false);
      return;
    }
    const foul = messages.some((m) => m.kind === 'foul');
    const turnChanged = snapshot.match.current !== previous;
    if (foul) this.sfx.foul();
    else if (turnChanged && !this.online) this.sfx.turnChange();
    if (turnChanged && !foul && !this.online) this.hud.toast(`Turno de ${this.nameOf(snapshot.match.current)}`);

    if (this.online) {
      this.applySnapshot(snapshot, turnChanged);
      if (turnChanged && !foul && !this.isMyTurn() && shooterWasMe) this.hud.toast(`Turno de ${this.nameOf(this.match.current)}`);
      return;
    }
    this.match = snapshot.match;
    if (this.stroll.active) {
      this.phase = 'aim';
      this.seatWhenFree = true;
      this.hud.updatePlayers(this.match, this.onTableSet(), this.names());
      return;
    }
    this.enterAim();
  }

  private freeKitchenSpot(): { x: number; z: number } {
    const others = this.sim.balls.filter((b) => b.onTable && b.id !== CUE);
    for (let dz = 0; dz < HALF_W; dz += 0.01) {
      for (const z of [dz, -dz]) {
        if (isFreeSpot(HEAD_SPOT.x, z, others)) return { x: HEAD_SPOT.x, z };
      }
    }
    return HEAD_SPOT;
  }

  private isLegalTarget(target: number | null): boolean {
    if (target === null) return true;
    const group = this.match.groups[this.match.current];
    if (group === null) return target !== 8 || this.match.isBreak;
    if (isOnEight(this.match, this.match.current, this.onTableSet())) return target === 8;
    return groupOf(target) === group;
  }

  // ---------------------------------------------------------------- frame

  update(dt: number): void {
    this.time += dt;
    const cueBall = this.sim.balls[CUE];

    if (this.phase === 'roll') {
      this.handleEvents(this.sim.step(dt));
      const speed = this.sim.balls.reduce((s, b) => s + (b.onTable ? Math.hypot(b.vx, b.vz) : 0), 0);
      this.rollingLevel = Math.min(1, speed / 3);
      const dropping = this.sim.balls.some((b) => this.balls.isDropping(b.id));
      if (this.sim.isSettled() && !dropping) {
        if (!this.online || this.shooterIsMe) this.resolveShot();
        else this.tryFinishRemoteShot();
      }
    } else {
      this.rollingLevel = 0;
    }
    this.sfx.setRolling(this.rollingLevel);

    this.stroll.tick(dt);
    if (this.seatWhenFree) this.trySeat();
    const control = this.canControl();
    const remoteAiming = this.phase === 'aim' && !this.isMyTurn();
    const showCue = control || remoteAiming || this.phase === 'strike';
    const cueAngle = control ? this.shotAngle() : this.aimAngle;
    if (showCue) {
      const origin = this.phase === 'strike' ? this.strikeOrigin : cueBall;
      this.cue.aim(origin.x, origin.z, cueAngle, this.power, this.spinSide, this.spinVertical);
    }
    this.cue.update(dt, this.strikeOrigin.x, this.strikeOrigin.z, this.aimAngle, this.spinSide, this.spinVertical);
    this.cue.fade(showCue || this.cue.striking ? 1 : 0, dt);

    this.guide.setVisible(control && cueBall.onTable && this.assisted);
    if (control && this.assisted) {
      const prediction = predictAim(this.sim.balls, this.sim.segments, CUE, cueAngle);
      this.guide.update(cueBall.x, cueBall.z, cueAngle, prediction, this.isLegalTarget(prediction.target));
    }

    const inHand = (control || remoteAiming) && this.match.ballInHand;
    this.handMarker.visible = inHand;
    this.kitchenLine.visible = inHand && this.match.kitchenOnly;
    if (inHand) {
      this.handMarker.position.x = cueBall.x;
      this.handMarker.position.z = cueBall.z;
      const pulse = 1 + Math.sin(this.time * 5) * 0.08;
      this.handMarker.scale.set(pulse, 1, pulse);
    }

    this.balls.sync(this.sim.balls, dt);
    this.saloon.lampFixture.visible =
      this.stroll.active || (this.rig.mode !== 'top' && this.rig.camera.position.y < LAMP_HIDE_HEIGHT);
    this.saloon.update(this.time, dt);
    this.patrons.update(this.time, dt);

    if (this.stroll.active) {
      this.stroll.update(dt, this.time, this.rig);
      this.hud.setHint(this.walkHint() || null);
    }
    this.remotes.update(dt, this.time, this.rig.camera);
    this.streamState();
    this.updateJukebox(dt);

    const focus = this.phase === 'strike' ? this.strikeOrigin : cueBall;
    this.rig.update(dt, focus.x, focus.z, this.aimAngle);
    this.drinks.update(this.rig.camera);
    this.stage.render();
  }
}
