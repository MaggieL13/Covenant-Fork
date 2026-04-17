<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Color, PlayerId } from '$lib/uno/types';
  import OpponentSeat from './OpponentSeat.svelte';
  import PlayerHand from './PlayerHand.svelte';
  import DiscardPile from './DiscardPile.svelte';
  import DrawPile from './DrawPile.svelte';
  import ColorPicker from './ColorPicker.svelte';
  import UnoButton from './UnoButton.svelte';
  import WinnerScreen from './WinnerScreen.svelte';
  import ChatterPanel from './ChatterPanel.svelte';
  import UnoCard from './UnoCard.svelte';
  import {
    callUno,
    chooseColor,
    drawCard,
    getActiveColor,
    getChatter,
    getLastDrawn,
    getPhase,
    getPlayableCardIds,
    getPlayerById,
    getState,
    getTopCard,
    getUnoCall,
    getWinner,
    isHumansTurn,
    keepDrawnCard,
    newGame,
    playCard,
    playDrawnCard,
  } from '$lib/stores/uno.svelte';

  const state = $derived(getState());
  const chatter = $derived(getChatter());
  const top = $derived(getTopCard());
  const active = $derived(getActiveColor());
  const phase = $derived(getPhase());
  const winner = $derived(getWinner());
  const unoCall = $derived(getUnoCall());
  const humansTurn = $derived(isHumansTurn());
  const lastDrawn = $derived(getLastDrawn());
  const playableIds = $derived(getPlayableCardIds('maggie'));

  const zephyrHand = $derived(state.hands.zephyr.length);
  const caelirHand = $derived(state.hands.caelir.length);

  function onPlay(cardId: string): void {
    playCard('maggie', cardId);
  }

  function onDraw(): void {
    drawCard('maggie');
  }

  function onChooseColor(color: Color): void {
    chooseColor(color);
  }

  function onCallUno(): void {
    callUno('maggie');
  }

  function onPlayAgain(): void {
    newGame();
  }

  function onBackToChat(): void {
    goto('/chat');
  }

  const unoVisible = $derived(
    unoCall !== null &&
      unoCall.playerId === 'maggie' &&
      phase === 'playing',
  );
</script>

<section class="uno-board" aria-label="UNO game board">
  <div class="uno-seats-top">
    <OpponentSeat
      player={getPlayerById('zephyr')}
      handCount={zephyrHand}
      isCurrent={state.currentPlayer === 'zephyr'}
      hasCalledUno={unoCall?.playerId === 'zephyr' || zephyrHand === 1}
    />
    <div class="uno-turn-indicator">
      {#if winner}
        <span>Round over</span>
      {:else if humansTurn}
        <span>Your turn</span>
      {:else}
        <span>{getPlayerById(state.currentPlayer).name}'s turn</span>
      {/if}
      <span class="uno-turn-indicator__dir">
        {state.direction === 1 ? '→' : '←'}
      </span>
    </div>
    <OpponentSeat
      player={getPlayerById('caelir')}
      handCount={caelirHand}
      isCurrent={state.currentPlayer === 'caelir'}
      hasCalledUno={unoCall?.playerId === 'caelir' || caelirHand === 1}
    />
  </div>

  <div class="uno-center">
    <DrawPile count={state.deck.length} canDraw={humansTurn && lastDrawn === null} onclick={onDraw} />
    <DiscardPile top={top} activeColor={active} />
  </div>

  {#if lastDrawn}
    <div class="uno-drawn-prompt" role="group" aria-label="Drawn card actions">
      <p class="uno-drawn-prompt__label">You drew:</p>
      <UnoCard card={lastDrawn} />
      <div class="uno-drawn-prompt__buttons">
        <button type="button" class="res-btn" onclick={playDrawnCard}>Play it</button>
        <button type="button" class="res-btn uno-drawn-prompt__keep" onclick={keepDrawnCard}>Keep</button>
      </div>
    </div>
  {/if}

  <ChatterPanel lines={chatter} />

  <div class="uno-hand-wrapper">
    <PlayerHand
      cards={state.hands.maggie}
      playableIds={playableIds}
      enabled={humansTurn && lastDrawn === null}
      onplay={onPlay}
    />
  </div>

  <UnoButton visible={unoVisible} onclick={onCallUno} />

  {#if phase === 'picking-color'}
    <ColorPicker onpick={onChooseColor} />
  {/if}

  {#if winner}
    <WinnerScreen
      winner={getPlayerById(winner)}
      onPlayAgain={onPlayAgain}
      onBackToChat={onBackToChat}
    />
  {/if}
</section>
