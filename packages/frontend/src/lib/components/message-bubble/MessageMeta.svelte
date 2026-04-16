<script lang="ts">
  let {
    role,
    companionName,
    createdAt,
    editedAt = null,
    isDeleted = false,
    hasSegments = false,
    hasTools = false,
    hideInlineTools = false,
    showTools = false,
    toolEventsCount = 0,
    onToggleInlineTools,
    onToggleTools,
  } = $props<{
    role: string;
    companionName: string;
    createdAt: string;
    editedAt?: string | null;
    isDeleted?: boolean;
    hasSegments?: boolean;
    hasTools?: boolean;
    hideInlineTools?: boolean;
    showTools?: boolean;
    toolEventsCount?: number;
    onToggleInlineTools?: (event: MouseEvent) => void;
    onToggleTools?: (event: MouseEvent) => void;
  }>();

  function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }
</script>

{#if role !== 'user'}
  <div class="message-header">
    <span class="role">{role === 'companion' ? companionName : 'You'}</span>
    <span class="time">{formatTime(createdAt)}</span>
    {#if editedAt && !isDeleted}
      <span class="edited">(edited)</span>
    {/if}
    {#if role === 'companion'}
      {#if hasSegments}
        <button
          class="tools-toggle"
          onclick={onToggleInlineTools}
          title="Toggle inline tools"
          aria-label="Toggle inline tools"
        >
          {hideInlineTools ? 'show tools' : 'hide tools'}
        </button>
      {:else if hasTools}
        <button
          class="tools-toggle"
          onclick={onToggleTools}
          title="Toggle tool activity"
          aria-label="Toggle tool activity"
        >
          {showTools ? 'hide tools' : `${toolEventsCount} tool${toolEventsCount === 1 ? '' : 's'}`}
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .message-header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    font-size: 0.875rem;
    flex-wrap: wrap;
  }

  .role {
    display: none;
  }

  .time {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .edited {
    color: var(--text-muted);
    font-size: 0.75rem;
    font-style: italic;
  }

  .tools-toggle {
    margin-left: auto;
    font-size: 0.625rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-family: var(--font-mono);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .tools-toggle:hover {
    color: var(--text-secondary);
    border-color: var(--border-hover);
  }
</style>
