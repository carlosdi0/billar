import { DEFAULT_LOOKS } from '../render/character';
import type { JamInfo, PlayerInfo } from '../net/protocol';
import { JAM_URL_PATTERN, MAX_NAME_LENGTH, ROOM_CODE_PATTERN } from '../net/protocol';
import type { RoomStatus } from '../net/room';

export interface OnlineChoice {
  name: string;
  look: number;
  code: string | null;
}

export interface LobbyHandlers {
  onStartMatch(assisted: boolean): void;
  onLeave(): void;
  onShareJam(url: string | null): void;
}

const SEAT_COLORS = ['#e0b04a', '#d8492c', '#4a8ad8', '#6fb04a'];
const PROFILE_KEY = 'billar.profile';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

export function loadProfile(): { name: string; look: number } {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { name?: unknown; look?: unknown };
      return {
        name: typeof parsed.name === 'string' ? parsed.name.slice(0, MAX_NAME_LENGTH) : '',
        look: typeof parsed.look === 'number' ? parsed.look % DEFAULT_LOOKS.length : 0,
      };
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { name: '', look: Math.floor(Math.random() * DEFAULT_LOOKS.length) };
}

function saveProfile(name: string, look: number): void {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify({ name, look }));
  } catch {
    // Ignore: the profile is a convenience.
  }
}

export function roomCodeFromUrl(): string | null {
  const code = new URLSearchParams(location.search).get('sala')?.toUpperCase() ?? null;
  return code && ROOM_CODE_PATTERN.test(code) ? code : null;
}

export function roomLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('sala', code);
  return url.toString();
}

/** Parchment form to pick a name, a character and a room. */
export function buildOnlineForm(card: HTMLElement, presetCode: string | null, onSubmit: (choice: OnlineChoice) => void, onBack: () => void): void {
  const profile = loadProfile();
  let look = profile.look;

  const form = el('form', 'online-form', card);
  const nameLabel = el('label', 'field', form);
  el('span', 'field-label', nameLabel).textContent = 'Tu nombre';
  const name = el('input', 'field-input', nameLabel);
  name.maxLength = MAX_NAME_LENGTH;
  name.placeholder = 'Forastero';
  name.value = profile.name;
  name.setAttribute('autocomplete', 'nickname');

  el('span', 'field-label', form).textContent = 'Personaje';
  const looks = el('div', 'look-grid', form);
  const lookButtons: HTMLButtonElement[] = [];
  DEFAULT_LOOKS.forEach((l, i) => {
    const b = el('button', 'look-option', looks);
    b.type = 'button';
    b.style.setProperty('--vest', l.vest);
    b.style.setProperty('--shirt', l.shirt);
    b.style.setProperty('--hat', l.hat === 'none' ? 'transparent' : l.hatColor);
    b.style.setProperty('--skin', l.skin);
    el('span', 'look-figure', b);
    el('span', 'look-name', b).textContent = (l as { name?: string }).name ?? `Tipo ${i + 1}`;
    b.addEventListener('click', () => {
      look = i;
      lookButtons.forEach((x, j) => x.classList.toggle('selected', j === i));
    });
    lookButtons.push(b);
  });
  lookButtons[look]?.classList.add('selected');

  const codeLabel = el('label', 'field', form);
  el('span', 'field-label', codeLabel).textContent = presetCode ? 'Sala' : 'Código de sala (para unirte)';
  const code = el('input', 'field-input code', codeLabel);
  code.maxLength = 8;
  code.placeholder = 'p. ej. K7QX2';
  code.value = presetCode ?? '';
  code.autocapitalize = 'characters';
  code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));

  const error = el('div', 'form-error', form);
  const actions = el('div', 'overlay-actions', form);
  const submit = (join: boolean) => {
    const cleanName = name.value.trim().slice(0, MAX_NAME_LENGTH) || 'Forastero';
    const cleanCode = code.value.trim().toUpperCase();
    if (join && !ROOM_CODE_PATTERN.test(cleanCode)) {
      error.textContent = 'El código tiene que tener entre 4 y 8 letras o números';
      return;
    }
    saveProfile(cleanName, look);
    onSubmit({ name: cleanName, look, code: join ? cleanCode : null });
  };
  const join = el('button', 'overlay-button', actions);
  join.type = 'submit';
  join.textContent = presetCode ? 'Entrar en la sala' : 'Unirse';
  if (!presetCode) {
    const create = el('button', 'overlay-button secondary', actions);
    create.type = 'button';
    create.textContent = 'Crear sala nueva';
    create.addEventListener('click', () => submit(false));
  }
  const back = el('button', 'overlay-link', form);
  back.type = 'button';
  back.textContent = '← volver';
  back.addEventListener('click', onBack);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit(true);
  });
  if (!profile.name) name.focus();
}

/** Small room card shown during online play. */
export class LobbyPanel {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly list: HTMLElement;
  private readonly actions: HTMLElement;
  private readonly note: HTMLElement;
  private readonly jamBox: HTMLElement;
  private collapsed = false;

  constructor(parent: HTMLElement, private readonly code: string, private readonly handlers: LobbyHandlers) {
    this.root = el('div', 'lobby', parent);
    const header = el('div', 'lobby-header', this.root);
    this.title = el('div', 'lobby-title', header);
    this.title.textContent = `Sala ${code}`;
    const copy = el('button', 'lobby-copy', header);
    copy.type = 'button';
    copy.textContent = 'Copiar enlace';
    copy.addEventListener('click', async () => {
      const link = roomLink(code);
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: 'Ases y Ochos', url: link });
        else await navigator.clipboard.writeText(link);
        copy.textContent = '¡Copiado!';
      } catch {
        prompt('Copia este enlace:', link);
      }
      setTimeout(() => (copy.textContent = 'Copiar enlace'), 1800);
    });
    const toggle = el('button', 'lobby-toggle', header);
    toggle.type = 'button';
    toggle.textContent = '–';
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.root.classList.toggle('collapsed', this.collapsed);
      toggle.textContent = this.collapsed ? '+' : '–';
    });
    this.status = el('div', 'lobby-status', this.root);
    this.list = el('ul', 'lobby-list', this.root);
    this.note = el('div', 'lobby-note', this.root);
    this.actions = el('div', 'lobby-actions', this.root);
    this.jamBox = el('div', 'lobby-jam', this.root);
    this.setJam(null, '');
    const leave = el('button', 'overlay-link lobby-leave', this.root);
    leave.type = 'button';
    leave.textContent = 'Salir de la sala';
    leave.addEventListener('click', () => this.handlers.onLeave());
  }

  setStatus(status: RoomStatus): void {
    const text: Record<RoomStatus, string> = {
      connecting: 'Conectando…',
      open: '',
      reconnecting: 'Reconectando…',
      closed: 'Desconectado',
    };
    this.status.textContent = text[status];
    this.status.classList.toggle('visible', status !== 'open');
  }

  update(players: PlayerInfo[], myId: string, playing: boolean): void {
    this.list.replaceChildren();
    const sorted = [...players].sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
    for (const p of sorted) {
      const item = el('li', `lobby-player${p.connected ? '' : ' offline'}`, this.list);
      const dot = el('span', 'lobby-dot', item);
      dot.style.background = p.seat === null ? '#777' : SEAT_COLORS[p.seat];
      el('span', 'lobby-name', item).textContent = `${p.name}${p.id === myId ? ' (tú)' : ''}`;
      const tags = [p.host ? 'anfitrión' : '', p.seat === null ? 'espectador' : '', p.connected ? '' : 'desconectado'].filter(Boolean);
      if (tags.length) el('span', 'lobby-tag', item).textContent = tags.join(' · ');
    }

    const me = players.find((p) => p.id === myId);
    const seated = players.filter((p) => p.seat !== null && p.connected).length;
    this.actions.replaceChildren();
    this.root.classList.toggle('playing', playing);
    if (playing) {
      this.note.textContent = '';
      return;
    }
    if (me?.host) {
      this.note.textContent = seated < 2 ? 'Comparte el enlace: hacen falta al menos 2 jugadores' : 'Cuando estéis todos, empieza la partida';
      for (const [label, assisted] of [['Empezar', true], ['Empezar sin guía', false]] as const) {
        const b = el('button', `overlay-button small${assisted ? '' : ' secondary'}`, this.actions);
        b.type = 'button';
        b.textContent = label;
        b.disabled = seated < 2;
        b.addEventListener('click', () => this.handlers.onStartMatch(assisted));
      }
    } else {
      this.note.textContent = 'Esperando a que el anfitrión empiece la partida…';
    }
  }

  setJam(jam: JamInfo | null, byName: string): void {
    const box = this.jamBox;
    box.replaceChildren();
    if (jam) {
      el('div', 'jam-title', box).textContent = `🎵 Spotify Jam de ${byName}`;
      const row = el('div', 'jam-row', box);
      const join = el('a', 'overlay-button small jam-join', row);
      join.href = jam.url;
      join.target = '_blank';
      join.rel = 'noopener noreferrer';
      join.textContent = 'Unirse al Jam';
      const clear = el('button', 'lobby-copy', row);
      clear.type = 'button';
      clear.textContent = 'Quitar';
      clear.addEventListener('click', () => this.handlers.onShareJam(null));
      return;
    }
    const open = el('button', 'overlay-link jam-open', box);
    open.type = 'button';
    open.textContent = '🎵 Poner música con Spotify Jam';
    open.addEventListener('click', () => {
      box.replaceChildren();
      el('div', 'jam-help', box).textContent =
        'En Spotify (Premium): pon una canción → icono de dispositivos → Iniciar un Jam → Invitar → Copiar enlace. Pégalo aquí:';
      const input = el('input', 'field-input jam-input', box);
      input.placeholder = 'https://spotify.link/…';
      const error = el('div', 'form-error', box);
      const row = el('div', 'jam-row', box);
      const share = el('button', 'overlay-button small', row);
      share.type = 'button';
      share.textContent = 'Compartir';
      const cancel = el('button', 'lobby-copy', row);
      cancel.type = 'button';
      cancel.textContent = 'Cancelar';
      cancel.addEventListener('click', () => this.setJam(null, ''));
      share.addEventListener('click', () => {
        const url = input.value.trim();
        if (!JAM_URL_PATTERN.test(url)) {
          error.textContent = 'Tiene que ser un enlace de Spotify (spotify.link u open.spotify.com)';
          return;
        }
        this.handlers.onShareJam(url);
      });
      input.focus();
    });
  }

  dispose(): void {
    this.root.remove();
  }

  get roomCode(): string {
    return this.code;
  }
}
