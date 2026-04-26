<script lang="ts">
  import PresenceIndicator from '$lib/components/PresenceIndicator.svelte';
  import ContextIndicator from '$lib/components/ContextIndicator.svelte';
  import ModelSelector from '$lib/components/ModelSelector.svelte';
  import type { PresenceStatus } from '@resonant/shared';

  let {
    companionName,
    presence,
    sidebarCollapsed,
    isStreamingNow,
    contextUsage,
    totalUnread,
    canvasPanelOpen,
    activeCanvasId,
    commandCenterEnabled,
    filePanelOpen = false,
    ontogglesidebar,
    ontogglesidebarcollapsed,
    ontogglesearch,
    onstopgeneration,
    ontogglecanvas,
    ontogglefiles,
    ontoggletheme,
  } = $props<{
    companionName: string;
    presence: PresenceStatus;
    sidebarCollapsed: boolean;
    isStreamingNow: boolean;
    contextUsage: { percentage: number; tokensUsed: number; contextWindow: number } | null;
    totalUnread: number;
    canvasPanelOpen: boolean;
    activeCanvasId: string | null;
    commandCenterEnabled: boolean;
    filePanelOpen?: boolean;
    ontogglesidebar?: () => void;
    ontogglesidebarcollapsed?: () => void;
    ontogglesearch?: () => void;
    onstopgeneration?: () => void;
    ontogglecanvas?: () => void;
    ontogglefiles?: () => void;
    ontoggletheme?: () => void;
  }>();

  const canvasActive = $derived(canvasPanelOpen || !!activeCanvasId);
</script>

<header class="chat-header">
  <button class="menu-button" onclick={ontogglesidebar} aria-label="Toggle sidebar">
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M3 12h18M3 6h18M3 18h18"/>
    </svg>
  </button>
  <button
    class="sidebar-toggle"
    onclick={ontogglesidebarcollapsed}
    aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
    title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
  >
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      {#if sidebarCollapsed}
        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
      {:else}
        <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><path d="M15 9l-3 3 3 3"/>
      {/if}
    </svg>
  </button>

  <div class="header-info">
    <h1 class="header-title">{companionName}</h1>
    <PresenceIndicator status={presence} />
    <ModelSelector />
  </div>

  <div class="header-actions">
    {#if commandCenterEnabled}
      <a href="/cc" class="header-icon-btn" aria-label="Command Center" title="Command Center">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4"/>
        </svg>
      </a>
    {/if}
    <button class="header-icon-btn" onclick={ontogglesearch} aria-label="Search messages (Ctrl+K)" title="Search (Ctrl+K)">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
      </svg>
    </button>
    {#if isStreamingNow}
      <button class="header-icon-btn stop-btn" onclick={onstopgeneration} aria-label="Stop generation (Escape)" title="Stop (Esc)">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <rect x="4" y="4" width="16" height="16" rx="2"/>
        </svg>
      </button>
    {/if}
    {#if contextUsage}
      <ContextIndicator
        percentage={contextUsage.percentage}
        tokensUsed={contextUsage.tokensUsed}
        contextWindow={contextUsage.contextWindow}
      />
    {/if}
    {#if totalUnread > 0}
      <div class="unread-badge">{totalUnread}</div>
    {/if}
    <button
      class="header-icon-btn"
      class:active={canvasActive}
      onclick={ontogglecanvas}
      aria-label="Canvas"
      title="Canvas"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="4" width="18" height="16" rx="2"/>
        <path d="M9 4v16"/>
        <path d="M9 10h12"/>
      </svg>
    </button>
    <a href="/files" class="header-icon-link" aria-label="Library" title="Library">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m16 6 4 14"/>
        <path d="M12 6v14"/>
        <path d="M8 8v12"/>
        <path d="M4 4v16"/>
      </svg>
    </a>
    <button
      class="header-icon-btn"
      class:active={filePanelOpen}
      onclick={ontogglefiles}
      aria-label="Files in this thread"
      title="Files in this thread"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
      </svg>
    </button>
    <button class="header-icon-btn" onclick={ontoggletheme} aria-label="Toggle light/dark mode" title="Toggle theme">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
      </svg>
    </button>
    <a href="/settings" class="settings-link" aria-label="Settings">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
      </svg>
    </a>
  </div>
</header>

<style>
  .chat-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1.25rem 1rem;
    background: var(--bg-secondary);
    border-bottom: none;
    box-shadow: 0 1px 0 0 var(--border);
    flex-shrink: 0;
  }

  .menu-button {
    display: none;
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .menu-button:hover {
    color: var(--gold-dim);
  }

  .sidebar-toggle {
    display: none;
    padding: 0.375rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .sidebar-toggle:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
  }

  .header-title {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--gold);
    letter-spacing: 0.06em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .unread-badge {
    background: var(--gold-dim);
    color: var(--bg-primary);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
  }

  .header-icon-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .header-icon-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .settings-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .settings-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .header-icon-btn {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: color var(--transition);
  }

  .header-icon-btn:hover {
    color: var(--gold-dim);
  }

  .header-icon-btn.active {
    color: var(--gold);
  }

  .stop-btn {
    color: var(--status-error, #ef4444) !important;
    animation: stopPulse 1.5s ease-in-out infinite;
  }

  .stop-btn:hover {
    color: #ff6b6b !important;
  }

  @keyframes stopPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  @media (min-width: 769px) {
    .sidebar-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  @media (max-width: 768px) {
    .menu-button {
      display: block;
    }

    .chat-header {
      padding: calc(env(safe-area-inset-top, 0px) + 0.75rem) 0.75rem 0.75rem;
      gap: 0.5rem;
    }

    .header-info {
      gap: 0.375rem;
      min-width: 0;
    }

    .header-title {
      font-size: 1.0625rem;
    }

    .header-actions {
      gap: 0.25rem;
      flex-shrink: 0;
    }
  }
</style>
