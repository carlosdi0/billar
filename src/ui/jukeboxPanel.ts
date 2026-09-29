import { parseYouTubeUrl } from '../audio/youtube';

export interface JukeboxHandlers {
  onLoad(source: { list: string | null; video: string | null }): void;
  onToggle(): void;
  onNext(): void;
  onPrevious(): void;
  onClose(): void;
  onVolume(volume: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

const VOLUME_KEY = 'billar.jukeboxVolume';

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && localStorage.getItem(VOLUME_KEY) !== null ? v : 60;
  } catch {
    return 60;
  }
}

function saveVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Volume memory is a convenience only.
  }
}

/** Brass-framed jukebox holding the (visible, per YouTube's rules) embedded player. */
export class JukeboxPanel {
  readonly screen: HTMLElement;
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly form: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly credit: HTMLElement;
  private readonly error: HTMLElement;
  private readonly input: HTMLInputElement;

  constructor(parent: HTMLElement, handlers: JukeboxHandlers) {
    this.root = el('div', 'jukebox', parent);
    const header = el('div', 'jukebox-header', this.root);
    this.title = el('div', 'jukebox-title', header);
    this.title.textContent = 'Gramola';
    const grow = el('button', 'jukebox-icon', header);
    grow.type = 'button';
    grow.title = 'Agrandar';
    grow.textContent = '⤢';
    grow.addEventListener('click', () => {
      const large = this.root.classList.toggle('large');
      grow.title = large ? 'Reducir' : 'Agrandar';
    });
    const minimize = el('button', 'jukebox-icon', header);
    minimize.type = 'button';
    minimize.title = 'Minimizar';
    minimize.textContent = '–';
    minimize.addEventListener('click', () => {
      const min = this.root.classList.toggle('minimized');
      minimize.textContent = min ? '+' : '–';
    });
    const close = el('button', 'jukebox-icon', header);
    close.type = 'button';
    close.title = 'Quitar la música';
    close.textContent = '×';
    close.addEventListener('click', () => handlers.onClose());

    this.form = el('div', 'jukebox-form', this.root);
    el('div', 'jukebox-help', this.form).textContent = 'Pega el enlace de una playlist o un vídeo de YouTube:';
    this.input = el('input', 'field-input jukebox-input', this.form);
    this.input.placeholder = 'https://youtube.com/playlist?list=…';
    this.error = el('div', 'form-error', this.form);
    const play = el('button', 'overlay-button small', this.form);
    play.type = 'button';
    play.textContent = 'Poner música';
    const submit = () => {
      const source = parseYouTubeUrl(this.input.value);
      if (!source) {
        this.error.textContent = 'Ese enlace no parece de YouTube';
        return;
      }
      this.error.textContent = '';
      handlers.onLoad(source);
    };
    play.addEventListener('click', submit);
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
    });

    this.screen = el('div', 'jukebox-screen', this.root);
    this.controls = el('div', 'jukebox-controls', this.root);
    for (const [label, title, action] of [
      ['⏮', 'Anterior', handlers.onPrevious],
      ['⏯', 'Pausa / reproducir', handlers.onToggle],
      ['⏭', 'Siguiente', handlers.onNext],
    ] as const) {
      const b = el('button', 'jukebox-button', this.controls);
      b.type = 'button';
      b.title = title;
      b.textContent = label;
      b.addEventListener('click', () => action());
    }
    const volume = el('input', 'jukebox-volume', this.controls);
    volume.type = 'range';
    volume.min = '0';
    volume.max = '100';
    volume.value = String(loadVolume());
    volume.title = 'Volumen';
    volume.addEventListener('input', () => {
      const v = Number(volume.value);
      saveVolume(v);
      handlers.onVolume(v);
    });
    queueMicrotask(() => handlers.onVolume(Number(volume.value)));
    this.credit = el('div', 'jukebox-credit', this.root);
    this.showForm();
  }

  get visible(): boolean {
    return this.root.classList.contains('open');
  }

  open(): void {
    this.root.classList.add('open');
    this.root.classList.remove('minimized');
    if (!this.root.classList.contains('playing')) this.input.focus();
  }

  hide(): void {
    this.root.classList.remove('open');
  }

  showForm(): void {
    this.root.classList.remove('playing');
    this.title.textContent = 'Gramola';
    this.credit.textContent = '';
    this.input.value = '';
  }

  showPlaying(dj: string): void {
    this.root.classList.add('open', 'playing');
    this.credit.textContent = dj ? `DJ: ${dj}` : '';
  }

  setTrack(title: string): void {
    this.title.textContent = title || 'Gramola';
    this.title.title = title;
  }

  setError(message: string): void {
    this.error.textContent = message;
  }
}
