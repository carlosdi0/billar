import { MAX_CHAT_LENGTH } from '../net/protocol';

export interface ChatHandlers {
  onSend(text: string): void;
}

const MAX_LINES = 8;
const LINE_LIFETIME = 12_000;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.appendChild(node);
  return node;
}

/** Room chat: a fading log in the corner plus a text field opened with Enter. */
export class ChatPanel {
  private readonly root: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private enabled = false;

  constructor(parent: HTMLElement, handlers: ChatHandlers) {
    this.root = el('div', 'chat', parent);
    this.log = el('div', 'chat-log', this.root);
    const form = el('form', 'chat-form', this.root);
    this.input = el('input', 'chat-input', form);
    this.input.type = 'text';
    this.input.maxLength = MAX_CHAT_LENGTH;
    this.input.placeholder = 'Di algo… (Enter para enviar, Esc para cerrar)';
    this.input.autocomplete = 'off';
    this.input.enterKeyHint = 'send';

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value;
      this.input.value = '';
      this.close();
      if (text.trim()) handlers.onSend(text);
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.input.value = '';
        this.close();
      }
    });
    this.input.addEventListener('blur', () => this.close());
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.classList.toggle('enabled', enabled);
    if (!enabled) {
      this.close();
      this.log.replaceChildren();
    }
  }

  open(): void {
    if (!this.enabled) return;
    this.root.classList.add('open');
    this.input.focus();
  }

  close(): void {
    this.root.classList.remove('open');
    if (document.activeElement === this.input) this.input.blur();
  }

  add(name: string, text: string, mine = false): void {
    const line = el('div', `chat-line${mine ? ' mine' : ''}`, this.log);
    el('span', 'chat-name', line).textContent = name;
    el('span', 'chat-text', line).textContent = text;
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild?.remove();
    window.setTimeout(() => line.classList.add('old'), LINE_LIFETIME);
  }
}
