<script lang="ts">
  /**
   * Codex-shape thinking block. pi-ai does not surface a reasoning summary
   * even when CodexRuntime passes `reasoningSummary: 'auto'`, so there's
   * nothing to show as a collapsed header label — see
   * `shared/codex-runtime-lab-findings-2026-05-19.md` O5.
   *
   * Header carries a generic "Reasoning" label + a char count so the
   * collapsed state still tells you something useful about the chunk
   * size. Expanded body matches the Claude block's UX so toggle and
   * detail-open behaviors stay consistent across providers.
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

  const charCount = $derived(content.length);
</script>

<div class="thinking-block codex">
  <button class="thinking-header" onclick={(e) => { e.stopPropagation(); ontoggle?.(index); }}>
    <span class="thinking-icon">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
    </span>
    <span class="thinking-label">Reasoning</span>
    <span class="thinking-meta">{charCount.toLocaleString()} chars</span>
    <span class="thinking-chevron">{isExpanded ? '▾' : '▸'}</span>
  </button>
  {#if isExpanded}
    <div
      class="thinking-content"
      role="button"
      tabindex="0"
      onclick={(e) => { e.stopPropagation(); onopenDetail?.('Reasoning', content); }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onopenDetail?.('Reasoning', content); } }}
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
    transition: background 0.15s;
    width: 100%;
    border: 0;
  }

  .thinking-header:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .thinking-icon {
    flex-shrink: 0;
    /* Slightly different accent than Claude's so the two providers are
       visually distinguishable at a glance in a mixed-provider thread. */
    color: var(--text-secondary);
    display: flex;
    align-items: center;
  }

  .thinking-label {
    flex: 1;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .thinking-meta {
    flex-shrink: 0;
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .thinking-chevron {
    flex-shrink: 0;
    font-size: 0.625rem;
    color: var(--text-muted);
  }

  .thinking-content {
    margin: 0.25rem 0 0.25rem 0;
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
