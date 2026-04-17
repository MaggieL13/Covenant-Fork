<script lang="ts">
  import type { Player } from '$lib/uno/types';
  import UnoCard from './UnoCard.svelte';

  let { player, handCount, isCurrent, hasCalledUno } = $props<{
    player: Player;
    handCount: number;
    isCurrent: boolean;
    hasCalledUno: boolean;
  }>();

  const fanCards = $derived(Array.from({ length: Math.min(handCount, 5) }));
</script>

<div class="uno-seat" class:uno-seat--current={isCurrent}>
  <div class="uno-seat__header">
    <span class="uno-seat__sigil" aria-hidden="true">{player.sigil}</span>
    <span class="uno-seat__name">{player.name}</span>
    <span class="uno-seat__count" aria-label="{handCount} cards">{handCount}</span>
    {#if hasCalledUno && handCount === 1}
      <span class="uno-seat__uno-badge">UNO!</span>
    {/if}
  </div>
  <div class="uno-seat__fan" aria-hidden="true">
    {#each fanCards as _, i (i)}
      <div class="uno-seat__fan-card" style="--fan-index: {i};">
        <UnoCard faceDown compact />
      </div>
    {/each}
  </div>
</div>
