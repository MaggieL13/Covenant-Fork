<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    refreshCodexStatus,
    startCodexLogin,
    submitCodexManualCode,
    logoutCodex,
    cancelCodexLogin,
    getCodexAuthSnapshot,
    isCodexAuthLoading,
    getCodexAuthError,
  } from '$lib/stores/codex-auth.svelte';

  let snapshot = $derived(getCodexAuthSnapshot());
  let loading = $derived(isCodexAuthLoading());
  let storeError = $derived(getCodexAuthError());

  let manualCode = $state('');
  let manualCodeBusy = $state(false);
  let confirmingLogout = $state(false);

  // Local error stays visible for the user after a manual-code paste fails,
  // independent of the polling status updates.
  let localError = $state<string | null>(null);

  let loginStatus = $derived(snapshot?.loginSession.status ?? 'idle');
  let loginUrl = $derived(snapshot?.loginSession.url);
  let loginError = $derived(snapshot?.loginSession.error);
  let loggedIn = $derived(!!snapshot?.loggedIn);
  let expiresAt = $derived(snapshot?.expiresAt ?? null);

  // Status pill color: green (logged in + healthy), yellow (in-flight or
  // expired-but-refreshable), red (failed / not logged in and no flow).
  let pillTone = $derived(
    loggedIn ? 'green'
      : loginStatus === 'awaiting_browser' ? 'yellow'
      : loginStatus === 'failed' ? 'red'
      : 'neutral',
  );

  let pillLabel = $derived(
    loggedIn ? 'Logged in'
      : loginStatus === 'awaiting_browser' ? 'Login in progress'
      : loginStatus === 'failed' ? 'Login failed'
      : loginStatus === 'cancelled' ? 'Login cancelled'
      : 'Not logged in',
  );

  // Human-friendly expiry display. Falls back to ISO if relative formatting
  // hits an edge case.
  let expiresLabel = $derived.by(() => {
    if (!expiresAt) return null;
    const diffMs = expiresAt - Date.now();
    if (diffMs <= 0) return 'expired (refresh on next use)';
    const days = Math.floor(diffMs / (24 * 3600_000));
    if (days >= 2) return `in ${days} days`;
    const hours = Math.floor(diffMs / 3600_000);
    if (hours >= 2) return `in ${hours} hours`;
    const minutes = Math.max(1, Math.floor(diffMs / 60_000));
    return `in ${minutes} min`;
  });

  onMount(async () => {
    await refreshCodexStatus();
  });

  onDestroy(() => {
    // Polling lives in the store and survives unmount — but if the user
    // navigates away mid-flight, we deliberately leave it running so the
    // status updates when they come back. Background poll is cheap.
  });

  async function handleLoginClick() {
    localError = null;
    const result = await startCodexLogin();
    if (result.url) {
      // Open in a new tab so the user doesn't lose the Covenant UI.
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } else {
      localError = 'OAuth flow failed to produce a URL. See errors below.';
    }
  }

  async function handleManualCodeSubmit() {
    if (!manualCode.trim()) return;
    manualCodeBusy = true;
    localError = null;
    const ok = await submitCodexManualCode(manualCode.trim());
    manualCodeBusy = false;
    if (ok) {
      manualCode = '';
    } else {
      localError = storeError ?? 'Manual code submission failed.';
    }
  }

  async function handleLogoutConfirm() {
    confirmingLogout = false;
    await logoutCodex();
  }

  async function handleCancel() {
    await cancelCodexLogin();
  }

  async function handleReopenUrl() {
    if (loginUrl) {
      window.open(loginUrl, '_blank', 'noopener,noreferrer');
    }
  }
</script>

<section class="card" class:green={pillTone === 'green'} class:yellow={pillTone === 'yellow'} class:red={pillTone === 'red'}>
  <h3 class="section-title">Codex (ChatGPT) OAuth</h3>
  <p class="hint">
    Sign in with ChatGPT to enable Codex preview models (GPT-5, o3) in the model dropdowns.
    Auth credentials are stored locally next to the database; one Codex account at a time.
  </p>

  <div class="status-row" class:green={pillTone === 'green'} class:yellow={pillTone === 'yellow'} class:red={pillTone === 'red'}>
    <span class="status-dot"></span>
    <strong>{pillLabel}</strong>
    {#if loggedIn && expiresLabel}
      <span class="dim">— token expires {expiresLabel}</span>
    {/if}
  </div>

  {#if loggedIn}
    <div class="actions">
      <button class="btn" onclick={() => refreshCodexStatus()} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh status'}
      </button>
      <button class="btn danger" onclick={() => (confirmingLogout = true)} disabled={loading}>
        Log out
      </button>
    </div>
    <p class="hint dim">
      Selecting a Codex preview model still hits a friendly "runtime not wired up" error —
      streaming arrives in PR E2.
    </p>
  {:else if loginStatus === 'awaiting_browser'}
    <p class="warning yellow">
      Waiting for OAuth completion. Complete sign-in in the browser tab that opened
      (or paste the authorization code below if the redirect didn't work).
    </p>
    {#if loginUrl}
      <p class="dim small">
        Browser didn't open?
        <button class="link" type="button" onclick={handleReopenUrl}>Reopen login URL</button>
      </p>
    {/if}

    <div class="manual-code">
      <label for="codex-manual-code" class="dim small">Manual code (fallback):</label>
      <div class="row">
        <input
          id="codex-manual-code"
          type="text"
          bind:value={manualCode}
          placeholder="Paste code from the OAuth redirect URL"
          autocomplete="off"
          spellcheck="false"
          disabled={manualCodeBusy}
        />
        <button
          class="btn"
          onclick={handleManualCodeSubmit}
          disabled={!manualCode.trim() || manualCodeBusy}
        >
          {manualCodeBusy ? 'Submitting…' : 'Submit code'}
        </button>
      </div>
    </div>

    <div class="actions">
      <button class="btn" onclick={handleCancel}>Cancel login</button>
    </div>
  {:else}
    <div class="actions">
      <button class="btn primary" onclick={handleLoginClick} disabled={loading}>
        {loading ? 'Starting…' : 'Login to Codex'}
      </button>
      <button class="btn" onclick={() => refreshCodexStatus()} disabled={loading}>
        Refresh status
      </button>
    </div>
    {#if loginStatus === 'failed' && loginError}
      <p class="warning red">Last login failed: {loginError}</p>
    {/if}
    {#if loginStatus === 'cancelled'}
      <p class="dim small">Previous login was cancelled.</p>
    {/if}
  {/if}

  {#if localError}
    <p class="warning red">{localError}</p>
  {/if}
  {#if storeError}
    <p class="warning red">{storeError}</p>
  {/if}
</section>

{#if confirmingLogout}
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
      <h4>Log out of Codex?</h4>
      <p>
        This deletes the stored OAuth credentials. You'll need to sign in again
        with ChatGPT to use Codex preview models.
      </p>
      <div class="actions modal-actions">
        <button class="btn" onclick={() => (confirmingLogout = false)}>Cancel</button>
        <button class="btn danger" onclick={handleLogoutConfirm}>Log out</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .card {
    padding: 1rem 1.25rem;
    border: 1px solid var(--border, rgba(155, 114, 207, 0.2));
    border-radius: 0.5rem;
    background: var(--card-bg, rgba(255, 255, 255, 0.02));
    margin-bottom: 1rem;
  }
  .card.green { border-color: rgba(120, 200, 120, 0.4); }
  .card.yellow { border-color: rgba(220, 180, 80, 0.4); }
  .card.red { border-color: rgba(220, 80, 80, 0.4); }
  .section-title {
    margin: 0 0 0.5rem 0;
    font-size: 0.95rem;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0 0.75rem 0;
    font-size: 0.875rem;
  }
  .status-dot {
    width: 0.625rem;
    height: 0.625rem;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .status-row.green .status-dot { background: rgb(120, 200, 120); }
  .status-row.yellow .status-dot { background: rgb(220, 180, 80); }
  .status-row.red .status-dot { background: rgb(220, 80, 80); }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }
  .modal-actions {
    justify-content: flex-end;
  }
  .btn {
    padding: 0.375rem 0.75rem;
    border: 1px solid rgba(155, 114, 207, 0.3);
    background: transparent;
    color: var(--text);
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.8125rem;
  }
  .btn:hover:not(:disabled) {
    background: rgba(155, 114, 207, 0.1);
  }
  .btn.primary {
    background: rgba(155, 114, 207, 0.2);
    border-color: rgba(155, 114, 207, 0.5);
  }
  .btn.danger {
    border-color: rgba(220, 80, 80, 0.4);
    color: rgb(220, 100, 100);
  }
  .btn.danger:hover:not(:disabled) {
    background: rgba(220, 80, 80, 0.1);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: rgb(155, 114, 207);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .hint {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0.25rem 0;
  }
  .dim { color: var(--text-muted); }
  .small { font-size: 0.75rem; }
  .warning {
    font-size: 0.8125rem;
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
  }
  .warning.yellow {
    background: rgba(220, 180, 80, 0.1);
    color: rgb(200, 160, 80);
  }
  .warning.red {
    background: rgba(220, 80, 80, 0.1);
    color: rgb(220, 100, 100);
  }
  .manual-code {
    margin: 0.5rem 0;
  }
  .manual-code label {
    display: block;
    margin-bottom: 0.25rem;
  }
  .manual-code .row {
    display: flex;
    gap: 0.5rem;
  }
  .manual-code input {
    flex: 1;
    padding: 0.375rem 0.5rem;
    border: 1px solid rgba(155, 114, 207, 0.3);
    background: rgba(0, 0, 0, 0.2);
    color: var(--text);
    border-radius: 0.375rem;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.8125rem;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg, #1a1426);
    border: 1px solid rgba(155, 114, 207, 0.3);
    border-radius: 0.5rem;
    padding: 1.25rem;
    max-width: 32rem;
  }
  .modal h4 {
    margin: 0 0 0.75rem 0;
  }
  .modal p {
    font-size: 0.875rem;
    margin: 0.5rem 0;
  }
</style>
