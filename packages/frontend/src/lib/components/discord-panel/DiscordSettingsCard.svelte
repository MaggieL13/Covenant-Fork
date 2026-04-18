<script lang="ts">
  import type { Snippet } from 'svelte';

  type DiscordSettingsField =
    | 'ownerUserId'
    | 'requireMentionInGuilds'
    | 'debounceMs'
    | 'pairingExpiryMs'
    | 'ownerActiveThresholdMin'
    | 'deferPollIntervalMs'
    | 'deferMaxAgeMs'
    | 'allowedUsers';

  let {
    settings,
    settingsLoading,
    settingsDirty,
    showSettings,
    ontoggleopen,
    onupdatefield,
    onsave,
    onautodetectowner,
    children,
  } = $props<{
    settings: {
      ownerUserId: string;
      requireMentionInGuilds: boolean;
      debounceMs: number;
      pairingExpiryMs: number;
      ownerActiveThresholdMin: number;
      deferPollIntervalMs: number;
      deferMaxAgeMs: number;
      allowedUsers: string[];
    } | null;
    settingsLoading: boolean;
    settingsDirty: boolean;
    showSettings: boolean;
    ontoggleopen?: () => void;
    onupdatefield?: (key: DiscordSettingsField, value: string | boolean | number | string[]) => void;
    onsave?: () => void;
    onautodetectowner?: () => void;
    children?: Snippet;
  }>();
</script>

<section class="section">
  <button class="collapsible-header" onclick={() => ontoggleopen?.()}>
    <h3 class="section-title">Gateway Settings</h3>
    <span class="chevron" class:open={showSettings}>&#9656;</span>
  </button>

  {#if showSettings}
    {#if settingsLoading && !settings}
      <p class="loading">Loading settings...</p>
    {:else if settings}
      <div class="settings-form">
        <div class="form-group">
          <span class="form-label">Owner User ID</span>
          <div class="input-with-button">
            <input
              type="text"
              class="form-input"
              value={settings.ownerUserId}
              onchange={(event) => onupdatefield?.('ownerUserId', (event.currentTarget as HTMLInputElement).value)}
              placeholder="e.g. 123456789012345678"
            />
            <button class="btn btn-sm" onclick={() => onautodetectowner?.()}>Auto-detect</button>
          </div>
          <span class="form-hint">Your Discord user ID - right-click your name in Discord (Developer Mode) and Copy User ID</span>
        </div>

        <label class="form-group">
          <span class="form-label">Debounce window (ms)</span>
          <input
            type="number"
            class="form-input"
            value={settings.debounceMs}
            onchange={(event) => onupdatefield?.('debounceMs', Number((event.currentTarget as HTMLInputElement).value))}
          />
          <span class="form-hint">Combines rapid messages within this window</span>
        </label>

        <div class="form-group">
          <span class="form-label">Require @mention in guilds</span>
          <div class="toggle-row compact">
            <button
              class="toggle-switch small"
              class:on={settings.requireMentionInGuilds}
              aria-label="Require @mention in guilds"
              aria-pressed={settings.requireMentionInGuilds}
              onclick={() => onupdatefield?.('requireMentionInGuilds', !settings.requireMentionInGuilds)}
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
        </div>

        <label class="form-group">
          <span class="form-label">Pairing expiry (hours)</span>
          <input
            type="number"
            class="form-input"
            step="0.5"
            value={settings.pairingExpiryMs / 3600000}
            onchange={(event) => onupdatefield?.('pairingExpiryMs', parseFloat((event.currentTarget as HTMLInputElement).value) * 3600000)}
          />
        </label>

        <label class="form-group">
          <span class="form-label">Owner active threshold (minutes)</span>
          <input
            type="number"
            class="form-input"
            value={settings.ownerActiveThresholdMin}
            onchange={(event) => onupdatefield?.('ownerActiveThresholdMin', Number((event.currentTarget as HTMLInputElement).value))}
          />
          <span class="form-hint">Defer non-owner messages when the owner has been active on the web UI within this window</span>
        </label>

        <label class="form-group">
          <span class="form-label">Defer poll interval (seconds)</span>
          <input
            type="number"
            class="form-input"
            value={settings.deferPollIntervalMs / 1000}
            onchange={(event) => onupdatefield?.('deferPollIntervalMs', parseFloat((event.currentTarget as HTMLInputElement).value) * 1000)}
          />
          <span class="form-hint">Requires gateway restart to take effect</span>
        </label>

        <label class="form-group">
          <span class="form-label">Defer max age (minutes)</span>
          <input
            type="number"
            class="form-input"
            value={settings.deferMaxAgeMs / 60000}
            onchange={(event) => onupdatefield?.('deferMaxAgeMs', parseFloat((event.currentTarget as HTMLInputElement).value) * 60000)}
          />
          <span class="form-hint">Drop deferred messages older than this</span>
        </label>

        {@render children?.()}

        <label class="form-group">
          <span class="form-label">Allowed users (IDs)</span>
          <input
            type="text"
            class="form-input"
            value={settings.allowedUsers.join(', ')}
            onchange={(event) => onupdatefield?.('allowedUsers', (event.currentTarget as HTMLInputElement).value.split(',').map((item) => item.trim()).filter(Boolean))}
            placeholder="e.g. 123456789012345678"
          />
          <span class="form-hint">Most users should use the pairing system. Only add IDs for pre-approved users. Owner is always allowed.</span>
        </label>

        {#if settingsDirty}
          <button class="btn btn-primary save-btn" onclick={() => onsave?.()} disabled={settingsLoading}>
            {settingsLoading ? 'Saving...' : 'Save Settings'}
          </button>
        {/if}
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

  .settings-form {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .form-input {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8125rem;
    padding: 0.5rem 0.625rem;
    font-family: inherit;
    transition: border-color var(--transition);
  }

  .form-input:focus {
    outline: none;
    border-color: var(--border-hover);
  }

  .form-hint {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .input-with-button {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  .input-with-button .form-input {
    flex: 1;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .toggle-row.compact {
    justify-content: flex-start;
  }

  .toggle-switch {
    position: relative;
    width: 44px;
    height: 24px;
    border-radius: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: all 0.2s ease;
    flex-shrink: 0;
    padding: 0;
  }

  .toggle-switch.on {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle-switch.small {
    width: 36px;
    height: 20px;
    border-radius: 10px;
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: all 0.2s ease;
  }

  .toggle-switch.on .toggle-knob {
    left: 22px;
    background: var(--bg-primary);
  }

  .toggle-switch.small .toggle-knob {
    width: 14px;
    height: 14px;
  }

  .toggle-switch.small.on .toggle-knob {
    left: 18px;
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

  .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.6875rem;
    border-radius: 0.25rem;
    background: var(--bg-tertiary, var(--bg-secondary));
    border: 1px solid var(--border);
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-sm:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .save-btn {
    margin-top: 0.75rem;
  }
</style>

