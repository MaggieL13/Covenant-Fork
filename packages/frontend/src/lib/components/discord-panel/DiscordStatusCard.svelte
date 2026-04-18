<script lang="ts">
  interface DiscordStatus {
    enabled: boolean;
    configEnabled: boolean;
    hasToken: boolean;
    connected: boolean;
    username: string | null;
    guilds: number;
    messagesReceived: number;
    messagesProcessed: number;
    deferred: number;
    deferredPending: number;
    errors: number;
    botUser: { id: string; tag: string; username: string; avatar: string } | null;
  }

  let {
    discordStatus,
    isEnabled,
    toggling,
    pingLoading,
    pingResult,
    ontoggle,
    ontestconnection,
  } = $props<{
    discordStatus: DiscordStatus | null;
    isEnabled: boolean;
    toggling: boolean;
    pingLoading: boolean;
    pingResult: number | null;
    ontoggle?: () => void;
    ontestconnection?: () => void;
  }>();
</script>

<section class="section">
  <h3 class="section-title">Discord Gateway</h3>
  {#if !discordStatus?.hasToken}
    <div class="setup-guide">
      <p class="setup-intro">To connect your companion to Discord, you'll need to create a bot and add its token. Follow these steps:</p>

      <div class="setup-step">
        <span class="step-number">1</span>
        <div class="step-content">
          <strong>Create a Discord Application</strong>
          <p>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a> and click <strong>New Application</strong>. Give it a name (e.g. your companion's name).</p>
        </div>
      </div>

      <div class="setup-step">
        <span class="step-number">2</span>
        <div class="step-content">
          <strong>Create the Bot</strong>
          <p>In your application, go to <strong>Bot</strong> in the sidebar and click <strong>Add Bot</strong>. Then copy the <strong>Token</strong> - you'll need it in step 5.</p>
        </div>
      </div>

      <div class="setup-step">
        <span class="step-number">3</span>
        <div class="step-content">
          <strong>Enable Required Intents</strong>
          <p>Still on the Bot page, scroll down to <strong>Privileged Gateway Intents</strong> and enable:</p>
          <ul class="intent-list">
            <li><code>MESSAGE CONTENT</code> - required to read messages</li>
            <li><code>SERVER MEMBERS</code> - for user identification</li>
          </ul>
        </div>
      </div>

      <div class="setup-step">
        <span class="step-number">4</span>
        <div class="step-content">
          <strong>Invite the Bot to Your Server</strong>
          <p>Go to <strong>OAuth2 &rarr; URL Generator</strong>. Select the <code>bot</code> scope, then select these permissions: <em>Send Messages</em>, <em>Read Messages/View Channels</em>, <em>Read Message History</em>, <em>Add Reactions</em>. Open the generated URL to invite the bot.</p>
        </div>
      </div>

      <div class="setup-step">
        <span class="step-number">5</span>
        <div class="step-content">
          <strong>Add the Token</strong>
          <p>Paste your bot token into the <code>.env</code> file in the project root (next to <code>resonant.yaml</code>) and restart:</p>
          <pre class="code-block">DISCORD_BOT_TOKEN=your_token_here
DISCORD_ENABLED=true</pre>
        </div>
      </div>

      <div class="setup-step">
        <span class="step-number">6</span>
        <div class="step-content">
          <strong>Set Your Owner User ID</strong>
          <p>In Discord, go to <strong>Settings &rarr; Advanced</strong> and enable <strong>Developer Mode</strong>. Then right-click your own username and select <strong>Copy User ID</strong>. After restarting, paste it into the <em>Owner User ID</em> field in Gateway Settings below.</p>
        </div>
      </div>
    </div>
  {:else}
    <div class="toggle-row">
      <div class="toggle-label">
        <span class="toggle-text">{isEnabled ? 'Gateway active' : 'Gateway off'}</span>
        <span class="toggle-desc">Connect to Discord and receive messages</span>
      </div>
      <button
        class="toggle-switch"
        class:on={isEnabled}
        onclick={() => ontoggle?.()}
        disabled={toggling}
        aria-label={isEnabled ? 'Disable Discord' : 'Enable Discord'}
      >
        <span class="toggle-knob"></span>
      </button>
    </div>
  {/if}
</section>

{#if isEnabled}
  <section class="section">
    <h3 class="section-title">Connection</h3>
    <div class="status-row">
      <span class="status-dot" class:connected={discordStatus?.connected} class:offline={!discordStatus?.connected}></span>
      {#if discordStatus?.connected}
        <div class="connection-info">
          {#if discordStatus.botUser?.avatar}
            <img class="bot-avatar" src={discordStatus.botUser.avatar} alt="" />
          {/if}
          <span class="status-text connected">
            Connected as <strong>{discordStatus.botUser?.tag || discordStatus.username}</strong> · {discordStatus.guilds} server{discordStatus.guilds !== 1 ? 's' : ''}
          </span>
          <button class="btn btn-sm" onclick={() => ontestconnection?.()} disabled={pingLoading}>
            {pingLoading ? 'Pinging...' : pingResult !== null ? (pingResult >= 0 ? `${pingResult}ms` : 'Failed') : 'Test'}
          </button>
        </div>
      {:else}
        <span class="status-text offline">Connecting...</span>
      {/if}
    </div>

    {#if discordStatus?.connected}
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-label">Guilds</span>
          <span class="stat-value">{discordStatus.guilds}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Received</span>
          <span class="stat-value">{discordStatus.messagesReceived}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Processed</span>
          <span class="stat-value">{discordStatus.messagesProcessed}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Deferred</span>
          <span class="stat-value">{discordStatus.deferred ?? 0}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Errors</span>
          <span class="stat-value" class:error-count={discordStatus.errors > 0}>{discordStatus.errors}</span>
        </div>
      </div>
      {#if discordStatus.deferredPending > 0}
        <p class="deferred-notice">{discordStatus.deferredPending} message{discordStatus.deferredPending > 1 ? 's' : ''} held - waiting for Pulse conversation gap</p>
      {/if}
    {/if}
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

  .setup-guide {
    margin-top: 0.5rem;
  }

  .setup-intro {
    font-size: 0.875rem;
    color: var(--text-secondary);
    margin-bottom: 1rem;
    line-height: 1.5;
  }

  .setup-step {
    display: flex;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .step-number {
    flex-shrink: 0;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--accent, #7c5cbf);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 0.125rem;
  }

  .step-content {
    font-size: 0.8125rem;
    color: var(--text-primary);
    line-height: 1.5;
  }

  .step-content strong {
    display: block;
    margin-bottom: 0.25rem;
  }

  .step-content p {
    color: var(--text-secondary);
    margin: 0.25rem 0;
  }

  .step-content a {
    color: var(--accent, #7c5cbf);
    text-decoration: underline;
  }

  .intent-list {
    margin: 0.375rem 0 0.25rem 1.25rem;
    padding: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .intent-list li {
    margin-bottom: 0.25rem;
  }

  .code-block {
    background: var(--bg-tertiary, var(--bg-secondary));
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    padding: 0.5rem 0.75rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.75rem;
    color: var(--text-primary);
    margin-top: 0.375rem;
    overflow-x: auto;
    white-space: pre;
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .toggle-label {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .toggle-text {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .toggle-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
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

  .toggle-switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle-switch.on {
    background: var(--accent);
    border-color: var(--accent);
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

  .status-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-dot.connected { background: #22c55e; }
  .status-dot.offline { background: var(--text-muted); }

  .status-text {
    font-size: 0.875rem;
  }

  .status-text.connected { color: #22c55e; }
  .status-text.offline { color: var(--text-muted); }

  .connection-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
  }

  .bot-avatar {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
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

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 0.5rem;
    margin-top: 0.75rem;
  }

  .deferred-notice {
    font-size: 0.75rem;
    color: #f59e0b;
    margin-top: 0.5rem;
    font-style: italic;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.625rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    text-align: center;
  }

  .stat-label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stat-value {
    font-size: 0.875rem;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
  }

  .stat-value.error-count {
    color: #ef4444;
  }

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(3, 1fr);
    }
  }
</style>

