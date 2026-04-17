<script lang="ts">
  import type { Card, Color } from '$lib/uno/types';
  import UnoCard from './UnoCard.svelte';

  let { top, activeColor } = $props<{ top: Card | null; activeColor: Color }>();

  const showColorDot = $derived(top?.color === 'wild');
</script>

<div class="uno-discard">
  {#if top}
    <UnoCard card={top} />
    {#if showColorDot}
      <span
        class="uno-discard__color-dot uno-discard__color-dot--{activeColor}"
        aria-label="active color {activeColor}"
      ></span>
    {/if}
  {/if}
  <span class="uno-discard__label">discard</span>
</div>
