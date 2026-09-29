import './ui/style.css';
import { Game } from './game/game';
import { detectQuality } from './render/stage';

const container = document.getElementById('app')!;
const quality = new URLSearchParams(location.search).get('quality') === 'low' ? 'low' : detectQuality();
const game = new Game(container, quality);
if (import.meta.env.DEV) Object.assign(window, { game });

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  game.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
