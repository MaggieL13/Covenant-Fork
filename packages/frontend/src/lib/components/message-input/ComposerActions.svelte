<script lang="ts">
  import type { Sticker } from '@resonant/shared';
  import VoiceRecorder from '../VoiceRecorder.svelte';
  import VoiceModeToggle from '../VoiceModeToggle.svelte';
  import StickerPicker from '../StickerPicker.svelte';

  let {
    uploading,
    hasStickerPacks,
    showStickerPicker,
    onopenfilepicker,
    onstickerbuttontoggle,
    onstickerselect,
    onstickerclose,
    ontranscript,
    onfilechange,
    onregisterrefs,
  } = $props<{
    uploading: boolean;
    hasStickerPacks: boolean;
    showStickerPicker: boolean;
    onopenfilepicker?: () => void;
    onstickerbuttontoggle?: () => void;
    onstickerselect?: (sticker: Sticker) => void;
    onstickerclose?: () => void;
    ontranscript?: (text: string, prosody?: Record<string, number> | null) => void;
    onfilechange?: (event: Event) => void;
    onregisterrefs?: (refs: { getFileInput: () => HTMLInputElement | null }) => void;
  }>();

  let fileInput: HTMLInputElement | null = null;

  $effect(() => {
    // ORDER: the parent must receive a live file-input getter after binding so attach-button clicks still target the real DOM node.
    onregisterrefs?.({ getFileInput: () => fileInput });
  });
</script>

<input
  bind:this={fileInput}
  type="file"
  accept="image/*,audio/*,.pdf,.txt,.md,.json"
  multiple
  onchange={onfilechange}
  hidden
  aria-hidden="true"
/>

<button
  class="attach-button"
  onclick={() => onopenfilepicker?.()}
  disabled={uploading}
  aria-label="Attach file"
  title="Attach file"
>
  {#if uploading}
    <span class="upload-spinner"></span>
  {:else}
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>
    </svg>
  {/if}
</button>

<VoiceRecorder ontranscript={ontranscript} />

{#if hasStickerPacks}
  <div class="sticker-btn-wrap">
    <button
      class="sticker-button"
      onclick={() => onstickerbuttontoggle?.()}
      aria-label="Send sticker"
      title="Stickers"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"/>
        <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
        <line x1="9" y1="9" x2="9.01" y2="9"/>
        <line x1="15" y1="9" x2="15.01" y2="9"/>
      </svg>
    </button>
    {#if showStickerPicker}
      <StickerPicker
        onselect={onstickerselect}
        onclose={onstickerclose}
      />
    {/if}
  </div>
{/if}

<VoiceModeToggle />

<style>
  .attach-button {
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    color: var(--text-muted);
    border-radius: 0.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: color var(--transition), background var(--transition);
  }

  .attach-button:hover:not(:disabled) {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .attach-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .sticker-btn-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .sticker-button {
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    color: var(--text-muted);
    border-radius: 0.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color var(--transition), background var(--transition);
  }

  .sticker-button:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }

  .upload-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid var(--text-muted);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 768px) {
    .attach-button {
      width: 2.5rem;
      height: 2.5rem;
    }
  }
</style>
