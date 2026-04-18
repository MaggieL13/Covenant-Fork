<script lang="ts">
  import type { MessageSegment } from '@resonant/shared';
  import type { ToolEvent } from '$lib/stores/websocket.svelte';
  import MessageContent from '$lib/components/message-bubble/MessageContent.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';

  let {
    segments = null,
    toolEvents = [],
    isStreaming = false,
    hideInlineTools = false,
    showTools = false,
    expandedToolIds,
    expandedThinking,
    formatToolOutput,
    ontoggletooloutput,
    ontogglethinking,
  } = $props<{
    segments?: MessageSegment[] | null;
    toolEvents?: ToolEvent[];
    isStreaming?: boolean;
    hideInlineTools?: boolean;
    showTools?: boolean;
    expandedToolIds: Set<string>;
    expandedThinking: Set<number>;
    formatToolOutput: (raw: string) => string;
    ontoggletooloutput?: (toolId: string) => void;
    ontogglethinking?: (index: number) => void;
  }>();
</script>

{#if segments !== null && segments.length > 0 && !hideInlineTools}
  <!-- ORDER: render incoming segments in their original array order so streaming
  text/tool/thinking chronology stays byte-for-byte aligned with the backend feed. -->
  <div class="interleaved-content">
    {#each segments as seg, i (seg.type === 'tool' ? seg.toolId : `${seg.type}-${i}`)}
      {#if seg.type === 'text'}
        <MessageContent html={renderMarkdown(seg.content)} />
      {:else if seg.type === 'thinking'}
        <div class="thinking-block">
          <button class="thinking-header" onclick={(e) => { e.stopPropagation(); ontogglethinking?.(i); }}>
            <span class="thinking-icon">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            </span>
            <span class="thinking-summary">{seg.summary}</span>
            <span class="thinking-chevron">{expandedThinking.has(i) ? '▾' : '▸'}</span>
          </button>
          {#if expandedThinking.has(i)}
            <div class="thinking-content">{seg.content}</div>
          {/if}
        </div>
      {:else}
        <div class="inline-tool" class:error={seg.isError}>
          <button
            class="inline-tool-header"
            onclick={(e) => { e.stopPropagation(); ontoggletooloutput?.(seg.toolId); }}
            disabled={!seg.output}
          >
            <span class="tool-chevron">{expandedToolIds.has(seg.toolId) ? '▾' : '▸'}</span>
            <span class="tool-name">{seg.toolName}</span>
            {#if seg.input}
              <span class="tool-input">{seg.input}</span>
            {/if}
            {#if seg.isError}
              <span class="tool-error-badge">error</span>
            {/if}
            {#if !seg.output && isStreaming}
              <span class="tool-spinner"></span>
            {/if}
          </button>
          {#if expandedToolIds.has(seg.toolId) && seg.output}
            <pre class="tool-output">{formatToolOutput(seg.output)}</pre>
          {/if}
        </div>
      {/if}
    {/each}
    {#if isStreaming}
      <span class="cursor">|</span>
    {/if}
  </div>
{/if}

{#if showTools && toolEvents.length > 0}
  <div class="tools-panel">
    {#each toolEvents as tool (tool.toolId)}
      <div class="tool-entry" class:error={tool.isError}>
        <button
          class="tool-header"
          onclick={(e) => { e.stopPropagation(); ontoggletooloutput?.(tool.toolId); }}
          disabled={!tool.output}
        >
          <span class="tool-chevron">{expandedToolIds.has(tool.toolId) ? '' : ''}</span>
          <span class="tool-name">{tool.toolName}</span>
          {#if tool.input}
            <span class="tool-input">{tool.input}</span>
          {/if}
          {#if tool.isError}
            <span class="tool-error-badge">error</span>
          {/if}
        </button>
        {#if expandedToolIds.has(tool.toolId) && tool.output}
          <pre class="tool-output">{formatToolOutput(tool.output)}</pre>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .tools-panel {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .tool-entry {
    display: flex;
    flex-direction: column;
  }

  .tool-entry.error .tool-name {
    color: var(--error, #ef4444);
  }

  .tool-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    cursor: pointer;
    text-align: left;
    border-radius: 0.25rem;
    transition: background 0.15s;
  }

  .tool-header:hover {
    background: var(--bg-hover);
  }

  .tool-header:disabled {
    cursor: default;
  }

  .tool-chevron {
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
    font-size: 0.625rem;
  }

  .tool-entry .tool-name {
    color: var(--accent);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .tool-entry .tool-input {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.6875rem;
  }

  .tool-error-badge {
    font-size: 0.5625rem;
    color: var(--error, #ef4444);
    background: rgba(239, 68, 68, 0.15);
    padding: 0.0625rem 0.25rem;
    border-radius: 0.125rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .tool-output {
    margin: 0.25rem 0 0.25rem 1rem;
    padding: 0.5rem;
    background: var(--bg-primary);
    border-radius: 0.25rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
    line-height: 1.4;
    max-height: 200px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .interleaved-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .inline-tool {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin: 0.375rem 0;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
  }

  .inline-tool.error {
    border-color: var(--error, #ef4444);
  }

  .inline-tool-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-family: var(--font-mono);
    cursor: pointer;
    text-align: left;
    border-radius: 0.25rem;
    transition: background 0.15s;
  }

  .inline-tool-header:hover {
    background: var(--bg-hover);
  }

  .inline-tool-header:disabled {
    cursor: default;
  }

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
  }

  .thinking-header:hover {
    background: var(--bg-hover);
    color: var(--text-secondary);
  }

  .thinking-icon {
    flex-shrink: 0;
    color: var(--accent);
    display: flex;
    align-items: center;
  }

  .thinking-summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
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
  }

  .tool-spinner {
    width: 0.625rem;
    height: 0.625rem;
    border: 1.5px solid var(--accent);
    border-top-color: transparent;
    border-radius: 50%;
    animation: toolSpin 0.8s linear infinite;
    flex-shrink: 0;
  }

  .cursor {
    display: inline-block;
    animation: blink 1s infinite;
    color: var(--accent);
    margin-left: 0.125rem;
  }

  @keyframes toolSpin {
    to { transform: rotate(360deg); }
  }

  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  @media (max-width: 768px) {
    .tool-output {
      max-width: calc(100vw - 4rem);
    }

    .tools-panel {
      max-width: calc(100vw - 4rem);
      overflow: hidden;
    }

    .interleaved-content {
      max-width: calc(100vw - 4rem);
      overflow: hidden;
    }
  }
</style>
