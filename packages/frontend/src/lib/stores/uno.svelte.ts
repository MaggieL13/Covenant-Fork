import type {
  Card,
  ChatterLine,
  Color,
  Direction,
  GameEvent,
  GameState,
  Phase,
  Player,
  PlayerId,
  UnoCallState,
} from '$lib/uno/types';
import { PLAYERS, PLAYER_BY_ID } from '$lib/uno/types';
import {
  applyCardEffect,
  buildDeck,
  isValidPlay,
  nextPlayer,
  reshuffleFromDiscard,
  shuffle,
} from '$lib/uno/rules';
import { pickColorForWild, pickMove } from '$lib/uno/ai';
import { fetchChatterLine } from '$lib/uno/chatter';

const STORAGE_KEY = 'uno:v1';
const UNO_CALL_WINDOW_MS = 3000;
const AI_TURN_DELAY_MS = 900;
const CHATTER_CAP = 40;

const PLAYER_ORDER: PlayerId[] = ['maggie', 'zephyr', 'caelir'];

type PendingPlay = { card: Card; by: PlayerId };

let state = $state<GameState>(freshState());
let chatter = $state<ChatterLine[]>([]);
let lastDrawn = $state<Card | null>(null);
let pendingPlay = $state<PendingPlay | null>(null);
let aiTurnTimer: ReturnType<typeof setTimeout> | null = null;
let unoCallTimer: ReturnType<typeof setTimeout> | null = null;
let hydrated = false;

function emptyHands(): Record<PlayerId, Card[]> {
  return { maggie: [], zephyr: [], caelir: [] };
}

function freshState(): GameState {
  return {
    players: PLAYERS,
    hands: emptyHands(),
    deck: [],
    discard: [],
    activeColor: 'red',
    direction: 1,
    currentPlayer: 'maggie',
    phase: 'dealing',
    pendingDraws: 0,
    pendingSkip: false,
    unoCall: null,
    winner: null,
    houseRules: { stacking: false, jumpIn: false },
  };
}

function save(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function load(): GameState | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (!parsed || !parsed.players || !parsed.hands) return null;
    parsed.players = PLAYERS;
    return parsed;
  } catch {
    return null;
  }
}

function clearStorage(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function pushChatter(line: ChatterLine): void {
  chatter.push(line);
  if (chatter.length > CHATTER_CAP) {
    chatter.splice(0, chatter.length - CHATTER_CAP);
  }
}

function fireChatter(event: GameEvent): void {
  const speakers: Array<'zephyr' | 'caelir'> = ['zephyr', 'caelir'];
  for (const speaker of speakers) {
    if (event.kind === 'card-played' && event.by === speaker) continue;
    if (event.kind === 'drew-card' && event.by === speaker) continue;
    if (event.kind === 'uno-called' && event.by === speaker) continue;
    (async () => {
      try {
        const line = await fetchChatterLine(event, speaker);
        if (line) pushChatter(line);
      } catch {}
    })();
  }
}

function dealFresh(): void {
  cancelAiTimer();
  cancelUnoCallTimer();
  let deck = shuffle(buildDeck());
  const hands = emptyHands();
  for (let round = 0; round < 7; round++) {
    for (const pid of PLAYER_ORDER) {
      hands[pid].push(deck.pop()!);
    }
  }
  let top: Card | undefined;
  while (deck.length > 0) {
    const candidate = deck.pop()!;
    if (candidate.kind.kind === 'number' || candidate.kind.kind === 'skip' || candidate.kind.kind === 'reverse' || candidate.kind.kind === 'draw-two') {
      top = candidate;
      break;
    }
    deck = [candidate, ...deck];
    deck = shuffle(deck);
  }
  if (!top) top = deck.pop()!;

  state.deck = deck;
  state.discard = [top];
  state.hands = hands;
  state.activeColor = top.color === 'wild' ? 'red' : (top.color as Color);
  state.direction = 1;
  state.currentPlayer = 'maggie';
  state.phase = 'playing';
  state.pendingDraws = 0;
  state.pendingSkip = false;
  state.unoCall = null;
  state.winner = null;
  lastDrawn = null;
  pendingPlay = null;
  chatter.splice(0, chatter.length);
}

function cancelAiTimer(): void {
  if (aiTurnTimer !== null) {
    clearTimeout(aiTurnTimer);
    aiTurnTimer = null;
  }
}

function cancelUnoCallTimer(): void {
  if (unoCallTimer !== null) {
    clearTimeout(unoCallTimer);
    unoCallTimer = null;
  }
}

function drawFromDeck(playerId: PlayerId, count: number): Card[] {
  const drawn: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (state.deck.length === 0) {
      if (state.discard.length <= 1) break;
      const { deck: newDeck, top } = reshuffleFromDiscard(state.discard);
      state.deck = newDeck;
      state.discard = [top];
      fireChatter({ kind: 'reshuffled' });
    }
    const card = state.deck.pop();
    if (!card) break;
    drawn.push(card);
    state.hands[playerId].push(card);
  }
  return drawn;
}

function openUnoWindowFor(playerId: PlayerId): void {
  cancelUnoCallTimer();
  if (playerId === 'maggie') {
    state.unoCall = { playerId, deadline: Date.now() + UNO_CALL_WINDOW_MS };
    unoCallTimer = setTimeout(() => {
      if (state.unoCall && state.unoCall.playerId === 'maggie' && state.phase === 'playing') {
        state.unoCall = null;
        drawFromDeck('maggie', 2);
        fireChatter({ kind: 'uno-missed', by: 'maggie' });
        save();
      }
    }, UNO_CALL_WINDOW_MS + 50);
  } else {
    state.unoCall = { playerId, deadline: Date.now() };
    fireChatter({ kind: 'uno-called', by: playerId });
    state.unoCall = null;
  }
}

function advanceTurn(reverse: boolean, skip: boolean, pendingDraws: number): void {
  if (reverse) {
    state.direction = (state.direction * -1) as Direction;
    fireChatter({ kind: 'reversed' });
  }
  const next = nextPlayer(PLAYER_ORDER, state.currentPlayer, state.direction, skip);
  if (skip && pendingDraws === 0) {
    fireChatter({ kind: 'skipped', who: next });
  }
  if (pendingDraws > 0) {
    drawFromDeck(next, pendingDraws);
    if (pendingDraws === 2) fireChatter({ kind: 'hit-with-draw-two', who: next });
    if (pendingDraws === 4) fireChatter({ kind: 'hit-with-draw-four', who: next });
  }
  state.currentPlayer = next;
  state.pendingDraws = 0;
  state.pendingSkip = false;
  lastDrawn = null;

  if (PLAYER_BY_ID[next].kind === 'ai') {
    scheduleAiTurn();
  }
}

function finalizePlay(by: PlayerId, card: Card, chosenColor?: Color): void {
  const effect = applyCardEffect(card);
  state.activeColor = chosenColor ?? (card.color === 'wild' ? state.activeColor : (card.color as Color));

  fireChatter({ kind: 'card-played', by, card, chosenColor });

  if (state.hands[by].length === 0) {
    state.winner = by;
    state.phase = 'round-over';
    state.pendingDraws = 0;
    state.pendingSkip = false;
    state.unoCall = null;
    cancelAiTimer();
    cancelUnoCallTimer();
    fireChatter({ kind: 'won', by });
    save();
    return;
  }

  if (state.hands[by].length === 1) {
    openUnoWindowFor(by);
  }

  advanceTurn(effect.reverse, effect.skipNext, effect.draws);
  save();
}

function scheduleAiTurn(): void {
  cancelAiTimer();
  aiTurnTimer = setTimeout(runAiTurn, AI_TURN_DELAY_MS);
}

function runAiTurn(): void {
  aiTurnTimer = null;
  if (state.phase !== 'playing') return;
  const pid = state.currentPlayer;
  if (PLAYER_BY_ID[pid].kind !== 'ai') return;

  const top = state.discard[state.discard.length - 1];
  const opponents = PLAYER_ORDER.filter((o) => o !== pid).map((id) => ({ id, handCount: state.hands[id].length }));
  const move = pickMove(pid, state.hands[pid], top, state.activeColor, opponents);

  if (move.type === 'play') {
    const idx = state.hands[pid].findIndex((c) => c.id === move.cardId);
    if (idx === -1) return;
    const [card] = state.hands[pid].splice(idx, 1);
    state.discard.push(card);
    const chosenColor = card.color === 'wild' ? move.chosenColor ?? pickColorForWild(state.hands[pid]) : undefined;
    finalizePlay(pid, card, chosenColor);
    return;
  }

  const drawn = drawFromDeck(pid, 1);
  fireChatter({ kind: 'drew-card', by: pid, count: 1 });
  if (drawn.length === 1 && isValidPlay(drawn[0], top, state.activeColor)) {
    const card = drawn[0];
    const handIdx = state.hands[pid].findIndex((c) => c.id === card.id);
    if (handIdx !== -1) state.hands[pid].splice(handIdx, 1);
    state.discard.push(card);
    const chosenColor = card.color === 'wild' ? pickColorForWild(state.hands[pid]) : undefined;
    finalizePlay(pid, card, chosenColor);
    return;
  }

  advanceTurn(false, false, 0);
  save();
}

export function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const restored = load();
  if (restored && restored.phase !== 'dealing') {
    Object.assign(state, restored);
    if (PLAYER_BY_ID[state.currentPlayer].kind === 'ai' && state.phase === 'playing') {
      scheduleAiTurn();
    }
  } else {
    dealFresh();
    save();
  }
}

export function newGame(): void {
  clearStorage();
  dealFresh();
  save();
}

export function playCard(playerId: PlayerId, cardId: string): void {
  if (state.phase !== 'playing') return;
  if (state.currentPlayer !== playerId) return;
  if (PLAYER_BY_ID[playerId].kind !== 'human') return;

  const hand = state.hands[playerId];
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) return;
  const card = hand[idx];
  const top = state.discard[state.discard.length - 1];
  if (!isValidPlay(card, top, state.activeColor)) return;

  hand.splice(idx, 1);
  state.discard.push(card);

  if (card.color === 'wild') {
    pendingPlay = { card, by: playerId };
    state.phase = 'picking-color';
    save();
    return;
  }

  finalizePlay(playerId, card);
}

export function chooseColor(color: Color): void {
  if (state.phase !== 'picking-color') return;
  if (!pendingPlay) return;
  const { card, by } = pendingPlay;
  pendingPlay = null;
  state.phase = 'playing';
  finalizePlay(by, card, color);
}

export function drawCard(playerId: PlayerId): void {
  if (state.phase !== 'playing') return;
  if (state.currentPlayer !== playerId) return;
  if (PLAYER_BY_ID[playerId].kind !== 'human') return;
  if (lastDrawn !== null) return;

  const drawn = drawFromDeck(playerId, 1);
  if (drawn.length === 0) return;
  fireChatter({ kind: 'drew-card', by: playerId, count: 1 });
  const card = drawn[0];
  const top = state.discard[state.discard.length - 1];
  if (isValidPlay(card, top, state.activeColor)) {
    lastDrawn = card;
    save();
    return;
  }
  advanceTurn(false, false, 0);
  save();
}

export function playDrawnCard(): void {
  if (!lastDrawn) return;
  if (state.phase !== 'playing') return;
  const card = lastDrawn;
  const hand = state.hands['maggie'];
  const idx = hand.findIndex((c) => c.id === card.id);
  if (idx === -1) return;
  hand.splice(idx, 1);
  state.discard.push(card);
  lastDrawn = null;

  if (card.color === 'wild') {
    pendingPlay = { card, by: 'maggie' };
    state.phase = 'picking-color';
    save();
    return;
  }
  finalizePlay('maggie', card);
}

export function keepDrawnCard(): void {
  if (!lastDrawn) return;
  lastDrawn = null;
  advanceTurn(false, false, 0);
  save();
}

export function callUno(playerId: PlayerId): void {
  if (!state.unoCall || state.unoCall.playerId !== playerId) return;
  cancelUnoCallTimer();
  state.unoCall = null;
  fireChatter({ kind: 'uno-called', by: playerId });
  save();
}

export function getState(): GameState {
  return state;
}

export function getChatter(): ChatterLine[] {
  return chatter;
}

export function getLastDrawn(): Card | null {
  return lastDrawn;
}

export function getTopCard(): Card | null {
  return state.discard[state.discard.length - 1] ?? null;
}

export function getActiveColor(): Color {
  return state.activeColor;
}

export function getPhase(): Phase {
  return state.phase;
}

export function getWinner(): PlayerId | null {
  return state.winner;
}

export function getUnoCall(): UnoCallState | null {
  return state.unoCall;
}

export function getPlayableCardIds(playerId: PlayerId): Set<string> {
  const top = state.discard[state.discard.length - 1];
  if (!top) return new Set();
  const ids = new Set<string>();
  for (const c of state.hands[playerId]) {
    if (isValidPlay(c, top, state.activeColor)) ids.add(c.id);
  }
  return ids;
}

export function isHumansTurn(): boolean {
  return state.phase === 'playing' && PLAYER_BY_ID[state.currentPlayer].kind === 'human';
}

export function getPlayerById(id: PlayerId): Player {
  return PLAYER_BY_ID[id];
}
