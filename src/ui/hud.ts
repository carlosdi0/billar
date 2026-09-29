import { BALL_COLORS } from '../render/textures';
import { groupBalls, groupLabel, playerLabel, type MatchState, type PlayerIndex } from '../game/rules';
import { buildOnlineForm, roomCodeFromUrl, type OnlineChoice } from './lobby';

export interface HudHandlers {
  onPowerChange(power: number): void;
  onShoot(power: number): void;
  onSpinChange(side: number, vertical: number): void;
  onFineAim(delta: number): void;
  onToggleView(): void;
  onToggleSound(): void;
  onToggleMusic(): void;
  onStandUp(): void;
  onRestart(): void;
  onStart(assisted: boolean): void;
  onOnline(choice: OnlineChoice): void;
}

export interface OverlayAction {
  label: string;
  onAction: () => void;
  secondary?: boolean;
}

const ICONS = {
  camera3d: '<svg viewBox="0 0 24 24"><path d="M3 17l9 4 9-4M3 12l9 4 9-4M12 3l9 4-9 4-9-4z"/></svg>',
  cameraTop: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  musicOff: '<svg viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/><path d="M3 3l18 18"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4" r="2"/><path d="M11 21l2-6 3 3v3M8 12l3-4 3 1 2 4 3 1M11 8l-1 5"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 108-8H7"/><path d="M9 1L6 4l3 3"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

function miniBall(num: number): HTMLElement {
  const ball = el('span', 'mini-ball');
  const color = BALL_COLORS[num] ?? '#eee';
  ball.style.setProperty('--c', color);
  if (num >= 9) ball.classList.add('stripe');
  ball.textContent = String(num);
  return ball;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly players: { panel: HTMLElement; name: HTMLElement; group: HTMLElement; balls: HTMLElement }[] = [];
  private readonly toastBox: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly powerFill: HTMLElement;
  private readonly powerPanel: HTMLElement;
  private readonly spinDot: HTMLElement;
  private readonly viewButton: HTMLButtonElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly musicButton: HTMLButtonElement;
  private readonly standButton: HTMLButtonElement;
  private currentHint = '';
  private readonly overlay: HTMLElement;
  private readonly controls: HTMLElement;
  private toastTimer = 0;

  constructor(parent: HTMLElement, private readonly handlers: HudHandlers) {
    this.root = el('div', 'hud', parent);

    const board = el('div', 'scoreboard', this.root);
    for (const p of [0, 1] as PlayerIndex[]) {
      if (p === 1) el('div', 'versus', board).textContent = '8';
      const panel = el('div', `player p${p}`, board);
      const name = el('div', 'player-name', panel);
      name.textContent = playerLabel(p);
      const group = el('div', 'player-group', panel);
      const balls = el('div', 'player-balls', panel);
      this.players.push({ panel, name, group, balls });
    }

    const buttons = el('div', 'buttons', this.root);
    this.viewButton = this.button(buttons, ICONS.cameraTop, 'Cambiar cámara', handlers.onToggleView);
    this.soundButton = this.button(buttons, ICONS.sound, 'Sonido', handlers.onToggleSound);
    this.musicButton = this.button(buttons, ICONS.music, 'Música', handlers.onToggleMusic);
    this.standButton = this.button(buttons, ICONS.walk, 'Levantarse y pasear (Q)', handlers.onStandUp);
    this.button(buttons, ICONS.restart, 'Nueva partida', handlers.onRestart);

    this.toastBox = el('div', 'toasts', this.root);
    this.hint = el('div', 'hint', this.root);

    this.controls = el('div', 'controls', this.root);
    this.powerPanel = el('div', 'power', this.controls);
    el('div', 'power-label', this.powerPanel).textContent = 'Fuerza';
    const track = el('div', 'power-track', this.powerPanel);
    this.powerFill = el('div', 'power-fill', track);
    el('div', 'power-grip', track);
    el('div', 'power-help', this.powerPanel).textContent = 'arrastra ↓';
    this.bindPower(track);

    const spin = el('div', 'spin', this.controls);
    const face = el('div', 'spin-face', spin);
    this.spinDot = el('div', 'spin-dot', face);
    el('div', 'spin-label', spin).textContent = 'Efecto';
    this.bindSpin(face);

    const fine = el('div', 'fine', this.controls);
    el('div', 'fine-ridges', fine);
    el('div', 'fine-label', fine).textContent = 'Ajuste';
    this.bindFine(fine);

    this.overlay = el('div', 'overlay', parent);
  }

  private button(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', 'icon-button', parent);
    b.innerHTML = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private bindPower(track: HTMLElement): void {
    let startY = 0;
    let active = false;
    let power = 0;
    const update = (y: number) => {
      const rect = track.getBoundingClientRect();
      power = Math.min(1, Math.max(0, (y - startY) / (rect.height * 0.85)));
      this.setPower(power);
      this.handlers.onPowerChange(power);
    };
    track.addEventListener('pointerdown', (e) => {
      if (this.powerPanel.classList.contains('disabled')) return;
      active = true;
      startY = e.clientY;
      track.setPointerCapture(e.pointerId);
      update(e.clientY);
    });
    track.addEventListener('pointermove', (e) => active && update(e.clientY));
    const release = () => {
      if (!active) return;
      active = false;
      if (power > 0.02) this.handlers.onShoot(power);
      else this.handlers.onPowerChange(0);
      this.setPower(0);
      power = 0;
    };
    track.addEventListener('pointerup', release);
    track.addEventListener('pointercancel', () => {
      active = false;
      power = 0;
      this.setPower(0);
      this.handlers.onPowerChange(0);
    });
  }

  private bindSpin(face: HTMLElement): void {
    let active = false;
    const update = (e: PointerEvent) => {
      const rect = face.getBoundingClientRect();
      let x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      let y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
      this.setSpin(x, y);
      this.handlers.onSpinChange(x, y);
    };
    face.addEventListener('pointerdown', (e) => {
      active = true;
      face.setPointerCapture(e.pointerId);
      update(e);
    });
    face.addEventListener('pointermove', (e) => active && update(e));
    face.addEventListener('pointerup', () => (active = false));
    face.addEventListener('dblclick', () => {
      this.setSpin(0, 0);
      this.handlers.onSpinChange(0, 0);
    });
  }

  private bindFine(strip: HTMLElement): void {
    let lastY = 0;
    let offset = 0;
    let active = false;
    const ridges = strip.querySelector<HTMLElement>('.fine-ridges')!;
    strip.addEventListener('pointerdown', (e) => {
      active = true;
      lastY = e.clientY;
      strip.setPointerCapture(e.pointerId);
    });
    strip.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      offset += dy;
      ridges.style.backgroundPositionY = `${offset}px`;
      this.handlers.onFineAim(dy * 0.0007);
    });
    strip.addEventListener('pointerup', () => (active = false));
  }

  setPower(power: number): void {
    this.powerFill.style.height = `${power * 100}%`;
    this.powerPanel.style.setProperty('--power', String(power));
  }

  setSpin(side: number, vertical: number): void {
    this.spinDot.style.left = `${50 + side * 38}%`;
    this.spinDot.style.top = `${50 - vertical * 38}%`;
  }

  setControlsEnabled(enabled: boolean): void {
    this.controls.classList.toggle('disabled', !enabled);
    this.powerPanel.classList.toggle('disabled', !enabled);
  }

  setViewMode(mode: 'aim' | 'top'): void {
    this.viewButton.innerHTML = mode === 'aim' ? ICONS.cameraTop : ICONS.camera3d;
  }

  setMuted(muted: boolean): void {
    this.soundButton.innerHTML = muted ? ICONS.mute : ICONS.sound;
  }

  setMusic(on: boolean): void {
    this.musicButton.innerHTML = on ? ICONS.music : ICONS.musicOff;
  }

  setStandUpAvailable(available: boolean): void {
    this.standButton.style.display = available ? '' : 'none';
  }

  setWalkMode(walking: boolean): void {
    this.root.classList.toggle('walking', walking);
  }

  setHint(text: string | null): void {
    if ((text ?? '') === this.currentHint) return;
    this.currentHint = text ?? '';
    this.hint.textContent = text ?? '';
    this.hint.classList.toggle('visible', !!text);
  }

  updatePlayers(state: MatchState, onTable: ReadonlySet<number>, names?: readonly string[]): void {
    this.players.forEach((view, i) => {
      view.name.textContent = names?.[i] ?? playerLabel(i as PlayerIndex);
      const group = state.groups[i];
      view.panel.classList.toggle('active', state.current === i && state.winner === null);
      view.group.textContent = group ? groupLabel(group) : 'mesa abierta';
      view.balls.replaceChildren();
      if (!group) return;
      for (const n of groupBalls(group)) {
        const ball = miniBall(n);
        if (!onTable.has(n)) ball.classList.add('potted');
        view.balls.appendChild(ball);
      }
      const eight = miniBall(8);
      eight.classList.add('eight');
      if (groupBalls(group).some((n) => onTable.has(n))) eight.classList.add('locked');
      view.balls.appendChild(eight);
    });
  }

  toast(message: string, kind: 'info' | 'foul' | 'good' = 'info'): void {
    const item = el('div', `toast ${kind}`, this.toastBox);
    item.textContent = message;
    while (this.toastBox.children.length > 3) this.toastBox.firstElementChild?.remove();
    window.clearTimeout(this.toastTimer);
    setTimeout(() => item.classList.add('leaving'), 3200);
    setTimeout(() => item.remove(), 3800);
  }

  showOverlay(title: string, subtitle: string, actions: OverlayAction[]): void {
    this.overlay.innerHTML = '';
    const card = el('div', 'overlay-card', this.overlay);
    el('div', 'overlay-ornament', card).textContent = '✦ ✦ ✦';
    el('h1', 'overlay-title', card).textContent = title;
    el('p', 'overlay-subtitle', card).textContent = subtitle;
    const row = el('div', 'overlay-actions', card);
    for (const action of actions) {
      const button = el('button', `overlay-button${action.secondary ? ' secondary' : ''}`, row);
      button.innerHTML = action.label;
      button.addEventListener('click', () => {
        this.hideOverlay();
        action.onAction();
      });
    }
    this.overlay.classList.add('visible');
  }

  showStart(): void {
    const preset = roomCodeFromUrl();
    if (preset) {
      this.showOnlineForm(preset);
      return;
    }
    this.showOverlay('Ases y Ochos', 'Billar bola 8 en el saloon. Tira con los colegas aquí mismo o quedad online.', [
      { label: 'Partida local<small>dos jugadores, un dispositivo</small>', onAction: () => this.showLocalModes() },
      { label: 'Jugar online<small>crea una sala o únete a una</small>', onAction: () => this.showOnlineForm(null), secondary: true },
    ]);
  }

  showLocalModes(): void {
    this.showOverlay('Partida local', 'Elige la dificultad.', [
      { label: 'Normal<small>con guía de tiro</small>', onAction: () => this.handlers.onStart(true) },
      { label: 'Difícil<small>sin guía, a ojo de pistolero</small>', onAction: () => this.handlers.onStart(false), secondary: true },
      { label: '← volver', onAction: () => this.showStart(), secondary: true },
    ]);
  }

  showOnlineForm(presetCode: string | null): void {
    const subtitle = presetCode
      ? `Te han invitado a la sala ${presetCode}.`
      : 'Elige nombre y personaje. Crea una sala y comparte el enlace, o escribe un código.';
    this.showOverlay('Jugar online', subtitle, []);
    const card = this.overlay.querySelector<HTMLElement>('.overlay-card')!;
    card.classList.add('wide');
    buildOnlineForm(
      card,
      presetCode,
      (choice) => {
        this.hideOverlay();
        this.handlers.onOnline(choice);
      },
      () => {
        history.replaceState(null, '', location.pathname);
        this.showStart();
      },
    );
  }

  hideOverlay(): void {
    this.overlay.classList.remove('visible');
  }
}
