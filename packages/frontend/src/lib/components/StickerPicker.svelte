<script lang="ts">
  import type { Sticker, StickerPack } from '@resonant/shared';
  import { getStickerPacks, getStickersForPack, isLoaded } from '$lib/stores/stickers.svelte';

  let {
    onselect,
    onclose,
  }: {
    onselect: (sticker: Sticker) => void;
    onclose: () => void;
  } = $props();

  let packs = $derived(getStickerPacks());
  let loaded = $derived(isLoaded());
  let activePack = $state<string | null>(null);
  let searchQuery = $state('');

  // Auto-select first pack
  $effect(() => {
    if (packs.length > 0 && !activePack) {
      activePack = packs[0].id;
    }
  });

  let currentStickers = $derived(() => {
    if (!activePack) return [];
    let stickers = getStickersForPack(activePack);
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      // Search across ALL packs when typing
      stickers = [];
      for (const p of packs) {
        for (const s of getStickersForPack(p.id)) {
          if (s.name.toLowerCase().includes(q) || s.aliases.some(a => a.toLowerCase().includes(q))) {
            stickers.push(s);
          }
        }
      }
    }
    return stickers;
  });

  function handleSelect(sticker: Sticker) {
    onselect(sticker);
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="sp">
  <!-- Search -->
  <div class="sp-search">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      class="sp-search-input"
      bind:value={searchQuery}
      placeholder="Search stickers..."
      autofocus
    />
  </div>

  <!-- Pack tabs -->
  {#if packs.length > 1 && !searchQuery}
    <div class="sp-tabs">
      {#each packs as pack}
        <button
          class="sp-tab"
          class:active={activePack === pack.id}
          onclick={() => activePack = pack.id}
          title={pack.name}
        >
          {pack.name}
        </button>
      {/each}
    </div>
  {/if}

  <!-- Sticker grid -->
  <div class="sp-grid">
    {#if !loaded}
      <div class="sp-empty">Loading stickers...</div>
    {:else if packs.length === 0}
      <div class="sp-empty">
        <span>No sticker packs</span>
        <span class="sp-empty-sub">Add packs in Settings</span>
      </div>
    {:else if currentStickers().length === 0}
      <div class="sp-empty">No matches</div>
    {:else}
      {#each currentStickers() as sticker (sticker.id)}
        <button
          class="sp-sticker"
          onclick={() => handleSelect(sticker)}
          title={`:${packs.find(p => p.id === sticker.pack_id)?.name || ''}_${sticker.name}:`}
        >
          <img src={sticker.url} alt={sticker.name} loading="lazy" />
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .sp {
    position: absolute;
    bottom: calc(100% + 0.5rem);
    left: 0;
    width: 320px;
    max-height: 360px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    z-index: 60;
    display: flex;
    flex-direction: column;
    animation: spFade 0.15s ease-out;
    overflow: hidden;
  }

  @keyframes spFade {
    from { opacity: 0; transform: translateY(0.5rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  .sp-search {
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .sp-search-input {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    color: var(--text-primary);
    padding: 0.35rem 0.5rem;
    font-size: 0.75rem;
    outline: none;
  }
  .sp-search-input:focus { border-color: var(--accent); }
  .sp-search-input::placeholder { color: var(--text-muted); }

  .sp-tabs {
    display: flex;
    gap: 0.125rem;
    padding: 0.25rem 0.5rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .sp-tab {
    font-size: 0.65rem;
    padding: 0.2rem 0.5rem;
    border-radius: 0.5rem;
    color: var(--text-muted);
    background: transparent;
    white-space: nowrap;
    transition: all var(--transition);
    text-transform: capitalize;
  }
  .sp-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
  .sp-tab.active { color: var(--accent); background: rgba(155, 114, 207, 0.12); }

  .sp-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.25rem;
    padding: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .sp-sticker {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    padding: 0.25rem;
    transition: all 0.12s ease;
    cursor: pointer;
  }

  .sp-sticker:hover {
    background: var(--bg-hover);
    transform: scale(1.08);
  }

  .sp-sticker img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: 0.25rem;
  }

  .sp-empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1.5rem;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .sp-empty-sub { font-size: 0.7rem; opacity: 0.6; }

  @media (max-width: 768px) {
    .sp {
      width: calc(100vw - 2rem);
      left: 50%;
      transform: translateX(-50%);
    }
  }
</style>
