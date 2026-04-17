<script lang="ts">
  import type { Card } from '$lib/uno/types';
  import UnoCard from './UnoCard.svelte';

  let { cards, playableIds, enabled, onplay } = $props<{
    cards: Card[];
    playableIds: Set<string>;
    enabled: boolean;
    onplay: (cardId: string) => void;
  }>();
</script>

<div class="uno-hand" aria-label="your hand">
  {#each cards as card (card.id)}
    {@const playable = enabled && playableIds.has(card.id)}
    <UnoCard
      card={card}
      playable={playable}
      disabled={!playable}
      onclick={() => onplay(card.id)}
    />
  {/each}
</div>
