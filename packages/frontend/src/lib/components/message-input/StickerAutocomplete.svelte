<script lang="ts">
  let {
    items,
    visible,
    onselect,
    onclose,
    onregisterapi,
  } = $props<{
    items: Array<{ ref: string; url: string; name: string; packName: string }>;
    visible: boolean;
    onselect?: (ref: string) => void;
    onclose?: () => void;
    onregisterapi?: (api: { handleKey: (event: KeyboardEvent) => boolean }) => void;
  }>();

  let selectedIndex = $state(0);

  $effect(() => {
    visible;
    items;
    // ORDER: reset the highlighted item before the next keyboard interaction so a changed result set never keeps a stale index.
    selectedIndex = 0;
  });

  function handleKey(event: KeyboardEvent): boolean {
    if (!visible || items.length === 0) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selectedIndex = (selectedIndex + 1) % items.length;
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      return true;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && items.length > 0) {
      event.preventDefault();
      onselect?.(items[selectedIndex].ref);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onclose?.();
      return true;
    }
    return false;
  }

  $effect(() => {
    onregisterapi?.({ handleKey });
  });
</script>

{#if visible && items.length > 0}
  <div class="sticker-autocomplete">
    {#each items as item, i (item.ref)}
      <button
        class="sticker-ac-item"
        class:selected={i === selectedIndex}
        onmousedown={(event) => {
          event.preventDefault();
          onselect?.(item.ref);
        }}
        onmouseenter={() => { selectedIndex = i; }}
      >
        <img src={item.url} alt={item.name} class="sticker-ac-img" />
        <span class="sticker-ac-ref">{item.ref}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .sticker-autocomplete {
    position: absolute;
    bottom: calc(100% + 0.75rem);
    left: 0;
    right: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    max-height: 200px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    z-index: 10;
  }

  .sticker-ac-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    cursor: pointer;
    transition: background var(--transition);
    text-align: left;
  }

  .sticker-ac-item:hover,
  .sticker-ac-item.selected {
    background: var(--bg-hover);
  }

  .sticker-ac-img {
    width: 28px;
    height: 28px;
    object-fit: contain;
    border-radius: 0.25rem;
    flex-shrink: 0;
  }

  .sticker-ac-ref {
    font-size: 0.75rem;
    color: var(--text-secondary);
    font-family: var(--font-mono, monospace);
  }
</style>
