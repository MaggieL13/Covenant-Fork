<script lang="ts">
  import Canvas from '$lib/components/Canvas.svelte';
  import CanvasList from '$lib/components/CanvasList.svelte';

  let {
    open = false,
    showActiveCanvas = false,
    onclose,
    onreference,
  } = $props<{
    open: boolean;
    showActiveCanvas: boolean;
    onclose?: () => void;
    onreference?: (canvasId: string, title: string) => void;
  }>();
</script>

{#if open}
  <button class="canvas-overlay" onclick={onclose} aria-label="Close canvas"></button>
  <div class="canvas-sheet" role="dialog" aria-modal="true" aria-label="Canvas workspace">
    <div class="canvas-sheet-card">
      {#if showActiveCanvas}
        <Canvas embedded onreference={onreference} />
      {:else}
        <CanvasList embedded stayOpenOnSelect onclose={onclose} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .canvas-overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(10px);
  }

  .canvas-sheet {
    position: fixed;
    top: 1rem;
    right: 1rem;
    bottom: 1rem;
    width: min(36rem, calc(100vw - 2rem));
    z-index: 330;
    pointer-events: none;
  }

  .canvas-sheet-card {
    width: 100%;
    height: 100%;
    pointer-events: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    backdrop-filter: blur(20px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    animation: modalRise 0.2s ease-out;
  }

  @media (max-width: 768px) {
    .canvas-sheet {
      inset: 0;
      width: 100%;
    }

    .canvas-sheet-card {
      border-radius: 0;
      border: none;
    }
  }
</style>
