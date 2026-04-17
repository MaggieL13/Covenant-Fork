<script lang="ts">
  import type { Color } from '$lib/uno/types';

  let { onpick } = $props<{ onpick: (color: Color) => void }>();

  const colors: Color[] = ['red', 'yellow', 'green', 'blue'];
</script>

<div class="uno-modal-backdrop" role="dialog" aria-modal="true" aria-label="Pick a color">
  <div class="uno-color-picker">
    <h2 class="uno-color-picker__title">Pick a color</h2>
    <div class="uno-color-picker__grid">
      {#each colors as color (color)}
        <button
          type="button"
          class="uno-color-swatch uno-color-swatch--{color}"
          onclick={() => onpick(color)}
          aria-label={color}
        >
          <span class="uno-color-swatch__name">{color}</span>
        </button>
      {/each}
    </div>
  </div>
</div>
