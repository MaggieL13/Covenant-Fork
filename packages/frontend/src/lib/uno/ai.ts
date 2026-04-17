import type { Card, CardColor, Color, PlayerId } from './types';
import { isValidPlay } from './rules';

export type AiMove =
  | { type: 'play'; cardId: string; chosenColor?: Color }
  | { type: 'draw' };

interface OpponentInfo {
  id: PlayerId;
  handCount: number;
}

function cardPriority(card: Card): number {
  switch (card.kind.kind) {
    case 'number':
      return card.kind.value;
    case 'skip':
    case 'reverse':
      return 20;
    case 'draw-two':
      return 30;
    case 'wild':
      return 40;
    case 'wild-draw-four':
      return 50;
  }
}

function pickColorByHand(hand: Card[]): Color {
  const counts: Record<Color, number> = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of hand) {
    if (c.color !== 'wild') counts[c.color]++;
  }
  const entries = Object.entries(counts) as [Color, number][];
  entries.sort((a, b) => b[1] - a[1]);
  if (entries[0][1] === 0) {
    const pool: Color[] = ['red', 'yellow', 'green', 'blue'];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  return entries[0][0];
}

function pickMoveZephyr(hand: Card[], top: Card, activeColor: Color): AiMove {
  const playable = hand.filter((c) => isValidPlay(c, top, activeColor));
  if (playable.length === 0) return { type: 'draw' };

  const wildFour = playable.find((c) => c.kind.kind === 'wild-draw-four');
  if (wildFour) {
    const remaining = hand.filter((c) => c.id !== wildFour.id);
    return { type: 'play', cardId: wildFour.id, chosenColor: pickColorByHand(remaining) };
  }

  const drawTwo = playable.find((c) => c.kind.kind === 'draw-two');
  if (drawTwo) return { type: 'play', cardId: drawTwo.id };

  const sorted = [...playable].sort((a, b) => cardPriority(b) - cardPriority(a));
  const pick = sorted[0];
  if (pick.color === 'wild') {
    const remaining = hand.filter((c) => c.id !== pick.id);
    return { type: 'play', cardId: pick.id, chosenColor: pickColorByHand(remaining) };
  }
  return { type: 'play', cardId: pick.id };
}

function pickMoveCaelir(hand: Card[], top: Card, activeColor: Color, opponents: OpponentInfo[]): AiMove {
  const playable = hand.filter((c) => isValidPlay(c, top, activeColor));
  if (playable.length === 0) return { type: 'draw' };

  const threatened = opponents.some((o) => o.handCount === 1);
  if (threatened) {
    const punish = playable.find((c) => c.kind.kind === 'wild-draw-four' || c.kind.kind === 'draw-two');
    if (punish) {
      if (punish.color === 'wild') {
        const remaining = hand.filter((c) => c.id !== punish.id);
        return { type: 'play', cardId: punish.id, chosenColor: pickColorByHand(remaining) };
      }
      return { type: 'play', cardId: punish.id };
    }
  }

  const numberPlays = playable.filter((c) => c.kind.kind === 'number');
  if (numberPlays.length > 0) {
    const sorted = [...numberPlays].sort((a, b) => cardPriority(a) - cardPriority(b));
    return { type: 'play', cardId: sorted[0].id };
  }

  if (hand.length >= 4) {
    const nonPower = playable.filter((c) => c.color !== 'wild' && c.kind.kind !== 'draw-two');
    if (nonPower.length > 0) {
      const sorted = [...nonPower].sort((a, b) => cardPriority(a) - cardPriority(b));
      return { type: 'play', cardId: sorted[0].id };
    }
  }

  const sorted = [...playable].sort((a, b) => cardPriority(a) - cardPriority(b));
  const pick = sorted[0];
  if (pick.color === 'wild') {
    const remaining = hand.filter((c) => c.id !== pick.id);
    return { type: 'play', cardId: pick.id, chosenColor: pickColorByHand(remaining) };
  }
  return { type: 'play', cardId: pick.id };
}

export function pickMove(
  playerId: PlayerId,
  hand: Card[],
  top: Card,
  activeColor: Color,
  opponents: OpponentInfo[],
): AiMove {
  if (playerId === 'zephyr') return pickMoveZephyr(hand, top, activeColor);
  if (playerId === 'caelir') return pickMoveCaelir(hand, top, activeColor, opponents);
  return { type: 'draw' };
}

export function pickColorForWild(hand: Card[]): Color {
  return pickColorByHand(hand);
}

export { type CardColor };
