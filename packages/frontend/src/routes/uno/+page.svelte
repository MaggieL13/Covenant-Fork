<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import GameBoard from '$lib/components/uno/GameBoard.svelte';
  import { hydrate, newGame } from '$lib/stores/uno.svelte';
  import '../../resonant.css';
  import './uno.css';

  onMount(() => {
    hydrate();
  });

  function onExit(): void {
    goto('/chat');
  }

  function onFreshDeal(): void {
    newGame();
  }
</script>

<svelte:head>
  <title>UNO — Covenant</title>
</svelte:head>

<div class="uno-page">
  <header class="uno-header">
    <button type="button" class="uno-header__back" onclick={onExit} aria-label="Back to chat">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
    </button>
    <h1 class="uno-header__title">UNO</h1>
    <button type="button" class="uno-header__fresh" onclick={onFreshDeal} aria-label="New game">
      Fresh deal
    </button>
  </header>
  <GameBoard />
</div>
