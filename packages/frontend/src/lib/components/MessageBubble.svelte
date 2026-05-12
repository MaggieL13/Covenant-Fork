<script lang="ts">
  import type { Message, MessageSegment, Reaction } from '@resonant/shared';
  import type { ToolEvent } from '$lib/stores/websocket.svelte';
  import { send } from '$lib/stores/websocket.svelte';
  import MessageContent from '$lib/components/message-bubble/MessageContent.svelte';
  import MessageFooterControls from '$lib/components/message-bubble/MessageFooterControls.svelte';
  import MessageMedia from '$lib/components/message-bubble/MessageMedia.svelte';
  import MessageMeta from '$lib/components/message-bubble/MessageMeta.svelte';
  import ToolActivityPanel from '$lib/components/message-bubble/ToolActivityPanel.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { apiFetch } from '$lib/utils/api';

  let { message, isStreaming = false, streamTokens = '', toolEvents = [], segments = null, companionName = 'Companion' } = $props<{
    message: Message;
    isStreaming?: boolean;
    streamTokens?: string;
    toolEvents?: ToolEvent[];
    segments?: MessageSegment[] | null;
    companionName?: string;
  }>();

  const isDeleted = $derived(!!message.deleted_at);
  const contentType = $derived(message.content_type || 'text');
  const metadata = $derived(message.metadata as Record<string, unknown> | null);

  type SubagentModel = { id: string; label: string; minClaudeCodeVersion?: string };
  type SubagentPreset = { name: string; description?: string; model: string };
  type CommandMetadata = {
    kind?: string;
    commandName?: string;
    data?: {
      models?: SubagentModel[];
      subagents?: SubagentPreset[];
    } | null;
  };

  const commandMetadata = $derived(metadata as CommandMetadata | null);
  const isSubagentsCommand = $derived(commandMetadata?.kind === 'command_result' && commandMetadata.commandName === 'subagents');
  const subagentModels = $derived(Array.isArray(commandMetadata?.data?.models) ? commandMetadata.data.models : []);
  const subagentPresets = $derived(Array.isArray(commandMetadata?.data?.subagents) ? commandMetadata.data.subagents : []);

  function renderCanvasRefs(text: string): string {
    return text.replace(/<<canvas:([^:]+):(.+?)>>/g, (_match, id, title) => {
      return `<span class="canvas-ref-inline" data-canvas-id="${id}" title="Canvas: ${title}">📄 ${title}</span>`;
    });
  }

  const renderedContent = $derived(() => {
    if (isDeleted) return '';
    if (isStreaming && streamTokens) return renderMarkdown(streamTokens);
    if (contentType !== 'text') return '';
    const withRefs = renderCanvasRefs(message.content);
    return renderMarkdown(withRefs);
  });

  function formatAgentOutput(parsed: unknown): string | null {
    if (!parsed || typeof parsed !== 'object') return null;
    const data = parsed as Record<string, unknown>;
    const lines: string[] = [];

    if (typeof data.status === 'string') {
      lines.push(`Status: ${data.status}`);
    }

    if (typeof data.prompt === 'string' && data.prompt.trim()) {
      if (lines.length > 0) lines.push('');
      lines.push('Prompt:');
      lines.push(data.prompt.trim());
    }

    const content = Array.isArray(data.content) ? data.content : [];
    const textBlocks = content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const obj = block as Record<string, unknown>;
        return obj.type === 'text' && typeof obj.text === 'string' ? obj.text.trim() : '';
      })
      .filter(Boolean);

    if (textBlocks.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('Response:');
      lines.push(textBlocks.join('\n\n'));
    }

    const metrics: string[] = [];
    if (typeof data.totalDurationMs === 'number') metrics.push(`${Math.round(data.totalDurationMs / 1000)}s`);
    if (typeof data.totalTokens === 'number') metrics.push(`${data.totalTokens.toLocaleString()} tokens`);
    if (metrics.length > 0) {
      lines.push('');
      lines.push(`Run: ${metrics.join(' · ')}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  function formatToolOutput(raw: string, toolName?: string): string {
    if (!raw) return '';
    const trimmedRaw = raw.trim();
    if ((trimmedRaw.startsWith('{') || trimmedRaw.startsWith('[')) && trimmedRaw.length > 2) {
      try {
        const parsed = JSON.parse(trimmedRaw);
        if (toolName?.startsWith('Agent')) {
          const agentOutput = formatAgentOutput(parsed);
          if (agentOutput) return agentOutput;
        }
        return JSON.stringify(parsed, null, 2);
      } catch {}
    }

    const cleaned = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const trimmed = cleaned.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
      try {
        const parsed = JSON.parse(trimmed);
        if (toolName?.startsWith('Agent')) {
          const agentOutput = formatAgentOutput(parsed);
          if (agentOutput) return agentOutput;
        }
        return JSON.stringify(parsed, null, 2);
      } catch {}
    }
    return cleaned;
  }

  let showTools = $state(false);
  let hideInlineTools = $state(false);
  let expandedToolIds = $state<Set<string>>(new Set());
  let expandedThinking = $state<Set<number>>(new Set());

  function toggleThinking(index: number) {
    const next = new Set(expandedThinking);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    expandedThinking = next;
  }

  function toggleToolOutput(toolId: string) {
    const next = new Set(expandedToolIds);
    if (next.has(toolId)) next.delete(toolId);
    else next.add(toolId);
    expandedToolIds = next;
  }

  const ttsCache = (globalThis as Record<string, unknown>).__ttsCache ??= new Map<string, string>();
  let ttsState = $state<'idle' | 'loading' | 'playing'>('idle');
  let ttsAudioEl: HTMLAudioElement | null = null;
  const canReadAloud = $derived(message.role === 'companion' && contentType === 'text' && !isDeleted && message.content.length > 5);

  async function toggleReadAloud() {
    if (ttsState === 'playing' && ttsAudioEl) {
      ttsAudioEl.pause();
      ttsAudioEl = null;
      ttsState = 'idle';
      return;
    }
    if (ttsState === 'loading') return;

    // ORDER: unlock playback during the user gesture before the async TTS fetch
    // resolves, or mobile browsers may reject the eventual real-audio play call.
    const audio = new Audio();
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    try { await audio.play(); } catch {}
    audio.pause();

    ttsAudioEl = audio;
    const cached = (ttsCache as Map<string, string>).get(message.id);

    try {
      let blobUrl: string;

      if (cached) {
        blobUrl = cached;
      } else {
        ttsState = 'loading';
        const res = await apiFetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message.content }),
        });
        if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
        const blob = await res.blob();
        if (blob.size === 0) throw new Error('TTS returned empty audio');
        blobUrl = URL.createObjectURL(blob);
        (ttsCache as Map<string, string>).set(message.id, blobUrl);
      }

      audio.onended = () => {
        ttsState = 'idle';
        ttsAudioEl = null;
      };
      audio.onerror = () => {
        ttsState = 'idle';
        ttsAudioEl = null;
      };

      audio.src = blobUrl;
      await audio.play();
      ttsState = 'playing';
    } catch (err) {
      console.error('[TTS] Read aloud failed:', err);
      ttsState = 'idle';
      ttsAudioEl = null;
    }
  }

  const reactions = $derived(() => {
    const meta = message.metadata as Record<string, unknown> | null;
    if (!meta || !Array.isArray(meta.reactions)) return [] as Reaction[];
    return meta.reactions as Reaction[];
  });

  const groupedReactions = $derived(() => {
    const rxns = reactions();
    const map = new Map<string, { emoji: string; count: number; users: string[] }>();
    for (const r of rxns) {
      const entry = map.get(r.emoji);
      if (entry) {
        entry.count++;
        entry.users.push(r.user);
      } else {
        map.set(r.emoji, { emoji: r.emoji, count: 1, users: [r.user] });
      }
    }
    return Array.from(map.values());
  });

  function toggleReaction(emoji: string) {
    const rxns = reactions();
    const myReaction = rxns.find((r) => r.emoji === emoji && r.user === 'user');
    if (myReaction) {
      send({ type: 'remove_reaction', messageId: message.id, emoji });
    } else {
      send({ type: 'add_reaction', messageId: message.id, emoji });
    }
  }

  let messageContentEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    // ORDER: keep copy-button registration parent-owned and run after child content/media
    // markup renders so every <pre> inside the shared message-content wrapper is present.
    if (!messageContentEl) return;
    const codeBlocks = messageContentEl.querySelectorAll('pre');
    codeBlocks.forEach((pre) => {
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.onclick = async () => {
        const code = pre.querySelector('code')?.textContent || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(code);
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        } catch {
          btn.textContent = 'Failed';
          setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
        }
      };
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  });

  const readStatus = $derived(() => {
    if (message.role !== 'user') return null;
    if (message.read_at) return 'read';
    if (message.delivered_at) return 'delivered';
    return 'sent';
  });
</script>

{#if message.role === 'system'}
  <div class="message-system">
    {#if isSubagentsCommand}
      <div class="system-command-card" aria-label="Subagent help">
        <header class="command-card-header">
          <div>
            <span class="command-label">/subagents</span>
            <h3>Helper agents</h3>
          </div>
          <span class="command-count">{subagentModels.length} models</span>
        </header>

        <section class="command-section">
          <div class="section-heading">
            <span>Models</span>
            <small>Pinned IDs, safest for helper work</small>
          </div>
          <div class="model-list">
            {#each subagentModels as model (model.id)}
              <div class="model-row">
                <span class="model-label">{model.label}</span>
                <code>{model.id}</code>
                {#if model.minClaudeCodeVersion}
                  <span class="model-badge">CC {model.minClaudeCodeVersion}+</span>
                {/if}
              </div>
            {/each}
          </div>
        </section>

        <section class="command-section">
          <div class="section-heading">
            <span>Named presets</span>
            <small>Saved workflows you can reuse by name</small>
          </div>
          {#if subagentPresets.length > 0}
            <div class="preset-list">
              {#each subagentPresets as preset (preset.name)}
                <div class="preset-row">
                  <strong>{preset.name}</strong>
                  <code>{preset.model}</code>
                  {#if preset.description}
                    <span>{preset.description}</span>
                  {/if}
                </div>
              {/each}
            </div>
          {:else}
            <p class="empty-presets">None yet. Ask: “Save this workflow as a subagent preset called plan-reviewer.”</p>
          {/if}
        </section>

        <section class="command-section examples-section">
          <div class="section-heading">
            <span>How to ask</span>
          </div>
          <div class="example-list">
            <span>“Send a Sonnet scout to inspect this bug.”</span>
            <span>“Use an Opus subagent to review this plan.”</span>
            <span>“Save this workflow as a subagent preset called plan-reviewer.”</span>
          </div>
        </section>
      </div>
    {:else}
      <span class="system-text">{message.content}</span>
    {/if}
  </div>
{:else}
  <article
    class="message {message.role}"
    class:deleted={isDeleted}
    class:sticker-only={contentType === 'sticker'}
    aria-label="{message.role} message"
  >
    <MessageMeta
      role={message.role}
      companionName={companionName}
      createdAt={message.created_at}
      editedAt={message.edited_at}
      isDeleted={isDeleted}
      hasSegments={segments !== null && segments.length > 0}
      hasTools={toolEvents.length > 0}
      hideInlineTools={hideInlineTools}
      showTools={showTools}
      toolEventsCount={toolEvents.length}
      onToggleInlineTools={(e) => { e.stopPropagation(); hideInlineTools = !hideInlineTools; }}
      onToggleTools={(e) => { e.stopPropagation(); showTools = !showTools; }}
    />

    {#if message.reply_to_preview && !isDeleted}
      <div class="reply-preview">
        <div class="reply-bar"></div>
        <div class="reply-content">{message.reply_to_preview}</div>
      </div>
    {/if}

    <div class="message-content" bind:this={messageContentEl}>
      {#if isDeleted}
        <MessageContent deleted />
      {:else if contentType === 'sticker' || contentType === 'image' || contentType === 'audio' || contentType === 'file'}
        <MessageMedia contentType={contentType} content={message.content} metadata={metadata} alignRight={message.role === 'user'} />
      {:else if segments !== null && segments.length > 0 && !hideInlineTools}
        <ToolActivityPanel
          {segments}
          toolEvents={[]}
          {isStreaming}
          {hideInlineTools}
          showTools={false}
          {expandedToolIds}
          {expandedThinking}
          {formatToolOutput}
          ontoggletooloutput={toggleToolOutput}
          ontogglethinking={toggleThinking}
        />
      {:else}
        <MessageContent html={renderedContent()} showCursor={isStreaming} />
      {/if}
    </div>

    <ToolActivityPanel
      segments={null}
      {toolEvents}
      {isStreaming}
      hideInlineTools={true}
      {showTools}
      {expandedToolIds}
      {expandedThinking}
      {formatToolOutput}
      ontoggletooloutput={toggleToolOutput}
      ontogglethinking={toggleThinking}
    />

    {#if !isDeleted && groupedReactions().length > 0 && message.role !== 'user'}
      <MessageFooterControls
        role={message.role}
        isDeleted={isDeleted}
        isStreaming={isStreaming}
        groupedReactions={groupedReactions()}
        canReadAloud={canReadAloud}
        readAloudState={ttsState}
        onToggleReaction={toggleReaction}
        onAddReaction={(emoji) => send({ type: 'add_reaction', messageId: message.id, emoji })}
        onToggleReadAloud={toggleReadAloud}
      />
    {:else if !isDeleted && !isStreaming && message.role !== 'user'}
      <MessageFooterControls
        role={message.role}
        isDeleted={isDeleted}
        isStreaming={isStreaming}
        groupedReactions={groupedReactions()}
        canReadAloud={canReadAloud}
        readAloudState={ttsState}
        showHoverOnly
        onToggleReaction={toggleReaction}
        onAddReaction={(emoji) => send({ type: 'add_reaction', messageId: message.id, emoji })}
        onToggleReadAloud={toggleReadAloud}
      />
    {/if}

    {#if message.role === 'user'}
      <div class="user-footer">
        <MessageFooterControls
          role={message.role}
          groupedReactions={groupedReactions()}
          onToggleReaction={toggleReaction}
          onAddReaction={(emoji) => send({ type: 'add_reaction', messageId: message.id, emoji })}
        />
        <div class="user-footer-right">
          <span class="time-inline">{new Date(message.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
          {#if readStatus()}
            {#if readStatus() === 'read'}
              <span class="check read" title="Read">&#10003;&#10003;</span>
            {:else if readStatus() === 'delivered'}
              <span class="check" title="Delivered">&#10003;&#10003;</span>
            {:else}
              <span class="check" title="Sent">&#10003;</span>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  </article>
{/if}

<style>
  .message-system {
    display: flex;
    justify-content: center;
    margin: 1rem 0;
  }

  .system-command-card {
    width: min(720px, calc(100vw - 3rem));
    padding: 1rem;
    border: 1px solid color-mix(in srgb, var(--border) 70%, var(--accent) 30%);
    border-radius: 0.75rem;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 92%, var(--accent) 8%), var(--bg-surface));
    color: var(--text-secondary);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }

  .command-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 0.85rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  }

  .command-label {
    display: block;
    margin-bottom: 0.2rem;
    color: var(--accent);
    font-family: var(--font-mono);
    font-size: 0.75rem;
  }

  .command-card-header h3 {
    margin: 0;
    color: var(--text-primary);
    font-size: 1rem;
    font-weight: 650;
  }

  .command-count,
  .model-badge {
    flex-shrink: 0;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: 999px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    font-size: 0.72rem;
    line-height: 1;
    padding: 0.32rem 0.5rem;
  }

  .command-section {
    padding-top: 0.9rem;
  }

  .section-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.55rem;
  }

  .section-heading span {
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 650;
  }

  .section-heading small {
    color: var(--text-muted);
    font-size: 0.74rem;
  }

  .model-list,
  .preset-list,
  .example-list {
    display: grid;
    gap: 0.4rem;
  }

  .model-row,
  .preset-row {
    display: grid;
    grid-template-columns: 5.4rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.65rem;
    min-height: 2rem;
    padding: 0.35rem 0;
    border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
  }

  .model-row:first-child,
  .preset-row:first-child {
    border-top: none;
  }

  .model-label,
  .preset-row strong {
    color: var(--text-primary);
    font-size: 0.84rem;
    font-weight: 600;
  }

  .model-row code,
  .preset-row code {
    min-width: 0;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-tertiary) 85%, transparent);
    border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
    border-radius: 0.35rem;
    padding: 0.18rem 0.35rem;
    font-family: var(--font-mono);
    font-size: 0.77rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preset-row {
    grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
  }

  .preset-row span {
    grid-column: 1 / -1;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .empty-presets {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.84rem;
    line-height: 1.5;
  }

  .examples-section {
    margin-top: 0.15rem;
    padding-top: 0.85rem;
    border-top: 1px solid color-mix(in srgb, var(--border) 82%, transparent);
  }

  .example-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .example-list span {
    border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
    border-radius: 0.5rem;
    padding: 0.55rem 0.6rem;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-tertiary) 45%, transparent);
    font-size: 0.78rem;
    line-height: 1.35;
  }

  .message.sticker-only {
    background: none !important;
    border: none !important;
    box-shadow: none !important;
    padding: 0.4rem 1.1rem !important;
  }

  :global(.inline-sticker) {
    height: 2.5em;
    vertical-align: middle;
    display: inline;
    margin: 0 0.15em;
  }

  :global(.canvas-ref-inline) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.15rem 0.5rem;
    border-radius: 0.75rem;
    background: var(--bg-tertiary, #1a1428);
    border: 1px solid var(--accent, #9b72cf);
    color: var(--accent, #9b72cf);
    font-size: 0.8rem;
    font-family: var(--font-heading, 'Cinzel', serif);
    letter-spacing: 0.03em;
    white-space: nowrap;
    vertical-align: middle;
  }

  .system-text {
    display: block;
    font-size: 0.875rem;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--bg-surface) 88%, var(--accent) 12%);
    border: 1px solid color-mix(in srgb, var(--border) 78%, var(--accent) 22%);
    padding: 0.85rem 1rem;
    border-radius: var(--radius-sm);
    max-width: min(860px, calc(100vw - 3rem));
    white-space: pre-wrap;
    line-height: 1.6;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin: 0.4rem 0;
    padding: 1rem 1.1rem;
    position: relative;
    max-width: 100%;
    overflow-wrap: break-word;
  }

  .message.companion {
    align-self: flex-start;
    width: 100%;
    background: var(--companion-bg);
    border: 1px solid var(--border);
    border-radius: 1.125rem;
    padding-left: 1.1rem;
    box-shadow: inset 0 1px 0 var(--border);
  }

  .message.user {
    align-self: flex-end;
    margin-left: auto;
    max-width: 70%;
    width: fit-content;
    background: var(--user-bg);
    border: 1px solid var(--border);
    border-radius: 1.125rem;
    padding: 0.6rem 0.9rem;
    gap: 0.25rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }

  .message.deleted {
    opacity: 0.6;
  }

  .reply-preview {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.1rem;
    padding: 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    font-size: 0.875rem;
  }

  .reply-bar {
    width: 2px;
    background: var(--accent);
    border-radius: 1px;
    flex-shrink: 0;
  }

  .reply-content {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .message-content {
    color: var(--text-primary);
    line-height: 1.5;
    word-wrap: break-word;
    overflow-wrap: break-word;
    min-width: 0;
  }

  .message-content :global(.copy-btn) {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    padding: 0.25rem 0.625rem;
    font-size: 0.6875rem;
    font-family: var(--font-body);
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-muted, #888);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.375rem;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s, color 0.15s;
    z-index: 1;
  }

  .message-content :global(pre:hover .copy-btn) {
    opacity: 1;
  }

  .message-content :global(.copy-btn:hover) {
    background: rgba(255, 255, 255, 0.15);
    color: var(--text-primary, #e0e0e0);
  }

  .user-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .user-footer-right {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    margin-left: auto;
  }

  .time-inline {
    font-size: 0.6rem;
    color: var(--text-muted);
    opacity: 0.7;
  }

  .check {
    font-size: 0.7rem;
    color: var(--text-muted);
    letter-spacing: -0.25em;
  }

  .check.read {
    color: var(--accent);
  }

  @media (max-width: 768px) {
    .command-card-header,
    .section-heading {
      align-items: flex-start;
      flex-direction: column;
      gap: 0.35rem;
    }

    .model-row,
    .preset-row,
    .example-list {
      grid-template-columns: 1fr;
    }

    .model-badge {
      justify-self: flex-start;
    }

    .message.user {
      max-width: 85%;
    }

    .message {
      overflow: hidden;
    }

    .message-content {
      overflow: hidden;
    }
  }
</style>
