<script lang="ts">
  import type { Message, MessageSegment, Reaction } from '@resonant/shared';
  import type { ToolEvent } from '$lib/stores/websocket.svelte';
  import { send } from '$lib/stores/websocket.svelte';
  import MessageContent from '$lib/components/message-bubble/MessageContent.svelte';
  import MessageMedia from '$lib/components/message-bubble/MessageMedia.svelte';
  import MessageMeta from '$lib/components/message-bubble/MessageMeta.svelte';
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

  // Determine if message is deleted
  const isDeleted = $derived(!!message.deleted_at);

  // Content type detection
  const contentType = $derived(message.content_type || 'text');
  const metadata = $derived(message.metadata as Record<string, unknown> | null);

  // Replace <<canvas:id:title>> markers with styled chips
  function renderCanvasRefs(text: string): string {
    return text.replace(/<<canvas:([^:]+):(.+?)>>/g, (_match, id, title) => {
      return `<span class="canvas-ref-inline" data-canvas-id="${id}" title="Canvas: ${title}">📄 ${title}</span>`;
    });
  }

  // Render text content
  const renderedContent = $derived(() => {
    if (isDeleted) return '';
    if (isStreaming && streamTokens) return renderMarkdown(streamTokens);
    if (contentType !== 'text') return '';
    // Render canvas refs first, then markdown
    const withRefs = renderCanvasRefs(message.content);
    return renderMarkdown(withRefs);
  });

  function formatToolOutput(raw: string): string {
    if (!raw) return '';
    // Replace escaped \n and \t with real whitespace
    let cleaned = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    const trimmed = cleaned.trim();
    // Pretty-print JSON blobs
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
      try { return JSON.stringify(JSON.parse(trimmed), null, 2); } catch {}
    }
    return cleaned;
  }

  // Interleaved segments mode
  const hasSegments = $derived(segments !== null && segments.length > 0);

  // Tool panel state
  let showTools = $state(false);
  let hideInlineTools = $state(false);
  let expandedToolIds = $state<Set<string>>(new Set());
  const hasTools = $derived(toolEvents.length > 0);

  // Thinking block expand/collapse state (tracks by segment index)
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

  // Read aloud (on-demand TTS) — cache blob URLs by message ID across instances
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

    // Create and play a silent audio element NOW (during user gesture)
    // so mobile browsers unlock playback. We swap in the real src once TTS loads.
    const audio = new Audio();
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    try { await audio.play(); } catch { /* silent unlock attempt */ }
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

  // Reactions
  const reactions = $derived(() => {
    const meta = message.metadata as Record<string, unknown> | null;
    if (!meta || !Array.isArray(meta.reactions)) return [] as Reaction[];
    return meta.reactions as Reaction[];
  });

  // Group reactions: { emoji, count, users[] }
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
    const myReaction = rxns.find(r => r.emoji === emoji && r.user === 'user');
    if (myReaction) {
      send({ type: 'remove_reaction', messageId: message.id, emoji });
    } else {
      send({ type: 'add_reaction', messageId: message.id, emoji });
    }
  }

  const QUICK_EMOJIS = ['❤️', '😂', '👍', '🔥', '😢', '✨'];
  let pickerOpen = $state(false);
  let pickerEl: HTMLDivElement | undefined = $state();

  function openReactionPicker() {
    pickerOpen = !pickerOpen;
  }

  function pickEmoji(emoji: string) {
    send({ type: 'add_reaction', messageId: message.id, emoji });
    pickerOpen = false;
  }

  function handlePickerClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      pickerOpen = false;
    }
  }

  $effect(() => {
    if (pickerOpen) {
      document.addEventListener('click', handlePickerClickOutside, true);
      return () => document.removeEventListener('click', handlePickerClickOutside, true);
    }
  });

  // Code block copy buttons
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

  // Read receipt indicator
  const readStatus = $derived(() => {
    if (message.role !== 'user') return null;
    if (message.read_at) return 'read';
    if (message.delivered_at) return 'delivered';
    return 'sent';
  });
</script>

{#if message.role === 'system'}
  <div class="message-system">
    <span class="system-text">{message.content}</span>
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
      hasSegments={hasSegments}
      hasTools={hasTools}
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
      {:else if hasSegments && !hideInlineTools}
        <!-- Interleaved mode: text, tools, and thinking inline -->
        <div class="interleaved-content">
          {#each segments as seg, i (seg.type === 'tool' ? seg.toolId : `${seg.type}-${i}`)}
            {#if seg.type === 'text'}
              <MessageContent html={renderMarkdown(seg.content)} />
            {:else if seg.type === 'thinking'}
              <div class="thinking-block">
                <button class="thinking-header" onclick={(e) => { e.stopPropagation(); toggleThinking(i); }}>
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
                  onclick={(e) => { e.stopPropagation(); toggleToolOutput(seg.toolId); }}
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
      {:else}
        <MessageContent html={renderedContent()} showCursor={isStreaming} />
      {/if}
    </div>

    {#if showTools && hasTools}
      <div class="tools-panel">
        {#each toolEvents as tool (tool.toolId)}
          <div class="tool-entry" class:error={tool.isError}>
            <button
              class="tool-header"
              onclick={(e) => { e.stopPropagation(); toggleToolOutput(tool.toolId); }}
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

    {#if !isDeleted && groupedReactions().length > 0 && message.role !== 'user'}
      <div class="reactions-row">
        {#if canReadAloud}
          <button
            class="read-aloud-btn"
            class:loading={ttsState === 'loading'}
            class:playing={ttsState === 'playing'}
            onclick={toggleReadAloud}
            disabled={ttsState === 'loading'}
            title={ttsState === 'playing' ? 'Stop' : ttsState === 'loading' ? 'Generating...' : 'Read aloud'}
          >
            {#if ttsState === 'loading'}
              <svg class="tts-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>
            {:else if ttsState === 'playing'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            {/if}
          </button>
        {/if}
        {#each groupedReactions() as rxn (rxn.emoji)}
          <button
            class="reaction-chip"
            class:mine={rxn.users.includes('user')}
            onclick={() => toggleReaction(rxn.emoji)}
            title={rxn.users.join(', ')}
          >
            <span class="reaction-emoji">{rxn.emoji}</span>
            {#if rxn.count > 1}
              <span class="reaction-count">{rxn.count}</span>
            {/if}
          </button>
        {/each}
        <div class="reaction-picker-wrapper">
          <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
          {#if pickerOpen}
            <div class="reaction-quick-pick" bind:this={pickerEl}>
              {#each QUICK_EMOJIS as emoji}
                <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {:else if !isDeleted && !isStreaming && message.role !== 'user'}
      <div class="reactions-row reactions-hover-only">
        {#if canReadAloud}
          <button
            class="read-aloud-btn"
            class:loading={ttsState === 'loading'}
            class:playing={ttsState === 'playing'}
            onclick={toggleReadAloud}
            disabled={ttsState === 'loading'}
            title={ttsState === 'playing' ? 'Stop' : ttsState === 'loading' ? 'Generating...' : 'Read aloud'}
          >
            {#if ttsState === 'loading'}
              <svg class="tts-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-dashoffset="12"/></svg>
            {:else if ttsState === 'playing'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            {/if}
          </button>
        {/if}
        <div class="reaction-picker-wrapper">
          <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
          {#if pickerOpen}
            <div class="reaction-quick-pick" bind:this={pickerEl}>
              {#each QUICK_EMOJIS as emoji}
                <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if message.role === 'user'}
      <div class="user-footer">
        <div class="user-footer-left">
          <div class="reaction-picker-wrapper">
            <button class="reaction-add" onclick={openReactionPicker} title="Add reaction">+</button>
            {#if pickerOpen}
              <div class="reaction-quick-pick" bind:this={pickerEl}>
                {#each QUICK_EMOJIS as emoji}
                  <button class="quick-emoji" onclick={() => pickEmoji(emoji)}>{emoji}</button>
                {/each}
              </div>
            {/if}
          </div>
          {#if groupedReactions().length > 0}
            {#each groupedReactions() as { emoji, count }}
              <button class="reaction-chip" onclick={() => toggleReaction(emoji)}>
                <span>{emoji}</span>
                {#if count > 1}<span class="reaction-count">{count}</span>{/if}
              </button>
            {/each}
          {/if}
        </div>
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

  /* Sticker-only messages: no bubble, just the image */
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
    font-size: 0.875rem;
    color: var(--text-muted);
    background: var(--bg-surface);
    padding: 0.5rem 1rem;
    border-radius: var(--radius-sm);
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

  /* Tools panel */
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

  /* Interleaved content */
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

  /* Thinking blocks — collapsible reasoning */
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

  @keyframes toolSpin {
    to { transform: rotate(360deg); }
  }

  /* Read aloud button — inline with reaction chips */
  .read-aloud-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    width: 26px;
    padding: 0;
    border-radius: var(--radius);
    color: var(--text-muted);
    transition: color var(--transition), background var(--transition);
  }

  .read-aloud-btn:hover:not(:disabled) {
    color: var(--accent);
    background: var(--bg-hover);
  }

  .read-aloud-btn.playing {
    color: var(--accent);
  }

  .read-aloud-btn:disabled {
    cursor: wait;
  }

  .tts-spinner {
    animation: toolSpin 0.8s linear infinite;
  }

  /* Reactions */
  .reactions-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }

  .reactions-hover-only {
    opacity: 0;
    transition: opacity 0.15s;
  }

  .message:hover .reactions-hover-only {
    opacity: 1;
  }

  .reaction-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.25rem 0.5rem;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    font-size: 0.875rem;
    transition: all 0.15s;
  }

  .reaction-chip:hover {
    background: var(--bg-hover);
    border-color: var(--border-hover);
  }

  .reaction-chip.mine {
    background: var(--bg-active);
    border-color: var(--accent);
  }

  .reaction-emoji {
    font-size: 0.9375rem;
    line-height: 1;
  }

  .reaction-count {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .reaction-add {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 50%;
    color: var(--text-muted);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1;
  }

  .reaction-add:hover {
    border-color: var(--border-hover);
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .reaction-picker-wrapper {
    position: relative;
    display: inline-flex;
  }

  .reaction-quick-pick {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 2px;
    padding: 4px 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 0.875rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    z-index: 10;
    white-space: nowrap;
  }

  .quick-emoji {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    transition: background 0.12s;
  }

  .quick-emoji:hover {
    background: var(--bg-hover);
  }

  /* Hide header for user messages — time + checks shown inline instead */
  .user-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .user-footer-left {
    display: flex;
    align-items: center;
    gap: 0.25rem;
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
    .message.user {
      max-width: 85%;
    }

    .message {
      overflow: hidden;
    }

    .message-content {
      overflow: hidden;
    }

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
