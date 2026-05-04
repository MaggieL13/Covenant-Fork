<script lang="ts">
  import { onMount } from 'svelte';
  import { loadRuntimeHealth, updateSdk, getRuntimeHealth, type SdkUpdateResult } from '$lib/stores/settings.svelte';

  let health = $derived(getRuntimeHealth());
  let loading = $state(false);
  let confirming = $state(false);
  let updating = $state(false);
  let lastResult = $state<SdkUpdateResult | null>(null);

  onMount(async () => {
    loading = true;
    await loadRuntimeHealth();
    loading = false;
  });

  // Numeric per-component compare. Mirrors the backend helper. Used to
  // compute `outdated` from active vs minRequired without round-tripping.
  function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] ?? 0;
      const vb = pb[i] ?? 0;
      if (va > vb) return 1;
      if (va < vb) return -1;
    }
    return 0;
  }

  // Compute both warning conditions independently — they can co-occur
  // (immediate-post-update state when upgrading TO a model whose minimum
  // exceeded the previous runtime). Show BOTH banners when both apply.
  let outdated = $derived(
    !!(health?.activeRuntimeVersion && health?.minRequired
      && compareVersions(health.activeRuntimeVersion, health.minRequired.version) < 0),
  );
  let restartRequired = $derived(!!health?.restartRequired);
  let unknown = $derived(!!health && !health.activeRuntimeVersion);

  // Headline color: red beats yellow beats green.
  let headline = $derived(
    outdated ? 'red' : (restartRequired || unknown) ? 'yellow' : 'green',
  );

  async function handleRefresh() {
    loading = true;
    await loadRuntimeHealth();
    loading = false;
  }

  async function handleUpdateConfirm() {
    confirming = false;
    updating = true;
    lastResult = null;
    try {
      const result = await updateSdk();
      lastResult = result;
      // Refresh the health snapshot so Installed reflects the new version.
      await loadRuntimeHealth();
    } finally {
      updating = false;
    }
  }
</script>

<section class="card" class:red={headline === 'red'} class:yellow={headline === 'yellow'} class:green={headline === 'green'}>
  <h3 class="section-title">Claude Runtime Health</h3>

  {#if loading && !health}
    <p class="empty-text">Loading…</p>
  {:else if !health}
    <p class="empty-text">Unable to read runtime health.</p>
  {:else}
    {@const status = headline === 'red' ? 'Outdated' : headline === 'yellow' ? (restartRequired ? 'Restart required' : 'Unknown') : 'OK'}
    <div class="status-row" class:red={headline === 'red'} class:yellow={headline === 'yellow'} class:green={headline === 'green'}>
      <span class="status-dot"></span>
      <strong>{status}</strong>
    </div>

    {#if outdated && health.minRequired}
      <p class="warning red">
        Active runtime <code>{health.activeRuntimeVersion}</code> is below the minimum required by
        <code>{health.minRequired.reason}</code> (<code>{health.minRequired.version}</code>).
      </p>
    {/if}
    {#if restartRequired}
      <p class="warning yellow">
        Installed runtime is newer than active — restart the backend to load it.
      </p>
    {/if}

    <dl class="version-grid">
      <dt>Active runtime (in memory)</dt>
      <dd><code>{health.activeRuntimeVersion ?? '—'}</code></dd>

      <dt>Installed runtime (on disk)</dt>
      <dd><code>{health.installedRuntimeVersion ?? '—'}</code></dd>

      <dt>System Claude Code (terminal)</dt>
      <dd><code>{health.systemCcVersion ?? '—'}</code></dd>

      <dt>Required by configured models</dt>
      <dd>
        {#if health.minRequired}
          <code>{health.minRequired.version}</code>
          <span class="dim">({health.minRequired.reason})</span>
        {:else}
          <span class="dim">no minimum declared</span>
        {/if}
      </dd>
    </dl>

    <div class="actions">
      <button class="btn" onclick={handleRefresh} disabled={loading || updating}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
      <button class="btn primary" onclick={() => (confirming = true)} disabled={updating}>
        {updating ? 'Updating…' : 'Update SDK'}
      </button>
    </div>

    <p class="hint">
      Update modifies <code>package-lock.json</code>. Backend restart required to activate the new runtime in memory.
    </p>

    {#if lastResult}
      {#if lastResult.success}
        <div class="result success">
          <strong>SDK updated.</strong>
          New installed runtime: <code>{lastResult.newInstalledVersion ?? '—'}</code>.
          Restart the backend to load it (<code>Ctrl+C</code> in your terminal, then <code>npm run start</code>;
          or <code>systemctl restart</code> for a managed service).
        </div>
      {:else}
        <div class="result error">
          <strong>Update failed.</strong>
          <p>{lastResult.error ?? 'Unknown error'}</p>
          {#if lastResult.stderrTail}
            <details>
              <summary>stderr (last 2KB)</summary>
              <pre>{lastResult.stderrTail}</pre>
            </details>
          {/if}
          {#if lastResult.stdoutTail}
            <details>
              <summary>stdout (last 2KB)</summary>
              <pre>{lastResult.stdoutTail}</pre>
            </details>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</section>

{#if confirming}
  <div class="modal-backdrop" role="dialog" aria-modal="true">
    <div class="modal">
      <h4>Update Claude Agent SDK?</h4>
      <p>
        This will run <code>npm install @anthropic-ai/claude-agent-sdk@latest</code>,
        modifying <code>package-lock.json</code> and possibly <code>packages/backend/package.json</code>.
      </p>
      <p>
        After the update completes, restart the backend manually for the new runtime to load.
      </p>
      <div class="actions">
        <button class="btn" onclick={() => (confirming = false)}>Cancel</button>
        <button class="btn primary" onclick={handleUpdateConfirm}>Update SDK</button>
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
  .card.red {
    border-color: rgba(220, 80, 80, 0.4);
  }
  .card.yellow {
    border-color: rgba(220, 180, 80, 0.4);
  }
  .section-title {
    margin: 0 0 0.75rem 0;
    font-size: 0.95rem;
  }
  .empty-text {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.75rem 0;
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
  .warning {
    font-size: 0.8125rem;
    margin: 0.25rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
  }
  .warning.red {
    background: rgba(220, 80, 80, 0.1);
    color: rgb(220, 100, 100);
  }
  .warning.yellow {
    background: rgba(220, 180, 80, 0.1);
    color: rgb(200, 160, 80);
  }
  .version-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0.75rem 0;
    font-size: 0.8125rem;
  }
  .version-grid dt {
    color: var(--text-muted);
  }
  .version-grid dd {
    margin: 0;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 0.875em;
    padding: 0.05rem 0.3rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 0.25rem;
  }
  .dim {
    color: var(--text-muted);
    font-size: 0.85em;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin: 0.5rem 0 0 0;
  }
  .result {
    margin-top: 0.75rem;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
  }
  .result.success {
    background: rgba(120, 200, 120, 0.1);
    color: rgb(140, 200, 140);
  }
  .result.error {
    background: rgba(220, 80, 80, 0.1);
    color: rgb(220, 100, 100);
  }
  .result details {
    margin-top: 0.375rem;
  }
  .result pre {
    font-size: 0.75rem;
    background: rgba(0, 0, 0, 0.2);
    padding: 0.5rem;
    border-radius: 0.25rem;
    overflow-x: auto;
    max-height: 12rem;
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
  .modal .actions {
    margin-top: 1rem;
    justify-content: flex-end;
  }
</style>
