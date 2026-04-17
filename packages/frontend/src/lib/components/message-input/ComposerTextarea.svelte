<script lang="ts">
  let {
    content,
    showStickerAutocomplete,
    stickerAutocompleteItems,
    stickerSelectedIndex,
    oninput,
    onkeydown,
    onpaste,
    onselectstickerref,
    onhoverstickerindex,
    onregisterrefs,
  } = $props<{
    content: string;
    showStickerAutocomplete: boolean;
    stickerAutocompleteItems: Array<{ ref: string; url: string; name: string; packName: string }>;
    stickerSelectedIndex: number;
    oninput?: (event: Event) => void;
    onkeydown?: (event: KeyboardEvent) => void;
    onpaste?: (event: ClipboardEvent) => void;
    onselectstickerref?: (ref: string) => void;
    onhoverstickerindex?: (index: number) => void;
    onregisterrefs?: (refs: { getTextarea: () => HTMLTextAreaElement | null }) => void;
  }>();

  let textarea: HTMLTextAreaElement | null = null;

  $effect(() => {
    // ORDER: the parent must receive a live textarea getter after binding so focus, resize, selection, and cursor logic keep targeting the current DOM node.
    onregisterrefs?.({ getTextarea: () => textarea });
  });
</script>

<div class="composer-textarea-shell">
  {#if showStickerAutocomplete && stickerAutocompleteItems.length > 0}
    <div class="sticker-autocomplete">
      {#each stickerAutocompleteItems as item, i (item.ref)}
        <button
          class="sticker-ac-item"
          class:selected={i === stickerSelectedIndex}
          onmousedown={(event) => {
            event.preventDefault();
            onselectstickerref?.(item.ref);
          }}
          onmouseenter={() => onhoverstickerindex?.(i)}
        >
          <img src={item.url} alt={item.name} class="sticker-ac-img" />
          <span class="sticker-ac-ref">{item.ref}</span>
        </button>
      {/each}
    </div>
  {/if}

  <textarea
    bind:this={textarea}
    value={content}
    oninput={oninput}
    onkeydown={onkeydown}
    onpaste={onpaste}
    placeholder="Type a message..."
    rows="1"
    aria-label="Message input"
  ></textarea>
</div>

<style>
  .composer-textarea-shell {
    position: relative;
    flex: 1;
    min-width: 0;
  }

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

  textarea {
    width: 100%;
    min-width: 0;
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0.6rem 0.75rem;
    color: var(--text-primary);
    font-size: 1rem;
    line-height: 1.6;
    resize: none;
    max-height: 200px;
    overflow-y: auto;
  }

  textarea:focus {
    outline: none;
  }

  textarea::placeholder {
    color: var(--text-muted);
  }

  @media (max-width: 768px) {
    textarea {
      padding: 0.625rem 0.75rem;
    }
  }
</style>
