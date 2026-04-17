<script lang="ts">
  import type { Card } from '$lib/uno/types';
  import { cardAria, cardLabel } from '$lib/uno/rules';

  let {
    card,
    faceDown = false,
    playable = false,
    disabled = false,
    compact = false,
    onclick,
  } = $props<{
    card?: Card;
    faceDown?: boolean;
    playable?: boolean;
    disabled?: boolean;
    compact?: boolean;
    onclick?: () => void;
  }>();

  const colorClass = $derived(
    faceDown || !card
      ? 'uno-card--back'
      : card.color === 'wild'
        ? 'uno-card--wild'
        : `uno-card--${card.color}`,
  );

  const label = $derived(card && !faceDown ? cardLabel(card) : '');
  const aria = $derived(card && !faceDown ? cardAria(card) : 'face-down card');
</script>

{#if onclick}
  <button
    type="button"
    class="uno-card {colorClass}"
    class:uno-card--playable={playable}
    class:uno-card--disabled={disabled}
    class:uno-card--compact={compact}
    aria-label={aria}
    disabled={disabled}
    onclick={onclick}
  >
    {#if !faceDown && card}
      <span class="uno-card__corner uno-card__corner--tl">{label}</span>
      <span class="uno-card__center">{label}</span>
      <span class="uno-card__corner uno-card__corner--br">{label}</span>
    {/if}
  </button>
{:else}
  <div
    class="uno-card {colorClass}"
    class:uno-card--compact={compact}
    aria-label={aria}
    role="img"
  >
    {#if !faceDown && card}
      <span class="uno-card__corner uno-card__corner--tl">{label}</span>
      <span class="uno-card__center">{label}</span>
      <span class="uno-card__corner uno-card__corner--br">{label}</span>
    {/if}
  </div>
{/if}
