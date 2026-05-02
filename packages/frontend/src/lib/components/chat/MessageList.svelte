<script lang="ts">
  import MessageBubble from '$lib/components/MessageBubble.svelte';
  import type { Message, MessageSegment } from '@resonant/shared';

  type ToolEvent = {
    toolId: string;
    toolName: string;
    input?: string;
    output?: string;
    isError?: boolean;
    isComplete: boolean;
    timestamp: string;
    elapsed?: number;
  };

  type MessageListRefs = {
    getContainer: () => HTMLDivElement | null;
    getSentinel: () => HTMLDivElement | null;
  };

  let {
    messages,
    companionName,
    toolEventsMap,
    streaming,
    streamingSegments,
    isWaitingForReply = false,
    isCompacting = false,
    activeThreadId,
    loadingOlder,
    hasMoreMessages,
    shouldAutoScroll,
    onreply,
    onsuggestedprompt,
    onscroll,
    onjumptobottom,
    onregisterrefs,
  } = $props<{
    messages: Message[];
    companionName: string;
    toolEventsMap: Record<string, ToolEvent[]>;
    streaming: { messageId: string | null; tokens: string };
    streamingSegments: MessageSegment[] | null;
    isWaitingForReply?: boolean;
    isCompacting?: boolean;
    activeThreadId: string | null;
    loadingOlder: boolean;
    hasMoreMessages: boolean;
    shouldAutoScroll: boolean;
    onreply?: (message: Message) => void;
    onsuggestedprompt?: (text: string) => void;
    onscroll?: () => void;
    onjumptobottom?: () => void;
    onregisterrefs?: (refs: MessageListRefs) => void;
  }>();

  let messagesContainer = $state<HTMLDivElement | null>(null);
  let messagesEndEl = $state<HTMLDivElement | null>(null);

  const streamingMessage = $derived(
    streaming.messageId
      ? {
          id: streaming.messageId,
          thread_id: activeThreadId ?? '',
          sequence: 0,
          role: 'companion' as const,
          content: streaming.tokens,
          content_type: 'text' as const,
          platform: 'web' as const,
          metadata: null,
          reply_to_id: null,
          reply_to_preview: null,
          edited_at: null,
          deleted_at: null,
          original_content: null,
          created_at: new Date().toISOString(),
          delivered_at: null,
          read_at: null,
        }
      : null
  );

  $effect(() => {
    messagesContainer;
    messagesEndEl;
    onregisterrefs;
    // ORDER: register getter callbacks only after bind:this has populated the
    // local refs so the page-owned controllers observe the live message DOM.
    onregisterrefs?.({
      getContainer: () => messagesContainer,
      getSentinel: () => messagesEndEl,
    });
  });
</script>

<div
  class="messages-container"
  bind:this={messagesContainer}
  onscroll={onscroll}
>
  <div class="messages-list">
    {#if loadingOlder}
      <div class="loading-older">Loading older messages...</div>
    {:else if !hasMoreMessages && messages.length > 0}
      <div class="thread-start">Beginning of conversation</div>
    {/if}

    {#if messages.length === 0}
      <div class="empty-state">
        <div class="empty-icon">&#128172;</div>
        <h3 class="empty-title">Start a conversation</h3>
        <p class="empty-subtitle">Say hello, ask a question, or try one of these:</p>
        <div class="suggested-prompts">
          <button class="prompt-chip" onclick={() => onsuggestedprompt?.('How are you today?')}>
            How are you today?
          </button>
          <button class="prompt-chip" onclick={() => onsuggestedprompt?.('Tell me something interesting')}>
            Tell me something interesting
          </button>
          <button class="prompt-chip" onclick={() => onsuggestedprompt?.('What can you help me with?')}>
            What can you help me with?
          </button>
        </div>
      </div>
    {:else}
      {#each messages as message (message.id)}
        <div
          id="msg-{message.id}"
          class="message-wrapper"
          role="button"
          tabindex="0"
          aria-label={`Reply to ${message.role === 'companion' ? companionName : 'You'} message`}
          oncontextmenu={(event) => {
            event.preventDefault();
            onreply?.(message);
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onreply?.(message);
            }
          }}
        >
          <MessageBubble
            {message}
            toolEvents={toolEventsMap[message.id] || []}
            segments={message.metadata?.segments as any || null}
            {companionName}
          />
        </div>
      {/each}

      {#if isWaitingForReply && !streaming.messageId}
        <!-- Stage 1: agent is streaming on a different thread; this
             thread's message is queued. Same dots shape as the active
             stream's thinking state, but a distinct label so the user
             can tell "queued" from "actively being worked on". When the
             stream shifts to this thread this block vanishes and the
             {companionName} is thinking... panel below takes over. -->
        <div class="message-wrapper">
          <div class="activity-panel" aria-label="Waiting for companion">
            <div class="activity-header">
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="activity-label">Waiting...</span>
            </div>
          </div>
        </div>
      {/if}

      {#if streaming.messageId && streamingMessage}
        {@const liveTools = toolEventsMap[streaming.messageId] || []}
        <div class="message-wrapper">
          {#if streaming.tokens}
            <MessageBubble
              message={streamingMessage}
              isStreaming={true}
              streamTokens={streaming.tokens}
              toolEvents={liveTools}
              segments={streamingSegments}
              {companionName}
            />
          {:else}
            <div
              class="activity-panel"
              aria-label={isCompacting ? 'Chat context is being compacted' : 'Companion is working'}
            >
              <div class="activity-header">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="activity-label">
                  {isCompacting ? 'Chat context is being compacted...' : `${companionName} is thinking...`}
                </span>
              </div>
              {#if liveTools.length > 0}
                <div class="activity-tools">
                  {#each liveTools as tool}
                    <div class="activity-tool" class:complete={tool.isComplete} class:error={tool.isError}>
                      <span class="tool-status">{tool.isComplete ? (tool.isError ? '!' : '') : ''}</span>
                      <span class="tool-name">{tool.toolName}</span>
                      {#if tool.input}
                        <span class="tool-input">{tool.input}</span>
                      {/if}
                      {#if tool.elapsed}
                        <span class="tool-elapsed">{tool.elapsed.toFixed(1)}s</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/if}

    <div bind:this={messagesEndEl} class="messages-end-sentinel"></div>
  </div>
</div>

{#if !shouldAutoScroll}
  <div class="scroll-to-bottom-wrapper">
    <button class="scroll-to-bottom" onclick={onjumptobottom} aria-label="Scroll to bottom">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
      </svg>
    </button>
  </div>
{/if}

<style>
  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-primary);
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    padding: 1.5rem 1rem;
    min-height: 100%;
    max-width: 48rem;
    margin: 0 auto;
    width: 100%;
  }

  .loading-older,
  .thread-start {
    text-align: center;
    padding: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  .loading-older {
    font-style: italic;
  }

  .thread-start {
    font-family: var(--font-heading);
    opacity: 0.5;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 0.5rem;
    padding: 2rem;
    text-align: center;
  }

  .empty-icon {
    font-size: 3rem;
    line-height: 1;
    margin-bottom: 0.25rem;
    opacity: 0.7;
  }

  .empty-title {
    font-family: var(--font-heading);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .empty-subtitle {
    font-size: 0.875rem;
    color: var(--text-muted);
    margin: 0 0 0.75rem;
  }

  .suggested-prompts {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    max-width: 480px;
  }

  .prompt-chip {
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.8125rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .prompt-chip:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .message-wrapper {
    width: 100%;
    min-width: 0;
    display: flex;
  }

  :global(.message-wrapper.highlight-flash) {
    animation: highlightFlash 2s ease-out;
  }

  @keyframes highlightFlash {
    0% { background: rgba(155, 114, 207, 0.2); }
    100% { background: transparent; }
  }

  .activity-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-radius: 0;
    align-self: flex-start;
    margin: 0.75rem 0;
    width: 100%;
  }

  .activity-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .activity-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
    font-style: italic;
    letter-spacing: 0.02em;
  }

  .activity-tools {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }

  .activity-tool {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    opacity: 0.7;
    animation: fadeIn 0.3s ease-out;
  }

  .activity-tool.complete {
    opacity: 0.4;
  }

  .activity-tool.error {
    color: var(--error, #ef4444);
  }

  .tool-status {
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .activity-tool .tool-name {
    color: var(--gold-dim);
    white-space: nowrap;
  }

  .activity-tool .tool-input {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-elapsed {
    color: var(--text-muted);
    font-size: 0.65rem;
    font-family: var(--font-mono);
    margin-left: auto;
    flex-shrink: 0;
  }

  .typing-dot {
    width: 0.3rem;
    height: 0.3rem;
    background: var(--gold-dim);
    border-radius: 50%;
    animation: typingBounce 1.4s infinite ease-in-out;
  }

  .typing-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typingBounce {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-0.375rem);
      opacity: 1;
    }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 0.7; }
  }

  .scroll-to-bottom-wrapper {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
    flex-shrink: 0;
  }

  .scroll-to-bottom {
    width: 2.25rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    cursor: pointer;
    box-shadow: var(--shadow-md);
    transition: all 0.15s;
    opacity: 0.85;
  }

  .scroll-to-bottom:hover {
    opacity: 1;
    color: var(--text-primary);
    transform: translateY(1px);
  }

  @media (max-width: 768px) {
    .messages-list {
      padding: 0.75rem;
      max-width: 100%;
    }
  }
</style>
