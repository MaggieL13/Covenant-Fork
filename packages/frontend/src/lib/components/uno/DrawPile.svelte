<script lang="ts">
  import UnoCard from './UnoCard.svelte';

  let { count, canDraw, onclick } = $props<{
    count: number;
    canDraw: boolean;
    onclick: () => void;
  }>();
</script>

<div class="uno-draw">
  <button
    type="button"
    class="uno-draw__stack"
    class:uno-draw__stack--active={canDraw}
    disabled={!canDraw}
    onclick={onclick}
    aria-label="Draw a card (pile has {count})"
  >
    <UnoCard faceDown />
  </button>
  <span class="uno-draw__label">{count}</span>
</div>
