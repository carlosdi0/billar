export type Group = 'solids' | 'stripes';
export type PlayerIndex = 0 | 1;

export interface ShotReport {
  firstHit: number | null;
  pocketed: number[];
  railAfterContact: boolean;
}

export interface MatchState {
  current: PlayerIndex;
  groups: [Group | null, Group | null];
  isBreak: boolean;
  ballInHand: boolean;
  kitchenOnly: boolean;
  winner: PlayerIndex | null;
}

export interface Verdict {
  state: MatchState;
  foul: string | null;
  messages: string[];
  respotEight: boolean;
  respotCue: boolean;
  turnChanged: boolean;
  gameOverReason: string | null;
}

export const SOLIDS = [1, 2, 3, 4, 5, 6, 7];
export const STRIPES = [9, 10, 11, 12, 13, 14, 15];

export function groupOf(ball: number): Group | null {
  if (ball >= 1 && ball <= 7) return 'solids';
  if (ball >= 9 && ball <= 15) return 'stripes';
  return null;
}

export function groupBalls(group: Group): number[] {
  return group === 'solids' ? SOLIDS : STRIPES;
}

export function groupLabel(group: Group): string {
  return group === 'solids' ? 'lisas' : 'rayadas';
}

export function playerLabel(p: PlayerIndex): string {
  return `Jugador ${p + 1}`;
}

export function newMatch(breaker: PlayerIndex = 0): MatchState {
  return {
    current: breaker,
    groups: [null, null],
    isBreak: true,
    ballInHand: true,
    kitchenOnly: true,
    winner: null,
  };
}

function other(p: PlayerIndex): PlayerIndex {
  return p === 0 ? 1 : 0;
}

/** True when the player has no balls of their group left, so the 8 is their target. */
export function isOnEight(state: MatchState, player: PlayerIndex, onTable: ReadonlySet<number>): boolean {
  const group = state.groups[player];
  return group !== null && groupBalls(group).every((b) => !onTable.has(b));
}

/**
 * Evaluate a finished shot.
 * @param onTableBefore balls on the table when the shot was taken (cue ball included)
 */
export function evaluateShot(
  state: MatchState,
  report: ShotReport,
  onTableBefore: ReadonlySet<number>,
  names: readonly string[] = [playerLabel(0), playerLabel(1)],
): Verdict {
  const label = (p: PlayerIndex) => names[p] ?? playerLabel(p);
  const player = state.current;
  const opponent = other(player);
  const next: MatchState = { ...state, groups: [...state.groups] as [Group | null, Group | null] };
  const messages: string[] = [];
  const objectPocketed = report.pocketed.filter((b) => b !== 0);
  const cueScratch = report.pocketed.includes(0);
  const eightPocketed = objectPocketed.includes(8);
  const wasOnEight = isOnEight(state, player, onTableBefore);
  const ownGroup = state.groups[player];

  let foul: string | null = null;
  if (cueScratch) foul = 'La blanca se fue a la tronera';
  else if (report.firstHit === null) foul = 'No tocaste ninguna bola';
  else if (ownGroup === null && report.firstHit === 8 && !state.isBreak) foul = 'Con la mesa abierta no puedes dar primero a la 8';
  else if (ownGroup !== null && !wasOnEight && groupOf(report.firstHit) !== ownGroup) foul = `Tenías que dar primero a una de tus ${groupLabel(ownGroup)}`;
  else if (ownGroup !== null && wasOnEight && report.firstHit !== 8) foul = 'Tenías que dar primero a la 8';
  else if (!state.isBreak && objectPocketed.length === 0 && !report.railAfterContact) foul = 'Ninguna bola tocó banda tras el contacto';

  const finish = (winner: PlayerIndex, reason: string): Verdict => {
    next.winner = winner;
    return {
      state: next,
      foul,
      messages,
      respotEight: false,
      respotCue: false,
      turnChanged: false,
      gameOverReason: reason,
    };
  };

  let respotEight = false;
  if (eightPocketed) {
    if (state.isBreak) {
      respotEight = true;
      messages.push('La 8 entró en el saque: se recoloca');
    } else if (foul) {
      return finish(opponent, `${label(player)} metió la 8 con falta`);
    } else if (!wasOnEight) {
      return finish(opponent, `${label(player)} metió la 8 antes de tiempo`);
    } else {
      return finish(player, `${label(player)} metió la 8`);
    }
  }

  if (!foul && !state.isBreak && ownGroup === null) {
    const firstGroupBall = objectPocketed.map(groupOf).find((g): g is Group => g !== null);
    if (firstGroupBall) {
      next.groups[player] = firstGroupBall;
      next.groups[opponent] = firstGroupBall === 'solids' ? 'stripes' : 'solids';
      messages.push(`${label(player)} juega con las ${groupLabel(firstGroupBall)}`);
    }
  }

  const scoringGroup = next.groups[player];
  const scored = scoringGroup === null
    ? objectPocketed.some((b) => b !== 8)
    : objectPocketed.some((b) => groupOf(b) === scoringGroup);

  const keepsTurn = !foul && scored;
  next.isBreak = false;
  next.ballInHand = foul !== null;
  next.kitchenOnly = foul !== null && state.isBreak && cueScratch;
  next.current = keepsTurn ? player : opponent;
  if (foul) messages.unshift(`Falta: ${foul}. Bola en mano para ${label(opponent)}`);

  return {
    state: next,
    foul,
    messages,
    respotEight,
    respotCue: cueScratch,
    turnChanged: next.current !== player,
    gameOverReason: null,
  };
}
