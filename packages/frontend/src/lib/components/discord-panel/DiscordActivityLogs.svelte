<script lang="ts">
  interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    event: string;
    detail?: string;
  }

  let {
    showLogs,
    logsLoading,
    activityLogs,
    ontoggleopen,
    formatLogTime,
    formatLogDate,
  } = $props<{
    showLogs: boolean;
    logsLoading: boolean;
    activityLogs: LogEntry[];
    ontoggleopen?: () => void;
    formatLogTime: (iso: string) => string;
    formatLogDate: (iso: string) => string;
  }>();
</script>

<section class="section">
  <button class="collapsible-header" onclick={() => ontoggleopen?.()}>
    <h3 class="section-title">Recent Activity</h3>
    <span class="chevron" class:open={showLogs}>&#9656;</span>
  </button>

  {#if showLogs}
    {#if logsLoading && activityLogs.length === 0}
      <p class="loading">Loading logs...</p>
    {:else if activityLogs.length === 0}
      <p class="section-desc">No activity recorded yet.</p>
    {:else}
      <div class="log-list">
        {#each activityLogs as entry, i}
          {@const prevDate = i > 0 ? formatLogDate(activityLogs[i - 1].timestamp) : null}
          {@const thisDate = formatLogDate(entry.timestamp)}
          {#if thisDate !== prevDate}
            <div class="log-date-sep">{thisDate}</div>
          {/if}
          <div class="log-entry log-{entry.level}">
            <span class="log-time">{formatLogTime(entry.timestamp)}</span>
            <span class="log-level-dot"></span>
            <span class="log-event">{entry.event}</span>
            {#if entry.detail}
              <span class="log-detail">{entry.detail}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</section>

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

  .collapsible-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }

  .collapsible-header .section-title {
    margin-bottom: 0;
  }

  .chevron {
    color: var(--text-muted);
    transition: transform 0.2s ease;
    font-size: 0.75rem;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    text-align: center;
    padding: 2rem;
  }

  .log-list {
    max-height: 24rem;
    overflow-y: auto;
    margin-top: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--bg-surface);
  }

  .log-date-sep {
    font-size: 0.6875rem;
    color: var(--text-muted);
    padding: 0.375rem 0.75rem;
    background: var(--bg-base, var(--bg-surface));
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    position: sticky;
    top: 0;
    z-index: 1;
  }

  .log-entry {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.3125rem 0.75rem;
    font-size: 0.75rem;
    border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent);
  }

  .log-entry:last-child {
    border-bottom: none;
  }

  .log-time {
    font-family: var(--font-mono, monospace);
    color: var(--text-muted);
    font-size: 0.6875rem;
    flex-shrink: 0;
    min-width: 5rem;
  }

  .log-level-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    align-self: center;
  }

  .log-info .log-level-dot { background: #64748b; }
  .log-warn .log-level-dot { background: #f59e0b; }
  .log-error .log-level-dot { background: #ef4444; }

  .log-event {
    color: var(--text-primary);
    font-weight: 500;
    flex-shrink: 0;
  }

  .log-warn .log-event { color: #f59e0b; }
  .log-error .log-event { color: #ef4444; }

  .log-detail {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
