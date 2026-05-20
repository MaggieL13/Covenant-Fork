<script lang="ts">
  import type { MessageSegment } from '@resonant/shared';
  import type { ToolEvent } from '$lib/stores/websocket.svelte';
  import MessageContent from '$lib/components/message-bubble/MessageContent.svelte';
  import ClaudeThinkingBlock from '$lib/components/message-bubble/ClaudeThinkingBlock.svelte';
  import CodexThinkingBlock from '$lib/components/message-bubble/CodexThinkingBlock.svelte';
  import GenericThinkingBlock from '$lib/components/message-bubble/GenericThinkingBlock.svelte';
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
    formatToolOutput: (raw: string, toolName?: string) => string;
    ontoggletooloutput?: (toolId: string) => void;
    ontogglethinking?: (index: number) => void;
  }>();

  let detailView = $state<{ title: string; content: string } | null>(null);

  function openDetail(title: string, content: string | undefined) {
    if (!content) return;
    detailView = { title, content };
  }

  function closeDetail() {
    detailView = null;
  }

  function agentInlineDetails(formatted: string): string {
    const marker = '\nResponse:\n';
    const idx = formatted.indexOf(marker);
    return (idx >= 0 ? formatted.slice(0, idx) : formatted).trim();
  }

  function agentFullResponse(formatted: string): string {
    const marker = '\nResponse:\n';
    const idx = formatted.indexOf(marker);
    if (idx < 0) return formatted;
    return formatted.slice(idx + marker.length).trim();
  }
</script>

{#if segments !== null && segments.length > 0 && !hideInlineTools}
  <!-- ORDER: render incoming segments in their original array order so streaming
  text/tool/thinking chronology stays byte-for-byte aligned with the backend feed. -->
  <div class="interleaved-content">
    {#each segments as seg, i (seg.type === 'tool' ? seg.toolId : `${seg.type}-${i}`)}
      {#if seg.type === 'text'}
        <MessageContent html={renderMarkdown(seg.content)} />
      {:else if seg.type === 'thinking'}
        {#if seg.providerShape === 'claude'}
          <ClaudeThinkingBlock
            content={seg.content}
            summary={seg.summary}
            index={i}
            isExpanded={expandedThinking.has(i)}
            ontoggle={ontogglethinking}
            onopenDetail={openDetail}
          />
        {:else if seg.providerShape === 'codex'}
          <CodexThinkingBlock
            content={seg.content}
            index={i}
            isExpanded={expandedThinking.has(i)}
            ontoggle={ontogglethinking}
            onopenDetail={openDetail}
          />
        {:else}
          <GenericThinkingBlock
            content={seg.content}
            index={i}
            isExpanded={expandedThinking.has(i)}
            ontoggle={ontogglethinking}
            onopenDetail={openDetail}
          />
        {/if}
      {:else}
        {@const isAgentTool = seg.toolName.startsWith('Agent')}
        {@const formatted = seg.output ? formatToolOutput(seg.output, seg.toolName) : ''}
        <div class="inline-tool" class:error={seg.isError} class:agent-tool={isAgentTool}>
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
          {#if isAgentTool && seg.output}
            <button class="agent-open-btn" onclick={(e) => { e.stopPropagation(); openDetail(seg.toolName, agentFullResponse(formatted)); }}>
              Open full
            </button>
            {#if expandedToolIds.has(seg.toolId)}
              <pre class="agent-inline-details">{agentInlineDetails(formatted)}</pre>
            {/if}
          {:else if expandedToolIds.has(seg.toolId) && seg.output}
            <div class="tool-output-wrap">
              <button class="tool-output-open" onclick={(e) => { e.stopPropagation(); openDetail(seg.toolName, formatted); }}>Open full</button>
              <pre
                class="tool-output"
                class:agent-output={seg.toolName.startsWith('Agent')}
              >{formatted}</pre>
            </div>
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
      {@const isAgentTool = tool.toolName.startsWith('Agent')}
      {@const formatted = tool.output ? formatToolOutput(tool.output, tool.toolName) : ''}
      <div class="tool-entry" class:error={tool.isError} class:agent-tool={isAgentTool}>
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
        {#if isAgentTool && tool.output}
          <button class="agent-open-btn" onclick={(e) => { e.stopPropagation(); openDetail(tool.toolName, agentFullResponse(formatted)); }}>
            Open full
          </button>
          {#if expandedToolIds.has(tool.toolId)}
            <pre class="agent-inline-details">{agentInlineDetails(formatted)}</pre>
          {/if}
        {:else if expandedToolIds.has(tool.toolId) && tool.output}
          <div class="tool-output-wrap">
            <button class="tool-output-open" onclick={(e) => { e.stopPropagation(); openDetail(tool.toolName, formatted); }}>Open full</button>
            <pre
              class="tool-output"
              class:agent-output={tool.toolName.startsWith('Agent')}
            >{formatted}</pre>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if detailView}
  <div
    class="detail-backdrop"
    role="dialog"
    aria-modal="true"
    aria-label={detailView.title}
    onclick={(e) => { if (e.target === e.currentTarget) closeDetail(); }}
    onkeydown={(e) => { if (e.key === 'Escape') closeDetail(); }}
    tabindex="-1"
  >
    <div class="detail-modal">
      <header class="detail-header">
        <h3>{detailView.title}</h3>
        <button class="detail-close" onclick={closeDetail} aria-label="Close full output">Close</button>
      </header>
      <pre class="detail-content">{detailView.content}</pre>
    </div>
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

  .tool-entry.agent-tool,
  .inline-tool.agent-tool {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.5rem;
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

  .tool-entry.agent-tool .tool-header,
  .inline-tool.agent-tool .inline-tool-header {
    min-width: 0;
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

  .tool-output-wrap {
    position: relative;
  }

  .tool-output-open {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 1;
    padding: 0.18rem 0.45rem;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-primary) 82%, var(--accent) 10%);
    color: var(--accent);
    font-family: var(--font-body);
    font-size: 0.65rem;
    cursor: pointer;
  }

  .tool-output-open:hover {
    background: color-mix(in srgb, var(--bg-primary) 70%, var(--accent) 18%);
  }

  .agent-open-btn {
    margin-left: auto;
    padding: 0.18rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-primary) 80%, var(--accent) 12%);
    color: var(--accent);
    font-family: var(--font-body);
    font-size: 0.68rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .agent-open-btn:hover {
    background: color-mix(in srgb, var(--bg-primary) 68%, var(--accent) 22%);
  }

  .agent-inline-details {
    grid-column: 1 / -1;
    margin: 0.25rem 0 0;
    padding: 0.65rem 0.75rem;
    background: color-mix(in srgb, var(--bg-primary) 88%, var(--accent) 5%);
    border: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
    border-radius: 0.45rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.5;
    max-height: 260px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-output.agent-output {
    max-height: 520px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 82%, var(--accent) 6%);
    line-height: 1.55;
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

  /* `.thinking-*` rules moved to ClaudeThinkingBlock / CodexThinkingBlock /
     GenericThinkingBlock — each component is self-contained now. */

  .detail-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    background: rgba(0, 0, 0, 0.65);
  }

  .detail-modal {
    width: min(960px, 96vw);
    max-height: min(760px, 88vh);
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid color-mix(in srgb, var(--border) 70%, var(--accent) 30%);
    border-radius: 0.875rem;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .detail-header h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 0.95rem;
  }

  .detail-close {
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .detail-close:hover {
    color: var(--text-primary);
    border-color: var(--accent);
  }

  .detail-content {
    margin: 0;
    padding: 1rem;
    overflow: auto;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 0.82rem;
    line-height: 1.55;
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

    .detail-backdrop {
      padding: 0.75rem;
    }
  }
</style>
