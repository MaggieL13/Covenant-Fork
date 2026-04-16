<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import MessageBubble from '$lib/components/MessageBubble.svelte';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
  import AudioAutoPlayer from '$lib/components/AudioAutoPlayer.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { loadStickers } from '$lib/stores/stickers.svelte';
  import NewThreadModal from '$lib/components/chat/NewThreadModal.svelte';
  import SearchOverlay from '$lib/components/chat/SearchOverlay.svelte';
  import CanvasDrawer from '$lib/components/chat/CanvasDrawer.svelte';
  import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
  import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
  import { createAutoScrollController } from '$lib/chat/auto-scroll.svelte';
  import { createOlderMessagesController } from '$lib/chat/older-messages.svelte';
  import { createReadObserverController } from '$lib/chat/read-observer.svelte';
  import { createKeyboardShortcutsController } from '$lib/chat/keyboard-shortcuts.svelte';
  import {
    connect,
    disconnect,
    send,
    loadThread,
    loadThreads,
    loadOlderMessages,
    getConnectionState,
    getMessages,
    getThreads,
    getActiveThreadId,
    getPresence,
    getUnreadCounts,
    getStreamingState,
    getLastError,
    getPendingCount,
    getToolEvents,
    getContextUsage,
    getCompactionNotice,
    getActiveCanvasId,
    getCanvases,
    getStreamingSegments,
    sendStopGeneration,
    isStreaming,
    getRateLimitInfo,
    getLastCommandResult,
    clearCommandResult,
  } from '$lib/stores/websocket.svelte';
  import { loadSettings, getCompanionName, isCommandCenterEnabled } from '$lib/stores/settings.svelte';
  import { apiFetch } from '$lib/utils/api';
  import type { Message } from '@resonant/shared';

  // Reactive state from stores
  let connectionState = $derived(getConnectionState());
  let messages = $derived(getMessages());
  let threads = $derived(getThreads());
  let activeThreadId = $derived(getActiveThreadId());
  let presence = $derived(getPresence());
  let unreadCounts = $derived(getUnreadCounts());
  let streaming = $derived(getStreamingState());
  let lastError = $derived(getLastError());
  let pendingCount = $derived(getPendingCount());
  let toolEventsMap = $derived(getToolEvents());
  let contextUsage = $derived(getContextUsage());
  let compactionNotice = $derived(getCompactionNotice());
  let activeCanvasId = $derived(getActiveCanvasId());
  let canvases = $derived(getCanvases());
  let activeCanvas = $derived(canvases.find((canvas) => canvas.id === activeCanvasId) ?? null);
  let streamingSegments = $derived(getStreamingSegments());
  let isStreamingNow = $derived(isStreaming());
  let rateLimitInfo = $derived(getRateLimitInfo());
  let companionName = $derived(getCompanionName());
  let commandResult = $derived(getLastCommandResult());

  // Search state
  let searchOpen = $state(false);

  // Component refs
  let messageInput: MessageInput | undefined = $state();

  // Workspace drawers
  let canvasPanelOpen = $state(false);

  // New thread modal
  let newThreadOpen = $state(false);
  let newThreadName = $state('');
  let creatingThread = $state(false);
  let createError = $state('');

  function toggleSearch() {
    searchOpen = !searchOpen;
  }

  function openSettings() {
    goto('/settings');
  }

  function toggleCanvasPanel() {
    canvasPanelOpen = !canvasPanelOpen;
  }

  function closeCanvasPanel() {
    canvasPanelOpen = false;
  }

  // Theme toggle
  function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('resonant-theme', next);
  }

  function openNewThreadModal() {
    newThreadName = '';
    newThreadOpen = true;
  }

  function closeNewThreadModal() {
    if (creatingThread) return;
    newThreadOpen = false;
    newThreadName = '';
  }

  async function submitNewThread() {
    if (creatingThread) return;
    creatingThread = true;
    try {
      const response = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newThreadName.trim() || undefined }),
      });

      if (!response.ok) throw new Error('Failed to create thread');

      const data = await response.json();
      newThreadOpen = false;
      newThreadName = '';
      // Load thread list first, then select — even if WS is temporarily down,
      // the HTTP-based thread load and selection will still work
      await loadThreads();
      await handleThreadSelect(data.thread.id);
    } catch (err) {
      console.error('Failed to create thread:', err);
      newThreadOpen = false;
      createError = 'Failed to create thread. Please try again.';
      setTimeout(() => createError = '', 5000);
    } finally {
      creatingThread = false;
    }
  }

  async function handleSearchResult(result: { messageId: string; threadId: string }) {
    searchOpen = false;
    // Switch to thread if different
    if (result.threadId !== activeThreadId) {
      await handleThreadSelect(result.threadId);
    }
    // Scroll to message after a tick
    await new Promise(r => setTimeout(r, 100));
    const el = document.getElementById(`msg-${result.messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 2000);
    }
  }

  // Local state
  let replyTo = $state<Message | null>(null);
  let messagesContainer = $state<HTMLDivElement | null>(null);
  let messagesEndEl = $state<HTMLDivElement | null>(null);
  let sidebarOpen = $state(false); // mobile overlay
  let sidebarCollapsed = $state(false); // desktop collapse

  // Total unread count
  const totalUnread = $derived(
    Object.values(unreadCounts).reduce((sum, count) => sum + count, 0)
  );

  const getMessagesContainer = () => messagesContainer;
  const getMessagesEndEl = () => messagesEndEl;

  const olderMessages = createOlderMessagesController({
    getContainer: getMessagesContainer,
    getActiveThreadId: () => activeThreadId,
    loadOlderMessagesForThread: loadOlderMessages,
  });

  const autoScroll = createAutoScrollController({
    getContainer: getMessagesContainer,
    getActiveThreadId: () => activeThreadId,
    getMessagesLength: () => messages.length,
    // ORDER: auto-scroll reads the older-message flags through getters so the
    // shared scroll handler always sees live pagination state across controller
    // boundaries instead of stale values captured at construction time.
    getLoadingOlder: () => olderMessages.loadingOlder,
    getHasMoreMessages: () => olderMessages.hasMoreMessages,
    onReachTop: () => olderMessages.loadMoreMessages(),
  });

  const readObserver = createReadObserverController({
    getSentinel: getMessagesEndEl,
    getActiveThreadId: () => activeThreadId,
    getMessages: () => messages,
    sendRead: (threadId, beforeId) => {
      send({ type: 'read', threadId, beforeId });
    },
  });

  const keyboardShortcuts = createKeyboardShortcutsController({
    toggleSearch,
    isCanvasOpen: () => canvasPanelOpen,
    closeCanvas: closeCanvasPanel,
    isSidebarOpen: () => sidebarOpen,
    closeSidebar: () => {
      sidebarOpen = false;
    },
    isNewThreadOpen: () => newThreadOpen,
    closeNewThread: closeNewThreadModal,
    isStreaming: () => isStreamingNow,
    stopGeneration: sendStopGeneration,
  });

  let shouldAutoScroll = $derived(autoScroll.shouldAutoScroll);
  let loadingOlder = $derived(olderMessages.loadingOlder);
  let hasMoreMessages = $derived(olderMessages.hasMoreMessages);

  // Handle thread selection
  async function handleThreadSelect(threadId: string) {
    // ORDER: reset pagination state before loading a different thread so the
    // next scroll interaction starts from the new thread, not stale prior state.
    olderMessages.reset();
    await loadThread(threadId);
    sidebarOpen = false;
    // ORDER: re-enable auto-scroll after thread selection so the next render
    // snaps to the newly loaded thread instead of preserving the old thread's pause state.
    autoScroll.enableAutoScroll();
  }

  // Handle new thread creation
  async function handleNewThread() {
    openNewThreadModal();
  }

  // Handle batched send — text and/or files all go as one message → one agent query
  async function handleBatchSend(
    content: string,
    files: Array<{ fileId: string; filename: string; mimeType: string; size: number; contentType: 'image' | 'audio' | 'file'; url: string }>,
    prosody?: Record<string, number>
  ) {
    let threadId: string | null = activeThreadId;
    if (!threadId) {
      // Auto-create a thread instead of silently dropping the message
      try {
        const res = await apiFetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '' }),
        });
        if (res.ok) {
          const data = await res.json();
          await loadThreads();
          await handleThreadSelect(data.thread.id);
          threadId = data.thread.id;
        } else {
          showToast('Failed to create thread', 'error');
          return;
        }
      } catch {
        showToast('Failed to create thread', 'error');
        return;
      }
    }

    // After the guard above, threadId is guaranteed non-null (all null paths return early)
    const resolvedThreadId = threadId!;

    if (files.length === 0) {
      // Text only
      send({
        type: 'message',
        threadId: resolvedThreadId,
        content,
        contentType: 'text',
        replyToId: replyTo?.id,
        ...(prosody && { metadata: { prosody } }),
      });
    } else {
      // Files (+ optional text) — single message, backend stores files individually
      // and fires one combined agent query
      send({
        type: 'message',
        threadId: resolvedThreadId,
        content: content || '',
        contentType: 'text',
        replyToId: replyTo?.id,
        metadata: {
          attachments: files.map(f => ({
            fileId: f.fileId,
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
            url: f.url,
            contentType: f.contentType,
          })),
          ...(prosody && { prosody }),
        },
      });
    }

    replyTo = null;
    autoScroll.enableAutoScroll();
  }

  // Handle reply
  function handleReply(message: Message) {
    replyTo = message;
  }

  // Cancel reply
  function handleCancelReply() {
    replyTo = null;
  }

  // Send a suggested prompt — auto-create thread if none selected
  async function sendSuggested(text: string) {
    let threadId = activeThreadId;
    if (!threadId) {
      try {
        const res = await apiFetch('/api/threads', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '' }),
        });
        if (res.ok) {
          const data = await res.json();
          await loadThreads();
          await handleThreadSelect(data.thread.id);
          threadId = data.thread.id;
        } else {
          showToast('Failed to create thread', 'error');
          return;
        }
      } catch {
        showToast('Failed to create thread', 'error');
        return;
      }
    }
    send({
      type: 'message',
      threadId: threadId!,
      content: text,
      contentType: 'text',
    });
    autoScroll.enableAutoScroll();
  }

  // Toggle sidebar on mobile
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  // Load initial data and connect
  onMount(async () => {
    await Promise.all([loadThreads(), loadSettings(), loadStickers()]);
    connect();
    window.addEventListener('keydown', keyboardShortcuts.handleGlobalKeydown);

    // Load today's thread if available
    const todayThread = threads.find(t =>
      t.name.startsWith('Daily -') && t.name.includes(new Date().toISOString().split('T')[0])
    );

    if (todayThread) {
      await handleThreadSelect(todayThread.id);
    } else if (threads.length > 0) {
      await handleThreadSelect(threads[0].id);
    }
  });

  // Disconnect on unmount
  onDestroy(() => {
    disconnect();
    window.removeEventListener('keydown', keyboardShortcuts.handleGlobalKeydown);
  });

  // Auto-scroll effect
  $effect(() => {
    messages; // Track changes
    streaming; // Track streaming changes
    // ORDER: defer scroll-to-bottom until after DOM updates from message and
    // streaming changes have painted, so the controller measures the real layout.
    const timeout = setTimeout(() => autoScroll.scrollToBottom(), 50);
    return () => clearTimeout(timeout);
  });

  $effect(() => {
    messagesEndEl;
    // ORDER: the bottom sentinel must exist before attaching the read observer.
    readObserver.setup();
    return () => readObserver.cleanup();
  });

  $effect(() => {
    // ORDER: auto-open the canvas drawer after activeCanvasId updates so the
    // header active state and drawer visibility stay in sync.
    if (activeCanvasId) {
      canvasPanelOpen = true;
    }
  });
</script>

<div class="chat-page">
  {#if createError}
    <div class="toast-error" role="alert">{createError}</div>
  {/if}
  <ChatSidebar
    open={sidebarOpen}
    collapsed={sidebarCollapsed}
    {threads}
    {activeThreadId}
    ontogglesidebar={toggleSidebar}
    onselect={handleThreadSelect}
    oncreate={handleNewThread}
    ondelete={(id) => { threads = threads.filter(t => t.id !== id); }}
    {loadThreads}
  />

  <!-- Main chat area -->
  <div class="main-content">
    <ChatHeader
      {companionName}
      {presence}
      {sidebarCollapsed}
      {isStreamingNow}
      {contextUsage}
      {totalUnread}
      {canvasPanelOpen}
      {activeCanvasId}
      commandCenterEnabled={isCommandCenterEnabled()}
      ontogglesidebar={toggleSidebar}
      ontogglesidebarcollapsed={() => sidebarCollapsed = !sidebarCollapsed}
      ontogglesearch={toggleSearch}
      onstopgeneration={sendStopGeneration}
      ontogglecanvas={toggleCanvasPanel}
      ontoggletheme={toggleTheme}
    />

    <!-- Connection status -->
    <ConnectionStatus state={connectionState} error={lastError} pendingCount={pendingCount} />

    <!-- Compaction notice banner -->
    {#if compactionNotice}
      <div class="compaction-banner" class:compacting={!compactionNotice.isComplete}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v10l4 4"/>
          <circle cx="12" cy="12" r="10"/>
        </svg>
        <span>{compactionNotice.message}</span>
      </div>
    {/if}

    <!-- Rate limit banner -->
    {#if rateLimitInfo}
      <div class="rate-limit-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Rate limited ({rateLimitInfo.status}) — waiting for reset...</span>
      </div>
    {/if}

    <!-- Command result toast -->
    {#if commandResult}
      <div class="command-toast" class:error={!commandResult.success}>
        <span class="command-toast-name">/{commandResult.name}</span>
        <span class="command-toast-msg">{commandResult.error || commandResult.display || 'Command complete'}</span>
        <button class="command-toast-close" onclick={clearCommandResult} aria-label="Dismiss command message">Dismiss</button>
      </div>
    {/if}

    <!-- Messages area -->
    <div
      class="messages-container"
      bind:this={messagesContainer}
      onscroll={autoScroll.checkAutoScroll}
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
              <button class="prompt-chip" onclick={() => sendSuggested('How are you today?')}>
                How are you today?
              </button>
              <button class="prompt-chip" onclick={() => sendSuggested('Tell me something interesting')}>
                Tell me something interesting
              </button>
              <button class="prompt-chip" onclick={() => sendSuggested('What can you help me with?')}>
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
              oncontextmenu={(e) => { e.preventDefault(); handleReply(message); }}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleReply(message);
                }
              }}
            >
              <MessageBubble message={message} toolEvents={toolEventsMap[message.id] || []} segments={message.metadata?.segments as any || null} {companionName} />
            </div>
          {/each}

          {#if streaming.messageId}
            {@const liveTools = toolEventsMap[streaming.messageId] || []}
            <div class="message-wrapper">
              {#if streaming.tokens}
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    thread_id: activeThreadId ?? '',
                    sequence: 0,
                    role: 'companion',
                    content: streaming.tokens,
                    content_type: 'text',
                    platform: 'web',
                    metadata: null,
                    reply_to_id: null,
                    reply_to_preview: null,
                    edited_at: null,
                    deleted_at: null,
                    original_content: null,
                    created_at: new Date().toISOString(),
                    delivered_at: null,
                    read_at: null,
                  }}
                  isStreaming={true}
                  streamTokens={streaming.tokens}
                  toolEvents={liveTools}
                  segments={streamingSegments}
                  {companionName}
                />
              {:else}
                <!-- Live activity panel while companion is working -->
                <div class="activity-panel" aria-label="Companion is working">
                  <div class="activity-header">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="activity-label">{companionName} is thinking...</span>
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

        <!-- Sentinel for read receipt IntersectionObserver -->
        <div bind:this={messagesEndEl} class="messages-end-sentinel"></div>
      </div>
    </div>

    <!-- Scroll to bottom button -->
    {#if !shouldAutoScroll}
      <div class="scroll-to-bottom-wrapper">
        <button class="scroll-to-bottom" onclick={autoScroll.jumpToBottom} aria-label="Scroll to bottom">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 13l5 5 5-5M7 6l5 5 5-5"/>
          </svg>
        </button>
      </div>
    {/if}

    <!-- Input area -->
    <MessageInput
      bind:this={messageInput}
      replyTo={replyTo}
      isStreaming={isStreamingNow}
      activeThreadId={activeThreadId}
      onbatchsend={handleBatchSend}
      oncancelreply={handleCancelReply}
      onstop={sendStopGeneration}
    />

    <!-- Invisible TTS playback manager -->
    <AudioAutoPlayer />
  </div>

  <CanvasDrawer
    open={canvasPanelOpen}
    showActiveCanvas={!!activeCanvasId}
    onclose={closeCanvasPanel}
    onreference={(canvasId, title) => {
      messageInput?.attachCanvasRef(canvasId, title);
    }}
  />

  <SearchOverlay
    open={searchOpen}
    onresult={handleSearchResult}
    onclose={() => searchOpen = false}
  />

  <NewThreadModal
    open={newThreadOpen}
    name={newThreadName}
    creating={creatingThread}
    onclose={closeNewThreadModal}
    onsubmit={submitNewThread}
    onnamechange={(value) => newThreadName = value}
  />
</div>

<style>
  .chat-page {
    display: flex;
    height: 100dvh;
    overflow: hidden;
    max-width: 100vw;
  }

  .main-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
    overflow-x: hidden;
  }

  .compaction-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: rgba(155, 114, 207, 0.08);
    border-bottom: 1px solid rgba(155, 114, 207, 0.2);
    color: var(--gold-dim);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .compaction-banner.compacting {
    animation: bannerFadeIn 0.3s ease-out, compactingPulse 2s ease-in-out infinite;
  }

  @keyframes bannerFadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes compactingPulse {
    0%, 100% { background: rgba(155, 114, 207, 0.08); }
    50% { background: rgba(155, 114, 207, 0.16); }
  }

  .rate-limit-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: rgba(245, 158, 11, 0.08);
    border-bottom: 1px solid rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .command-toast {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: var(--gold-glow, rgba(155, 114, 207, 0.1));
    border-bottom: 1px solid rgba(155, 114, 207, 0.2);
    color: var(--gold);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .command-toast.error {
    background: rgba(239, 68, 68, 0.08);
    border-bottom-color: rgba(239, 68, 68, 0.2);
    color: var(--error, #ef4444);
  }

  .command-toast-name {
    font-family: var(--font-mono);
    font-weight: 500;
    flex-shrink: 0;
  }

  .command-toast-msg {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-toast-close {
    padding: 0.125rem 0.375rem;
    color: inherit;
    opacity: 0.6;
    font-size: 0.75rem;
    flex-shrink: 0;
  }

  .command-toast-close:hover {
    opacity: 1;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-primary);
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

  /* Mobile styles */
  @media (max-width: 768px) {
    .messages-list {
      padding: 0.75rem;
      max-width: 100%;
    }

  }

  .toast-error {
    position: fixed;
    top: 1rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--error, #dc2626);
    color: #fff;
    padding: 0.75rem 1.5rem;
    border-radius: 8px;
    font-size: 0.875rem;
    z-index: 9999;
    animation: toast-in 0.2s ease-out;
  }

  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-0.5rem); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
