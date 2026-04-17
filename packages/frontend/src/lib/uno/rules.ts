import type { Card, Color, Direction, PlayerId } from './types';

const COLORS: Color[] = ['red', 'yellow', 'green', 'blue'];

function uuid(): string {
  return crypto.randomUUID();
}

export function buildDeck(): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    deck.push({ id: uuid(), color, kind: { kind: 'number', value: 0 } });
    for (let v = 1; v <= 9; v++) {
      deck.push({ id: uuid(), color, kind: { kind: 'number', value: v as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } });
      deck.push({ id: uuid(), color, kind: { kind: 'number', value: v as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 } });
    }
    for (const kind of ['skip', 'reverse', 'draw-two'] as const) {
      deck.push({ id: uuid(), color, kind: { kind } });
      deck.push({ id: uuid(), color, kind: { kind } });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ id: uuid(), color: 'wild', kind: { kind: 'wild' } });
    deck.push({ id: uuid(), color: 'wild', kind: { kind: 'wild-draw-four' } });
  }
  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function isValidPlay(card: Card, top: Card, activeColor: Color): boolean {
  if (card.color === 'wild') return true;
  if (card.color === activeColor) return true;
  if (top.kind.kind === 'number' && card.kind.kind === 'number' && top.kind.value === card.kind.value) return true;
  if (top.kind.kind !== 'number' && card.kind.kind === top.kind.kind) return true;
  return false;
}

export interface EffectResult {
  draws: number;
  skipNext: boolean;
  reverse: boolean;
  requiresColor: boolean;
}

export function applyCardEffect(card: Card): EffectResult {
  switch (card.kind.kind) {
    case 'skip':
      return { draws: 0, skipNext: true, reverse: false, requiresColor: false };
    case 'reverse':
      return { draws: 0, skipNext: false, reverse: true, requiresColor: false };
    case 'draw-two':
      return { draws: 2, skipNext: true, reverse: false, requiresColor: false };
    case 'wild':
      return { draws: 0, skipNext: false, reverse: false, requiresColor: true };
    case 'wild-draw-four':
      return { draws: 4, skipNext: true, reverse: false, requiresColor: true };
    default:
      return { draws: 0, skipNext: false, reverse: false, requiresColor: false };
  }
}

export function nextPlayer(order: PlayerId[], current: PlayerId, direction: Direction, skip: boolean): PlayerId {
  const idx = order.indexOf(current);
  const steps = skip ? 2 : 1;
  const n = order.length;
  const nextIdx = ((idx + direction * steps) % n + n) % n;
  return order[nextIdx];
}

export function reshuffleFromDiscard(discard: Card[]): { deck: Card[]; top: Card } {
  if (discard.length === 0) throw new Error('Cannot reshuffle empty discard');
  const top = discard[discard.length - 1];
  const rest = discard.slice(0, -1).map((c) => {
    if (c.kind.kind === 'wild' || c.kind.kind === 'wild-draw-four') {
      return { ...c, color: 'wild' as const };
    }
    return c;
  });
  return { deck: shuffle(rest), top };
}

export function cardLabel(card: Card): string {
  switch (card.kind.kind) {
    case 'number':
      return String(card.kind.value);
    case 'skip':
      return '⊘';
    case 'reverse':
      return '⇄';
    case 'draw-two':
      return '+2';
    case 'wild':
      return '★';
    case 'wild-draw-four':
      return '+4';
  }
}

export function cardAria(card: Card): string {
  const color = card.color === 'wild' ? 'wild' : card.color;
  switch (card.kind.kind) {
    case 'number':
      return `${color} ${card.kind.value}`;
    case 'skip':
      return `${color} skip`;
    case 'reverse':
      return `${color} reverse`;
    case 'draw-two':
      return `${color} draw two`;
    case 'wild':
      return 'wild';
    case 'wild-draw-four':
      return 'wild draw four';
  }
}
