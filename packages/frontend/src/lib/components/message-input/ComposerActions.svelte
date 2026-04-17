<script lang="ts">
  import type { Sticker } from '@resonant/shared';
  import VoiceRecorder from '../VoiceRecorder.svelte';
  import VoiceModeToggle from '../VoiceModeToggle.svelte';
  import StickerPicker from '../StickerPicker.svelte';

  let {
    isStreaming,
    uploading,
    hasStickerPacks,
    showStickerPicker,
    canSend,
    onopenfilepicker,
    onstickerbuttontoggle,
    onstickerselect,
    onstickerclose,
    onsend,
    onstop,
    ontranscript,
    onfilechange,
    onregisterrefs,
  } = $props<{
    isStreaming: boolean;
    uploading: boolean;
    hasStickerPacks: boolean;
    showStickerPicker: boolean;
    canSend: boolean;
    onopenfilepicker?: () => void;
    onstickerbuttontoggle?: () => void;
    onstickerselect?: (sticker: Sticker) => void;
    onstickerclose?: () => void;
    onsend?: () => void;
    onstop?: () => void;
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

{#if isStreaming}
  <button
    class="send-button stop-active"
    onclick={() => onstop?.()}
    aria-label="Stop generation"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
  </button>
{:else}
  <button
    class="send-button"
    onclick={() => onsend?.()}
    disabled={!canSend}
    aria-label="Send message"
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
    </svg>
  </button>
{/if}

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

  .send-button {
    width: 2.75rem;
    height: 2.75rem;
    padding: 0;
    background: var(--accent);
    color: white;
    border-radius: 0.875rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    flex-shrink: 0;
  }

  .send-button:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .send-button:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }

  .send-button.stop-active {
    background: var(--status-error, #ef4444);
    color: white;
  }

  .send-button.stop-active:hover {
    background: #dc2626;
    box-shadow: 0 0 12px rgba(239, 68, 68, 0.3);
  }

  @media (max-width: 768px) {
    .attach-button,
    .send-button {
      width: 2.5rem;
      height: 2.5rem;
    }
  }
</style>
