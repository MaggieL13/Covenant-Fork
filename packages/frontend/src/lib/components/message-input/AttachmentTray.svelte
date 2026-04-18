<script lang="ts">
  import type { Sticker } from '@resonant/shared';

  type PendingAttachment = {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentType: 'image' | 'audio' | 'file';
    url: string;
  };

  let {
    pendingSticker,
    pendingAttachments,
    onremoveattachment,
    onclearsticker,
  } = $props<{
    pendingSticker: Sticker | null;
    pendingAttachments: PendingAttachment[];
    onremoveattachment?: (index: number) => void;
    onclearsticker?: () => void;
  }>();
</script>

{#if pendingSticker || pendingAttachments.length > 0}
  <div class="attachment-strip">
    {#if pendingSticker}
      <div class="attachment-preview sticker-chip">
        <img src={pendingSticker.url} alt={pendingSticker.name} class="sticker-chip-img" />
        <button class="attachment-remove" onclick={() => onclearsticker?.()} aria-label="Remove sticker">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    {/if}
    {#each pendingAttachments as attachment, i}
      <div class="attachment-preview">
        {#if attachment.contentType === 'image'}
          <img src={attachment.url} alt={attachment.filename} class="attachment-thumb" />
        {:else}
          <div class="attachment-file-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="attachment-name">{attachment.filename}</span>
          </div>
        {/if}
        <button class="attachment-remove" onclick={() => onremoveattachment?.(i)} aria-label="Remove attachment">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .attachment-strip {
    display: flex;
    gap: 0.5rem;
    padding: 0.85rem 1rem 0.35rem;
    overflow-x: auto;
    flex-wrap: wrap;
  }

  .attachment-preview {
    position: relative;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    overflow: hidden;
    background: var(--bg-surface);
  }

  .sticker-chip {
    padding: 0.25rem;
  }

  .sticker-chip-img {
    width: 48px;
    height: 48px;
    object-fit: contain;
    border-radius: 0.25rem;
  }

  .attachment-thumb {
    width: 4rem;
    height: 4rem;
    object-fit: cover;
    display: block;
  }

  .attachment-file-icon {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.625rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    max-width: 8rem;
  }

  .attachment-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attachment-remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.7);
    color: var(--text-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--transition-fast);
  }

  .attachment-remove:hover {
    background: rgba(239, 68, 68, 0.8);
  }
</style>
