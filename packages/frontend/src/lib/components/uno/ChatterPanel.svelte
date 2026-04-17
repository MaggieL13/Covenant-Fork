<script lang="ts">
  import type { ChatterLine } from '$lib/uno/types';

  let { lines } = $props<{ lines: ChatterLine[] }>();

  let scrollEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    lines.length;
    if (scrollEl) {
      queueMicrotask(() => {
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    }
  });
</script>

<aside class="uno-chatter" aria-label="Table chatter">
  <h3 class="uno-chatter__title">Table</h3>
  <div class="uno-chatter__list" bind:this={scrollEl}>
    {#if lines.length === 0}
      <p class="uno-chatter__empty">Quiet so far.</p>
    {:else}
      {#each lines as line (line.id)}
        <div class="uno-chatter__line uno-chatter__line--{line.speaker}">
          <span class="uno-chatter__sigil" aria-hidden="true">{line.sigil}</span>
          <span class="uno-chatter__text">{line.text}</span>
        </div>
      {/each}
    {/if}
  </div>
</aside>
