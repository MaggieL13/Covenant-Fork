<script lang="ts">
  let { state = 'idle', disabled = false, ontoggle } = $props<{
    state?: 'idle' | 'loading' | 'playing';
    disabled?: boolean;
    ontoggle?: () => void;
  }>();

  const title = $derived(
    state === 'playing'
      ? 'Stop'
      : state === 'loading'
        ? 'Generating...'
        : 'Read aloud'
  );
</script>

<button
  class="read-aloud-btn"
  class:loading={state === 'loading'}
  class:playing={state === 'playing'}
  onclick={ontoggle}
  {disabled}
  {title}
>
  {#if state === 'loading'}
    <svg class="tts-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>
  {:else if state === 'playing'}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
  {:else}
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
  {/if}
</button>

<style>
  .read-aloud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    width: 26px;
    padding: 0;
    border-radius: var(--radius);
    color: var(--text-muted);
    transition: color var(--transition), background var(--transition);
  }

  .read-aloud-btn:hover:not(:disabled) {
    color: var(--accent);
    background: var(--bg-hover);
  }

  .read-aloud-btn.playing {
    color: var(--accent);
  }

  .read-aloud-btn:disabled {
    cursor: wait;
  }

  .tts-spinner {
    animation: toolSpin 0.8s linear infinite;
  }

  @keyframes toolSpin {
    to { transform: rotate(360deg); }
  }
</style>
