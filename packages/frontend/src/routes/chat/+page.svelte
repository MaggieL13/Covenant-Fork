<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
  import AudioAutoPlayer from '$lib/components/AudioAutoPlayer.svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import { loadStickers } from '$lib/stores/stickers.svelte';
  import NewThreadModal from '$lib/components/chat/NewThreadModal.svelte';
  import SearchOverlay from '$lib/components/chat/SearchOverlay.svelte';
  import CanvasDrawer from '$lib/components/chat/CanvasDrawer.svelte';
  import FilePanel from '$lib/components/chat/FilePanel.svelte';
  import ChatHeader from '$lib/components/chat/ChatHeader.svelte';
  import ChatSidebar from '$lib/components/chat/ChatSidebar.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
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
    getStreamingSegments,
    sendStopGeneration,
    isStreaming,
    isAgentBusy,
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
  // True only while compaction is in flight — flips false on completion so
  // the activity panel goes back to "{companionName} is thinking..." once
  // the SDK is done preserving context.
  let isCompacting = $derived(!!compactionNotice && !compactionNotice.isComplete);
  let activeCanvasId = $derived(getActiveCanvasId());
  let streamingSegments = $derived(getStreamingSegments());
  let isStreamingNow = $derived(isStreaming());
  // True when the agent is replying on ANOTHER thread and this thread's
  // last message is the user's — i.e. we're queued behind the in-flight
  // work and should show a thinking indicator instead of looking frozen.
  let isWaitingForReply = $derived.by(() => {
    if (!isAgentBusy()) return false;
    if (isStreamingNow) return false; // stream is for this thread → real dots handle it
    const last = messages[messages.length - 1];
    return !!last && last.role === 'user';
  });
  let rateLimitInfo = $derived(getRateLimitInfo());
  let companionName = $derived(getCompanionName());
  let commandResult = $derived(getLastCommandResult());

  // Search state
  let searchOpen = $state(false);

  // Component refs
  let messageInput: MessageInput | undefined = $state();

  // Workspace drawers
  let canvasPanelOpen = $state(false);
  let filePanelOpen = $state(false);

  // New thread modal
  let newThreadOpen = $state(false);
  let newThreadName = $state('');
  let creatingThread = $state(false);
  let createError = $state('');

  function toggleSearch() {
    searchOpen = !searchOpen;
  }

  function toggleCanvasPanel() {
    canvasPanelOpen = !canvasPanelOpen;
  }

  function closeCanvasPanel() {
    canvasPanelOpen = false;
  }

  function toggleFilePanel() {
    filePanelOpen = !filePanelOpen;
  }

  function closeFilePanel() {
    filePanelOpen = false;
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
  let sidebarOpen = $state(false); // mobile overlay
  let sidebarCollapsed = $state(false); // desktop collapse

  // Total unread count
  const totalUnread = $derived(
    Object.values(unreadCounts).reduce((sum, count) => sum + count, 0)
  );

  let getMessagesContainer = $state<() => HTMLDivElement | null>(() => null);
  let getMessagesEndEl = $state<() => HTMLDivElement | null>(() => null);

  const olderMessages = createOlderMessagesController({
    getContainer: () => getMessagesContainer(),
    getActiveThreadId: () => activeThreadId,
    loadOlderMessagesForThread: loadOlderMessages,
  });

  const autoScroll = createAutoScrollController({
    getContainer: () => getMessagesContainer(),
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
    getSentinel: () => getMessagesEndEl(),
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
    // ORDER: hydrate the initial HTTP-backed chat state before connecting so
    // first render and initial thread selection do not race the live WS sync.
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
    getMessagesEndEl;
    // ORDER: the registered sentinel getter must be in place before attaching
    // the read observer, because the page no longer owns the sentinel DOM ref.
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
    oncreate={openNewThreadModal}
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
      {filePanelOpen}
      commandCenterEnabled={isCommandCenterEnabled()}
      ontogglesidebar={toggleSidebar}
      ontogglesidebarcollapsed={() => sidebarCollapsed = !sidebarCollapsed}
      ontogglesearch={toggleSearch}
      onstopgeneration={sendStopGeneration}
      ontogglecanvas={toggleCanvasPanel}
      ontogglefiles={toggleFilePanel}
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

    <MessageList
      {messages}
      {companionName}
      {toolEventsMap}
      {streaming}
      {streamingSegments}
      {isWaitingForReply}
      {isCompacting}
      {activeThreadId}
      {loadingOlder}
      {hasMoreMessages}
      {shouldAutoScroll}
      onreply={(message) => {
        replyTo = message;
      }}
      onsuggestedprompt={sendSuggested}
      onscroll={autoScroll.checkAutoScroll}
      onjumptobottom={autoScroll.jumpToBottom}
      onregisterrefs={({ getContainer, getSentinel }) => {
        // ORDER: update the getter-state only after MessageList has registered
        // its bound refs, so the page-owned controllers immediately read the live DOM.
        getMessagesContainer = getContainer;
        getMessagesEndEl = getSentinel;
      }}
    />

    <!-- Input area -->
    <MessageInput
      bind:this={messageInput}
      replyTo={replyTo}
      isStreaming={isStreamingNow}
      activeThreadId={activeThreadId}
      onbatchsend={handleBatchSend}
      oncancelreply={() => {
        replyTo = null;
      }}
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

  <FilePanel
    open={filePanelOpen}
    {messages}
    onclose={closeFilePanel}
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

  /* Completed state — restrained, settles in for ~8s then auto-clears
     (timeout in websocket.svelte.ts). The activity panel inside the
     message list owns the "in-progress" signal now; this banner is
     secondary / global status. */
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

  /* In-progress state — louder so the user notices when the SDK is
     compacting context. Brighter background, bolder text, more contrast.
     Pulse animation is preserved but with wider amplitude than before. */
  .compaction-banner.compacting {
    padding: 0.625rem 1rem;
    background: rgba(155, 114, 207, 0.18);
    border-bottom: 1px solid rgba(155, 114, 207, 0.4);
    color: var(--gold);
    font-weight: 500;
    animation: bannerFadeIn 0.3s ease-out, compactingPulse 1.6s ease-in-out infinite;
  }

  @keyframes bannerFadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes compactingPulse {
    0%, 100% { background: rgba(155, 114, 207, 0.18); }
    50% { background: rgba(155, 114, 207, 0.32); }
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
