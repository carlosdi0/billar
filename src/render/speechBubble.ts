import * as THREE from 'three';

const CANVAS_W = 512;
const CANVAS_H = 256;
const FONT_SIZE = 34;
const LINE_HEIGHT = 42;
const MAX_LINES = 4;
const PADDING_X = 26;
const PADDING_Y = 18;
const TAIL = 22;
const BORDER = 4;
const MAX_TEXT_WIDTH = CANVAS_W - PADDING_X * 2 - BORDER * 2;
/** World meters per canvas pixel, per meter of camera distance. */
const PIXEL_DISTANCE_K = 0.045 / 80;
const PIXEL_MIN = 0.07 / 80;
const PIXEL_MAX = 0.26 / 80;
const FADE_TIME = 0.6;
const HIDE_DISTANCE = 0.6;

function wrap(ctx: CanvasRenderingContext2D, text: string): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= MAX_TEXT_WIDTH) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (ctx.measureText(line).width > MAX_TEXT_WIDTH) {
      const chars = Array.from(line);
      let cut = chars.length - 1;
      while (cut > 1 && ctx.measureText(chars.slice(0, cut).join('')).width > MAX_TEXT_WIDTH) cut--;
      lines.push(chars.slice(0, cut).join(''));
      line = chars.slice(cut).join('');
    }
  }
  if (line) lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    lines[MAX_LINES - 1] = `${lines[MAX_LINES - 1].replace(/.$/u, '')}…`;
  }
  return lines;
}

/** A chat bubble that floats over a character's head for a few seconds. */
export class SpeechBubble {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private remaining = 0;

  constructor() {
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthWrite: false, depthTest: false }),
    );
    this.sprite.center.set(0.5, 0);
    this.sprite.renderOrder = 11;
    this.sprite.visible = false;
  }

  say(text: string): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.font = `${FONT_SIZE}px Georgia, 'Times New Roman', serif`;
    const lines = wrap(ctx, text);
    const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = Math.min(CANVAS_W - BORDER * 2, textWidth + PADDING_X * 2);
    const h = lines.length * LINE_HEIGHT + PADDING_Y * 2;
    const x = (CANVAS_W - w) / 2;
    const y = CANVAS_H - TAIL - h - BORDER;
    const cx = CANVAS_W / 2;

    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.beginPath();
    const r = 22;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.lineTo(cx + 16, y + h);
    ctx.lineTo(cx, y + h + TAIL);
    ctx.lineTo(cx - 16, y + h);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(246, 234, 206, 0.96)';
    ctx.fill();
    ctx.lineWidth = BORDER;
    ctx.strokeStyle = '#6b4a26';
    ctx.stroke();

    ctx.fillStyle = '#2a1a0e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, cx, y + PADDING_Y + LINE_HEIGHT * (i + 0.5)));
    this.texture.needsUpdate = true;

    this.remaining = THREE.MathUtils.clamp(2.5 + Array.from(text).length * 0.07, 3.5, 9);
  }

  /** Anchor is the point just above the head; the bubble's tail touches it. */
  update(dt: number, x: number, y: number, z: number, camera: THREE.Vector3, visible = true): void {
    this.remaining = Math.max(0, this.remaining - dt);
    const dist = Math.hypot(x - camera.x, y - camera.y, z - camera.z);
    this.sprite.visible = visible && this.remaining > 0 && dist > HIDE_DISTANCE;
    if (!this.sprite.visible) return;
    const pixel = THREE.MathUtils.clamp(dist * PIXEL_DISTANCE_K, PIXEL_MIN, PIXEL_MAX);
    this.sprite.scale.set(CANVAS_W * pixel, CANVAS_H * pixel, 1);
    this.sprite.position.set(x, y, z);
    this.sprite.material.opacity = Math.min(1, this.remaining / FADE_TIME);
  }

  dispose(): void {
    this.texture.dispose();
    this.sprite.material.dispose();
  }
}
