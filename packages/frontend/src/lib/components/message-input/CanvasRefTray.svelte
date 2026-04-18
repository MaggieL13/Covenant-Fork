<script lang="ts">
  let {
    pendingCanvasRefs,
    onremove,
  } = $props<{
    pendingCanvasRefs: Array<{ canvasId: string; title: string }>;
    onremove?: (index: number) => void;
  }>();
</script>

{#if pendingCanvasRefs.length > 0}
  <div class="attachment-strip">
    {#each pendingCanvasRefs as ref, i}
      <div class="attachment-preview canvas-ref-chip">
        <div class="attachment-file-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>
          </svg>
          <span class="attachment-name">{ref.title}</span>
        </div>
        <button class="attachment-remove" onclick={() => onremove?.(i)} aria-label="Remove canvas reference">
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
    padding: 0 1rem 0.35rem;
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

  .canvas-ref-chip {
    border-color: var(--accent, #9b72cf);
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
