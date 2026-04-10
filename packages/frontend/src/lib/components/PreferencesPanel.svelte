<script lang="ts">
  import { onMount } from 'svelte';

  interface Preferences {
    identity: { companion_name: string; user_name: string; timezone: string };
    agent: { model: string; model_autonomous: string };
    orchestrator: { enabled: boolean };
    voice: { enabled: boolean };
    discord: { enabled: boolean };
    telegram: { enabled: boolean };
    auth: { has_password: boolean };
  }

  let prefs = $state<Preferences | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);

  // Editable drafts
  let companionName = $state('');
  let userName = $state('');
  let timezone = $state('');
  let model = $state('');
  let modelAutonomous = $state('');
  let orchestratorEnabled = $state(true);
  let voiceEnabled = $state(false);
  let discordEnabled = $state(false);
  let telegramEnabled = $state(false);
  let newPassword = $state('');

  const MODELS = [
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-opus-4-5-20250414', label: 'Opus 4.5' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-sonnet-4-5-20250414', label: 'Sonnet 4.5' },
    { id: 'claude-haiku-4-5-20250414', label: 'Haiku 4.5' },
  ];

  async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const COMMON_TIMEZONES = [
    'UTC',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata',
    'Australia/Sydney', 'Pacific/Auckland',
  ];

  async function loadPrefs() {
    try {
      const res = await fetchWithTimeout('/api/preferences');
      if (!res.ok) throw new Error('Failed to load');
      prefs = await res.json();
      // Populate drafts
      companionName = prefs!.identity.companion_name;
      userName = prefs!.identity.user_name;
      timezone = prefs!.identity.timezone;
      model = prefs!.agent.model;
      modelAutonomous = prefs!.agent.model_autonomous;
      orchestratorEnabled = prefs!.orchestrator.enabled;
      voiceEnabled = prefs!.voice.enabled;
      discordEnabled = prefs!.discord.enabled;
      telegramEnabled = prefs!.telegram.enabled;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        error = 'Loading preferences timed out';
      } else {
        error = 'Failed to load preferences';
      }
    } finally {
      loading = false;
    }
  }

  async function savePrefs() {
    saving = true;
    message = null;
    error = null;
    try {
      const updates: Record<string, unknown> = {
        identity: { companion_name: companionName, user_name: userName, timezone },
        agent: { model, model_autonomous: modelAutonomous },
        orchestrator: { enabled: orchestratorEnabled },
        voice: { enabled: voiceEnabled },
        discord: { enabled: discordEnabled },
        telegram: { enabled: telegramEnabled },
      };
      if (newPassword) {
        updates.auth = { password: newPassword };
      }
      const res = await fetchWithTimeout('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (res.ok) {
        message = data.message || 'Saved';
        newPassword = '';
      } else {
        error = data.error || 'Failed to save';
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        error = 'Loading preferences timed out';
      } else {
        error = 'Failed to save preferences';
      }
    } finally {
      saving = false;
    }
  }

  onMount(loadPrefs);
</script>

<div class="prefs-panel">
  {#if loading}
    <p class="loading-text">Loading preferences...</p>
  {:else if prefs}
    <!-- Identity -->
    <section class="section">
      <h3 class="section-title">Identity</h3>
      <p class="section-desc">Names and timezone used throughout the system.</p>

      <div class="field">
        <label class="field-label" for="pref-companion">Companion Name</label>
        <input id="pref-companion" type="text" class="field-input" bind:value={companionName} placeholder="Echo" />
      </div>

      <div class="field">
        <label class="field-label" for="pref-user">Your Name</label>
        <input id="pref-user" type="text" class="field-input" bind:value={userName} placeholder="Alex" />
      </div>

      <div class="field">
        <label class="field-label" for="pref-tz">Timezone</label>
        <select id="pref-tz" class="field-select" bind:value={timezone}>
          {#each COMMON_TIMEZONES as tz}
            <option value={tz}>{tz}</option>
          {/each}
          {#if !COMMON_TIMEZONES.includes(timezone)}
            <option value={timezone}>{timezone}</option>
          {/if}
        </select>
      </div>
    </section>

    <!-- Agent Models -->
    <section class="section">
      <h3 class="section-title">Agent Models</h3>
      <p class="section-desc">Claude model for interactive and autonomous messages.</p>

      <div class="field">
        <label class="field-label" for="pref-model">Interactive Model</label>
        <select id="pref-model" class="field-select" bind:value={model}>
          {#each MODELS as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
        <span class="field-hint">Used when you send a message</span>
      </div>

      <div class="field">
        <label class="field-label" for="pref-model-auto">Autonomous Model</label>
        <select id="pref-model-auto" class="field-select" bind:value={modelAutonomous}>
          {#each MODELS as m}
            <option value={m.id}>{m.label}</option>
          {/each}
        </select>
        <span class="field-hint">Used for scheduled wakes and autonomous actions</span>
      </div>
    </section>

    <!-- Toggles -->
    <section class="section">
      <h3 class="section-title">Features</h3>
      <p class="section-desc">Enable or disable system features.</p>

      <label class="toggle-row">
        <input type="checkbox" bind:checked={orchestratorEnabled} />
        <span class="toggle-label">Orchestrator</span>
        <span class="toggle-desc">Scheduled wake-ups and autonomous actions</span>
      </label>

      <label class="toggle-row">
        <input type="checkbox" bind:checked={voiceEnabled} />
        <span class="toggle-label">Voice</span>
        <span class="toggle-desc">ElevenLabs TTS and Groq transcription</span>
      </label>
      {#if voiceEnabled}
        <div class="setup-guide">
          <p class="guide-title">Voice Setup</p>
          <ol class="guide-steps">
            <li>Get an API key from <strong>ElevenLabs</strong> — <a href="https://elevenlabs.io" target="_blank" rel="noopener">elevenlabs.io</a> → Profile → API Keys</li>
            <li>Create or choose a voice, copy the <strong>Voice ID</strong> from the voice settings</li>
            <li>For transcription, get a <strong>Groq</strong> API key — <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a> → API Keys</li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=your_voice_id
GROQ_API_KEY=your_groq_key</pre>
            </li>
            <li>Restart the server</li>
          </ol>
        </div>
      {/if}

      <label class="toggle-row">
        <input type="checkbox" bind:checked={discordEnabled} />
        <span class="toggle-label">Discord</span>
        <span class="toggle-desc">Discord bot gateway integration</span>
      </label>
      {#if discordEnabled}
        <div class="setup-guide">
          <p class="guide-title">Discord Setup</p>
          <ol class="guide-steps">
            <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a></li>
            <li>Create a <strong>New Application</strong>, then go to <strong>Bot</strong> → Reset Token → copy the token</li>
            <li>Under <strong>Privileged Gateway Intents</strong>, enable: Message Content, Server Members, Presence</li>
            <li>Go to <strong>OAuth2</strong> → URL Generator → select <code>bot</code> scope with permissions: Send Messages, Read Message History, Add Reactions, Embed Links, Attach Files</li>
            <li>Use the generated URL to invite the bot to your server</li>
            <li>Right-click your username in Discord → Copy User ID (enable Developer Mode in Discord settings first)</li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">DISCORD_BOT_TOKEN=your_bot_token</pre>
            </li>
            <li>Set your owner user ID in <code>resonant.yaml</code>:
              <pre class="guide-code">discord:
  enabled: true
  owner_user_id: "your_discord_user_id"</pre>
            </li>
            <li>Restart the server. Configure rules in the Discord tab in settings.</li>
          </ol>
        </div>
      {/if}

      <label class="toggle-row">
        <input type="checkbox" bind:checked={telegramEnabled} />
        <span class="toggle-label">Telegram</span>
        <span class="toggle-desc">Telegram bot integration</span>
      </label>
      {#if telegramEnabled}
        <div class="setup-guide">
          <p class="guide-title">Telegram Setup</p>
          <ol class="guide-steps">
            <li>Open Telegram, search for <strong>@BotFather</strong></li>
            <li>Send <code>/newbot</code>, follow the prompts to name your bot</li>
            <li>Copy the <strong>bot token</strong> BotFather gives you</li>
            <li>Send a message to your new bot, then visit:<br/>
              <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code><br/>
              Find your <strong>chat ID</strong> in the response JSON under <code>message.chat.id</code></li>
            <li>Add to your <code>.env</code> file:
              <pre class="guide-code">TELEGRAM_BOT_TOKEN=your_bot_token</pre>
            </li>
            <li>Set your chat ID in <code>resonant.yaml</code>:
              <pre class="guide-code">telegram:
  enabled: true
  owner_chat_id: "your_chat_id"</pre>
            </li>
            <li>Restart the server</li>
          </ol>
        </div>
      {/if}
    </section>

    <!-- Security -->
    <section class="section">
      <h3 class="section-title">Security</h3>
      <p class="section-desc">
        {#if prefs.auth.has_password}
          Password is set. Leave blank to keep current password.
        {:else}
          No password set. Access is open to anyone on the network.
        {/if}
      </p>

      <div class="field">
        <label class="field-label" for="pref-password">
          {prefs.auth.has_password ? 'Change Password' : 'Set Password'}
        </label>
        <input id="pref-password" type="password" class="field-input" bind:value={newPassword} placeholder="Leave blank to keep unchanged" />
      </div>
    </section>

    <!-- Save -->
    <div class="save-area">
      {#if message}
        <p class="save-message success">{message}</p>
      {/if}
      {#if error}
        <p class="save-message error">{error}</p>
      {/if}
      <button class="save-btn" onclick={savePrefs} disabled={saving}>
        {saving ? 'Saving...' : 'Save Preferences'}
      </button>
      <p class="save-hint">Some changes require a server restart to take effect.</p>
    </div>
  {:else}
    <p class="loading-text">{error || 'Unable to load preferences'}</p>
  {/if}
</div>

<style>
  .prefs-panel {
    max-width: 540px;
  }

  .loading-text {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    padding: 1rem 0;
  }

  .section {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .section:last-of-type {
    border-bottom: none;
  }

  .section-title {
    font-family: var(--font-heading);
    font-size: 0.9375rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.375rem;
  }

  .section-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
    line-height: 1.5;
  }

  .field {
    margin-bottom: 1rem;
  }

  .field-label {
    display: block;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
    letter-spacing: 0.02em;
  }

  .field-input,
  .field-select {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-family: inherit;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field-input:focus,
  .field-select:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .field-hint {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .toggle-row {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  .toggle-row:last-of-type {
    border-bottom: none;
  }

  .toggle-row input[type="checkbox"] {
    margin-top: 0.125rem;
    width: 1rem;
    height: 1rem;
    accent-color: var(--gold);
    flex-shrink: 0;
  }

  .toggle-label {
    font-size: 0.875rem;
    color: var(--text-primary);
    min-width: 5rem;
    flex-shrink: 0;
  }

  .toggle-desc {
    font-size: 0.8125rem;
    color: var(--text-muted);
    flex: 1;
  }

  .save-area {
    padding-top: 0.5rem;
  }

  .save-btn {
    padding: 0.625rem 1.5rem;
    font-size: 0.875rem;
    font-family: var(--font-heading);
    letter-spacing: 0.04em;
    color: var(--bg-primary);
    background: var(--gold);
    border: none;
    border-radius: 6px;
    cursor: pointer;
    transition: opacity var(--transition);
  }

  .save-btn:hover {
    opacity: 0.9;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .save-message {
    font-size: 0.8125rem;
    padding: 0.5rem 0;
    margin: 0;
  }

  .save-message.success {
    color: var(--gold);
  }

  .save-message.error {
    color: #e05252;
  }

  .save-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  .setup-guide {
    margin: 0.5rem 0 1rem 1.75rem;
    padding: 1rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-left: 2px solid var(--gold-dim);
    border-radius: 6px;
  }

  .guide-title {
    font-family: var(--font-heading);
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.75rem;
  }

  .guide-steps {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  .guide-steps li {
    margin-bottom: 0.5rem;
  }

  .guide-steps a {
    color: var(--gold);
    text-decoration: none;
    border-bottom: 1px solid var(--gold-dim);
  }

  .guide-steps a:hover {
    border-bottom-color: var(--gold);
  }

  .guide-steps code {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--gold);
  }

  .guide-code {
    display: block;
    margin: 0.5rem 0;
    padding: 0.625rem 0.75rem;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre;
  }
</style>
