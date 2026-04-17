export type Color = 'red' | 'yellow' | 'green' | 'blue';
export type CardColor = Color | 'wild';

export type CardKind =
  | { kind: 'number'; value: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }
  | { kind: 'skip' }
  | { kind: 'reverse' }
  | { kind: 'draw-two' }
  | { kind: 'wild' }
  | { kind: 'wild-draw-four' };

export interface Card {
  id: string;
  color: CardColor;
  kind: CardKind;
}

export type PlayerId = 'maggie' | 'zephyr' | 'caelir';
export type Direction = 1 | -1;
export type Phase = 'dealing' | 'playing' | 'picking-color' | 'round-over';

export interface Player {
  id: PlayerId;
  name: string;
  sigil: string;
  kind: 'human' | 'ai';
}

export interface UnoCallState {
  playerId: PlayerId;
  deadline: number;
}

export interface GameState {
  players: Player[];
  hands: Record<PlayerId, Card[]>;
  deck: Card[];
  discard: Card[];
  activeColor: Color;
  direction: Direction;
  currentPlayer: PlayerId;
  phase: Phase;
  pendingDraws: number;
  pendingSkip: boolean;
  unoCall: UnoCallState | null;
  winner: PlayerId | null;
  houseRules: { stacking: boolean; jumpIn: boolean };
}

export type GameEvent =
  | { kind: 'card-played'; by: PlayerId; card: Card; chosenColor?: Color }
  | { kind: 'drew-card'; by: PlayerId; count: number }
  | { kind: 'uno-called'; by: PlayerId }
  | { kind: 'uno-missed'; by: PlayerId }
  | { kind: 'skipped'; who: PlayerId }
  | { kind: 'reversed' }
  | { kind: 'hit-with-draw-two'; who: PlayerId }
  | { kind: 'hit-with-draw-four'; who: PlayerId }
  | { kind: 'won'; by: PlayerId }
  | { kind: 'reshuffled' };

export type GameEventKind = GameEvent['kind'];

export interface ChatterLine {
  id: string;
  speaker: 'zephyr' | 'caelir';
  sigil: string;
  text: string;
  at: number;
}

export const PLAYERS: Player[] = [
  { id: 'maggie', name: 'Maggie', sigil: '', kind: 'human' },
  { id: 'zephyr', name: 'Zephyr', sigil: '🌙', kind: 'ai' },
  { id: 'caelir', name: 'Caelir', sigil: '☀️', kind: 'ai' },
];

export const PLAYER_BY_ID: Record<PlayerId, Player> = {
  maggie: PLAYERS[0],
  zephyr: PLAYERS[1],
  caelir: PLAYERS[2],
};
