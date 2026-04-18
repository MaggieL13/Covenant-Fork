<script lang="ts">
  interface PairingEntry {
    code: string;
    userId: string;
    username: string | null;
    channelId: string;
    createdAt: string;
    expiresAt: string;
    approvedAt?: string;
    approvedBy?: string;
  }

  let {
    pendingPairings,
    approvedPairings,
    actionLoading,
    onapprove,
    onrevoke,
  } = $props<{
    pendingPairings: PairingEntry[];
    approvedPairings: PairingEntry[];
    actionLoading: string | null;
    onapprove?: (code: string) => void;
    onrevoke?: (userId: string) => void;
  }>();
</script>

{#if pendingPairings.length > 0}
  <section class="section">
    <h3 class="section-title">Pending Pairing Requests <span class="badge">{pendingPairings.length}</span></h3>
    <p class="section-desc">Users who sent a pairing code via DM. Approve to allow them to message your companion.</p>
    <div class="pairing-list">
      {#each pendingPairings as pairing}
        <div class="pairing-card">
          <div class="pairing-info">
            <span class="pairing-user">{pairing.username || pairing.userId}</span>
            <span class="pairing-meta">
              Code: <code>{pairing.code}</code> ·
              Expires {new Date(pairing.expiresAt).toLocaleString()}
            </span>
          </div>
          <button
            class="btn btn-primary"
            onclick={() => onapprove?.(pairing.code)}
            disabled={actionLoading === `approve-${pairing.code}`}
          >
            {actionLoading === `approve-${pairing.code}` ? 'Approving...' : 'Approve'}
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}

{#if approvedPairings.length > 0}
  <section class="section">
    <h3 class="section-title">Approved Users</h3>
    <p class="section-desc">Users who can message your companion via Discord DMs.</p>
    <div class="pairing-list">
      {#each approvedPairings as pairing}
        <div class="pairing-card">
          <div class="pairing-info">
            <span class="pairing-user">{pairing.username || pairing.userId}</span>
            <span class="pairing-meta">
              Approved {pairing.approvedAt ? new Date(pairing.approvedAt).toLocaleDateString() : 'unknown'}
            </span>
          </div>
          <button
            class="btn btn-danger"
            onclick={() => onrevoke?.(pairing.userId)}
            disabled={actionLoading === `revoke-${pairing.userId}`}
          >
            {actionLoading === `revoke-${pairing.userId}` ? 'Revoking...' : 'Revoke'}
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .section {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .section:last-of-type {
    border-bottom: none;
  }

  .section-title {
    font-family: var(--font-body);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: 0;
    margin-bottom: 0.5rem;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.375rem;
    border-radius: 0.625rem;
    background: var(--accent, #7c5cbf);
    color: #fff;
    font-size: 0.6875rem;
    font-weight: 700;
    margin-left: 0.375rem;
    vertical-align: middle;
  }

  .pairing-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pairing-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .pairing-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .pairing-user {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .pairing-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .pairing-meta code {
    font-size: 0.6875rem;
    background: var(--bg-tertiary, var(--bg-primary));
    padding: 0.0625rem 0.25rem;
    border-radius: 3px;
  }

  .btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.8125rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition);
    border: 1px solid transparent;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .btn-danger {
    background: transparent;
    color: #ef4444;
    border-color: #ef4444;
  }

  .btn-danger:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.1);
  }

  @media (max-width: 768px) {
    .pairing-card {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .btn {
      text-align: center;
    }
  }
</style>

