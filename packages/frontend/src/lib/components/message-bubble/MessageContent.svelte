<script lang="ts">
  let { html = '', showCursor = false, deleted = false } = $props<{
    html?: string;
    showCursor?: boolean;
    deleted?: boolean;
  }>();
</script>

{#if deleted}
  <span class="deleted-text">This message was deleted</span>
{:else}
  <div class="markdown-content">
    {@html html}
  </div>
  {#if showCursor}
    <span class="cursor">|</span>
  {/if}
{/if}

<style>
  .deleted-text {
    font-style: italic;
    color: var(--text-muted);
  }

  .markdown-content :global(p) {
    margin: 0.5rem 0;
  }

  .markdown-content :global(p:first-child) {
    margin-top: 0;
  }

  .markdown-content :global(p:last-child) {
    margin-bottom: 0;
  }

  .markdown-content :global(code) {
    background: var(--bg-tertiary);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: var(--font-mono);
    font-size: 0.875em;
  }

  .markdown-content :global(pre) {
    background: var(--bg-tertiary);
    padding: 0.75rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    margin: 0.5rem 0;
  }

  .markdown-content :global(pre code) {
    background: none;
    padding: 0;
  }

  .markdown-content :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-muted);
  }

  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }

  .markdown-content :global(blockquote) {
    border-left: 2px solid var(--accent-muted);
    padding-left: 1rem;
    margin: 0.5rem 0;
    color: var(--text-secondary);
  }

  .markdown-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 0.75rem 0;
    font-size: 0.875rem;
  }

  .markdown-content :global(thead) {
    background: var(--bg-tertiary);
  }

  .markdown-content :global(th) {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border: 1px solid var(--border);
    font-weight: 600;
    color: var(--text-primary);
  }

  .markdown-content :global(td) {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
  }

  .markdown-content :global(tbody tr:nth-child(even)) {
    background: var(--bg-hover);
  }

  .markdown-content :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: 1rem 0;
  }

  .markdown-content :global(li:has(> input[type="checkbox"])) {
    list-style: none;
    margin-left: -1.25rem;
  }

  .markdown-content :global(input[type="checkbox"]) {
    margin-right: 0.375rem;
    accent-color: var(--accent);
    pointer-events: none;
  }

  .cursor {
    display: inline-block;
    animation: blink 1s infinite;
    color: var(--accent);
    margin-left: 0.125rem;
  }

  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  @media (max-width: 768px) {
    .markdown-content :global(pre) {
      max-width: calc(100vw - 4rem);
    }
  }
</style>
