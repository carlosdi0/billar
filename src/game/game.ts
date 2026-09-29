import * as THREE from 'three';
import { Sfx } from '../audio/sfx';
import { BALL_RADIUS as R, HALF_L, HALF_W, HEAD_STRING_X, SHOT } from '../config';
import { PointerControls } from '../input/pointer';
import { predictAim } from '../physics/predict';
import { Simulation, type SimEvent } from '../physics/simulation';
import { AimGuide } from '../render/aimGuide';
import { BallViews } from '../render/balls';
import { CameraRig } from '../render/cameraRig';
import { CueView } from '../render/cue';
import { createEnvironmentMap, createSaloon, type Saloon } from '../render/saloon';
import { Stage, type Quality } from '../render/stage';
import { Drinks } from '../render/drinks';
import { createPatrons, type Patrons } from '../render/patrons';
import { createTable } from '../render/table';
import { Hud } from '../ui/hud';
import { HEAD_SPOT, isFreeSpot, isInsidePlayArea, rackPositions, respotPosition } from './rack';
import {
  evaluateShot,
  groupOf,
  isOnEight,
  newMatch,
  playerLabel,
  type MatchState,
  type ShotReport,
} from './rules';
import { buildTableGeometry } from '../physics/tableGeometry';
import { Stroll } from './stroll';

type Phase = 'menu' | 'aim' | 'strike' | 'roll' | 'over';

const CUE = 0;
const LAMP_HIDE_HEIGHT = 0.75;

export class Game {
  private readonly sim = new Simulation();
  private readonly rig = new CameraRig();
  private readonly balls: BallViews;
  private readonly cue = new CueView();
  private readonly guide = new AimGuide();
  private readonly saloon: Saloon;
  private readonly patrons: Patrons;
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
    this.stroll = new Stroll(scene, stage.canvas, this.saloon, this.patrons, stage.quality);

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
      onFineAim: (d) => this.phase === 'aim' && (this.aimAngle += d),
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
      onRestart: () => {
        this.sfx.uiClick();
        this.newGame();
      },
      onStart: (assisted) => {
        this.assisted = assisted;
        this.sfx.unlock();
        this.sfx.setAmbient(true);
        this.newGame();
        if (!assisted) this.hud.toast('Modo difícil: sin guía de tiro');
      },
    });
    this.hud.setMuted(this.sfx.muted);
    this.hud.setMusic(this.sfx.musicOn);
    this.hud.setViewMode(this.rig.mode);
    this.hud.setStandUpAvailable(this.stroll.available);
    window.addEventListener('keydown', (e) => this.onKey(e));

    new PointerControls(stage.canvas, this.rig, {
      canAim: () => this.phase === 'aim' && !this.stroll.active,
      canPlaceCue: () => this.match.ballInHand,
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
    this.hud.updatePlayers(this.match, this.onTableSet());
    this.hud.showStart();
  }

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

  private newGame(): void {
    this.hud.hideOverlay();
    this.setupRack();
    this.match = newMatch(Math.random() < 0.5 ? 0 : 1);
    this.aimAngle = 0;
    this.spinSide = this.spinVertical = 0;
    this.hud.setSpin(0, 0);
    this.rig.followShot = false;
    this.enterAim();
    this.hud.toast(`${playerLabel(this.match.current)} rompe`, 'good');
  }

  private onTableSet(): Set<number> {
    return new Set(this.sim.balls.filter((b) => b.onTable).map((b) => b.id));
  }

  private enterAim(): void {
    this.phase = 'aim';
    this.rig.followShot = false;
    this.power = 0;
    this.hud.setPower(0);
    this.hud.setControlsEnabled(true);
    this.hud.updatePlayers(this.match, this.onTableSet());
    if (this.match.ballInHand) {
      this.hud.setHint(
        this.match.kitchenOnly
          ? 'Bola en mano: arrastra la blanca detrás de la línea'
          : 'Bola en mano: arrastra la blanca donde quieras',
      );
    } else {
      this.hud.setHint(null);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (e.code === 'KeyQ' && !this.stroll.active) this.standUp();
    else if (e.code === 'KeyE' && this.stroll.active) this.takeCue();
  }

  private standUp(): void {
    if (!this.stroll.available || this.stroll.active) return;
    if (this.phase !== 'aim' && this.phase !== 'roll') return;
    this.sfx.uiClick();
    const cue = this.sim.balls[CUE];
    this.stroll.enter(this.rig.camera.position, cue.x, cue.z);
    this.rig.walking = true;
    this.hud.setWalkMode(true);
  }

  private takeCue(): void {
    if (this.phase !== 'aim' || !this.stroll.nearTable()) return;
    const p = this.stroll.position;
    const cue = this.sim.balls[CUE];
    this.aimAngle = Math.atan2(cue.z - p.y, cue.x - p.x);
    this.stroll.exit();
    this.rig.walking = false;
    this.rig.mode = 'aim';
    this.hud.setViewMode('aim');
    this.hud.setWalkMode(false);
    this.enterAim();
  }

  private walkHint(): string {
    if (!this.stroll.pointerLocked) return 'Haz clic para mirar con el ratón · WASD para moverte';
    if (this.phase !== 'aim') return 'Las bolas están rodando…';
    if (this.stroll.nearTable()) return `Pulsa E para jugar · turno de ${playerLabel(this.match.current)}`;
    return `Turno de ${playerLabel(this.match.current)}: acércate a la mesa`;
  }

  private toggleView(): void {
    if (this.stroll.active) return;
    this.sfx.uiClick();
    this.rig.mode = this.rig.mode === 'aim' ? 'top' : 'aim';
    this.hud.setViewMode(this.rig.mode);
  }

  private placeCue(x: number, z: number): void {
    const margin = R + 0.002;
    let cx = THREE.MathUtils.clamp(x, -HALF_L + margin, HALF_L - margin);
    const cz = THREE.MathUtils.clamp(z, -HALF_W + margin, HALF_W - margin);
    if (this.match.kitchenOnly) cx = Math.min(cx, HEAD_STRING_X);
    const others = this.sim.balls.filter((b) => b.id !== CUE && b.onTable);
    if (isInsidePlayArea(cx, cz, this.match.kitchenOnly) && isFreeSpot(cx, cz, others)) {
      this.sim.place(CUE, cx, cz);
    }
  }

  private shoot(power: number): void {
    if (this.phase !== 'aim') return;
    this.phase = 'strike';
    this.hud.setControlsEnabled(false);
    this.hud.setHint(null);
    const cueBall = this.sim.balls[CUE];
    this.strikeOrigin = { x: cueBall.x, z: cueBall.z };
    this.onTableBefore = this.onTableSet();
    this.report = { firstHit: null, pocketed: [], railAfterContact: false };
    this.power = power;

    this.cue.strike(power, () => {
      const speed = SHOT.minSpeed + (SHOT.maxSpeed - SHOT.minSpeed) * Math.pow(power, 1.6);
      this.sim.strike(CUE, Math.cos(this.aimAngle), Math.sin(this.aimAngle), speed, this.spinSide, this.spinVertical);
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

  private resolveShot(): void {
    const verdict = evaluateShot(this.match, this.report, this.onTableBefore);
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
    this.hud.updatePlayers(this.match, this.onTableSet());

    if (verdict.gameOverReason !== null && this.match.winner !== null) {
      this.phase = 'over';
      this.hud.setControlsEnabled(false);
      this.sfx.win();
      this.hud.showOverlay(`¡Gana ${playerLabel(this.match.winner)}!`, verdict.gameOverReason, [
        { label: 'Otra partida', onAction: () => this.newGame() },
        { label: 'Cambiar modo', onAction: () => this.hud.showStart(), secondary: true },
      ]);
      return;
    }

    if (verdict.foul) this.sfx.foul();
    else if (verdict.turnChanged) this.sfx.turnChange();
    verdict.messages.forEach((m, i) => this.hud.toast(m, verdict.foul && i === 0 ? 'foul' : 'info'));
    if (verdict.turnChanged && !verdict.foul) this.hud.toast(`Turno de ${playerLabel(this.match.current)}`);
    if (this.stroll.active) {
      this.phase = 'aim';
      this.hud.updatePlayers(this.match, this.onTableSet());
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

  update(dt: number): void {
    this.time += dt;
    const cueBall = this.sim.balls[CUE];

    if (this.phase === 'roll') {
      this.handleEvents(this.sim.step(dt));
      const speed = this.sim.balls.reduce((s, b) => s + (b.onTable ? Math.hypot(b.vx, b.vz) : 0), 0);
      this.rollingLevel = Math.min(1, speed / 3);
      const dropping = this.sim.balls.some((b) => this.balls.isDropping(b.id));
      if (this.sim.isSettled() && !dropping) this.resolveShot();
    } else {
      this.rollingLevel = 0;
    }
    this.sfx.setRolling(this.rollingLevel);

    const aiming = this.phase === 'aim' && !this.stroll.active;
    if (aiming || this.phase === 'strike') {
      const origin = this.phase === 'strike' ? this.strikeOrigin : cueBall;
      this.cue.aim(origin.x, origin.z, this.aimAngle, this.power, this.spinSide, this.spinVertical);
    }
    this.cue.update(dt, this.strikeOrigin.x, this.strikeOrigin.z, this.aimAngle, this.spinSide, this.spinVertical);
    this.cue.fade(aiming || this.phase === 'strike' || this.cue.striking ? 1 : 0, dt);

    this.guide.setVisible(aiming && cueBall.onTable && this.assisted);
    if (aiming && this.assisted) {
      const prediction = predictAim(this.sim.balls, this.sim.segments, CUE, this.aimAngle);
      this.guide.update(cueBall.x, cueBall.z, this.aimAngle, prediction, this.isLegalTarget(prediction.target));
    }

    const inHand = aiming && this.match.ballInHand;
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
      this.hud.setHint(this.walkHint());
    }

    const focus = this.phase === 'strike' ? this.strikeOrigin : cueBall;
    this.rig.update(dt, focus.x, focus.z, this.aimAngle);
    this.drinks.update(this.rig.camera);
    this.stage.render();
  }
}
