<script lang="ts">
  import type { Message } from '@resonant/shared';

  let {
    replyTo,
    companionName,
    oncancel,
  } = $props<{
    replyTo: Message | null;
    companionName: string;
    oncancel?: () => void;
  }>();
</script>

{#if replyTo}
  <div class="reply-indicator">
    <div class="reply-bar"></div>
    <div class="reply-info">
      <span class="replying-to">Replying to {replyTo.role === 'companion' ? companionName : 'You'}</span>
      <span class="reply-preview">{replyTo.content.substring(0, 100)}</span>
    </div>
    <button class="cancel-reply" onclick={() => oncancel?.()} aria-label="Cancel reply">
      ×
    </button>
  </div>
{/if}

<style>
  .reply-indicator {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: 1rem 1rem 0 0;
  }

  .reply-bar {
    width: 2px;
    height: 2rem;
    background: var(--accent);
    border-radius: 1px;
    flex-shrink: 0;
  }

  .reply-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    overflow: hidden;
  }

  .replying-to {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--accent);
    font-family: var(--font-heading);
    letter-spacing: 0.03em;
  }

  .reply-preview {
    font-size: 0.875rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cancel-reply {
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition-fast);
  }

  .cancel-reply:hover {
    color: var(--text-secondary);
  }
</style>
