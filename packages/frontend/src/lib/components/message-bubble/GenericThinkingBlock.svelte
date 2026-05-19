<script lang="ts">
  /**
   * Generic thinking-block fallback for any provider that doesn't have a
   * dedicated component yet (OpenRouter, Ollama, future runtimes). Plain
   * and boring on purpose — when a new provider lands, we either carve
   * out a dedicated component for it (like Claude/Codex) or let it ride
   * on this fallback indefinitely.
   *
   * Same toggle + detail-open UX as the per-provider blocks so the
   * dispatch in ToolActivityPanel doesn't have to special-case anything.
   */

  let {
    content,
    index,
    isExpanded,
    ontoggle,
    onopenDetail,
  } = $props<{
    content: string;
    index: number;
    isExpanded: boolean;
    ontoggle?: (index: number) => void;
    onopenDetail?: (title: string, content: string) => void;
  }>();
</script>

<div class="thinking-block generic">
  <button class="thinking-header" onclick={(e) => { e.stopPropagation(); ontoggle?.(index); }}>
    <span class="thinking-icon">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    </span>
    <span class="thinking-label">Thinking</span>
    <span class="thinking-chevron">{isExpanded ? '▾' : '▸'}</span>
  </button>
  {#if isExpanded}
    <div
      class="thinking-content"
      role="button"
      tabindex="0"
      onclick={(e) => { e.stopPropagation(); onopenDetail?.('Thinking', content); }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onopenDetail?.('Thinking', content); } }}
    >{content}</div>
  {/if}
</div>

<style>
  .thinking-block {
    margin: 0.375rem 0;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }

  .thinking-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    background: var(--bg-tertiary);
    color: var(--text-muted);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    cursor: pointer;
    text-align: left;
    border-radius: 0.25rem;
    width: 100%;
    border: 0;
  }

  .thinking-header:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .thinking-icon {
    flex-shrink: 0;
    color: var(--text-muted);
    display: flex;
    align-items: center;
  }

  .thinking-label {
    flex: 1;
    color: var(--text-secondary);
  }

  .thinking-chevron {
    flex-shrink: 0;
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .thinking-content {
    margin: 0.25rem 0;
    padding: 0.5rem 0.625rem;
    background: var(--bg-primary);
    border-radius: 0 0 0.25rem 0.25rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
    line-height: 1.5;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    cursor: zoom-in;
  }
</style>
