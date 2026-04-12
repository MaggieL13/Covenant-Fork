<script lang="ts">
  import { onMount } from 'svelte';
  import { updateSetting, getConfig } from '$lib/stores/settings.svelte';
  import { apiFetch } from '$lib/utils/api';

  interface Preferences {
    identity: { companion_name: string; user_name: string; timezone: string };
    agent: { model: string; model_autonomous: string; thinking_effort: string };
    orchestrator: { enabled: boolean };
    voice: { enabled: boolean };
    discord: { enabled: boolean };
    telegram: { enabled: boolean };
    auth: { has_password: boolean };
  }

  interface McpServer {
    name: string;
    type: 'url' | 'sse' | 'stdio' | 'http';
    url?: string;
    command?: string;
    args?: string[];
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
  let thinkingEffort = $state('max');
  let orchestratorEnabled = $state(true);
  let voiceEnabled = $state(false);
  let discordEnabled = $state(false);
  let telegramEnabled = $state(false);
  let newPassword = $state('');

  // Personality state
  let personalityRawMode = $state(false);
  let personalityContent = $state('');
  let personalityExample = $state('');
  let personalityTemplate = $state('');
  let guidedPersonality = $state('');
  let guidedCommStyle = $state('');
  let guidedInterests = $state('');
  let guidedUserContext = $state('');
  let savingPersonality = $state(false);
  let personalityMessage = $state<string | null>(null);

  // MCP Servers state
  let mcpServers = $state<McpServer[]>([]);
  let mcpRawContent = $state('');
  let newServerName = $state('');
  let newServerType = $state<'url' | 'sse' | 'stdio'>('url');
  let newServerUrl = $state('');
  let newServerCommand = $state('');
  let newServerArgs = $state('');
  let mcpMessage = $state<string | null>(null);

  import { MODELS } from '$lib/models';

  async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await apiFetch(input as string, { ...init, signal: controller.signal });
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
      // DB config (set by chat header selector) takes priority over YAML
      const dbConfig = getConfig();
      model = dbConfig['agent.model'] || prefs!.agent.model;
      modelAutonomous = prefs!.agent.model_autonomous;
      thinkingEffort = prefs!.agent.thinking_effort || 'max';
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
        agent: { model, model_autonomous: modelAutonomous, thinking_effort: thinkingEffort },
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
        // Sync model to DB config so the chat header pill updates
        await updateSetting('agent.model', model);
        await updateSetting('agent.thinking_effort', thinkingEffort);
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

  // --- Personality helpers ---
  function parseGuidedFields(md: string) {
    const extract = (heading: string): string => {
      const re = new RegExp(`##\\s+${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
      const match = md.match(re);
      return match ? match[1].trim() : '';
    };
    guidedPersonality = extract('Personality');
    guidedCommStyle = extract('Communication Style');
    guidedInterests = extract('Interests(?:\\s*[&]\\s*Knowledge)?');
    guidedUserContext = extract('About\\s+\\S+');
  }

  function assembleFromGuided(): string {
    const name = companionName || 'Companion';
    const uname = userName || 'User';
    let md = `# ${name}\n\n`;
    md += `## Personality\n${guidedPersonality || '(describe personality here)'}\n\n`;
    md += `## Communication Style\n${guidedCommStyle || '(describe communication style here)'}\n\n`;
    md += `## Interests & Knowledge\n${guidedInterests || '(list interests here)'}\n\n`;
    md += `## About ${uname}\n${guidedUserContext || '(describe the user here)'}\n\n`;
    md += `## Guidelines\n- Be genuine and consistent in personality\n- Remember context from previous conversations\n- Use the tools available when they'd be helpful\n- Be proactive but not overwhelming\n\n`;
    md += `## Orchestrator\nWhen you wake up via the orchestrator (scheduled messages), you should:\n1. Orient yourself — what time is it? What's been happening?\n2. Decide whether to reach out or do independent work\n3. If reaching out, be genuine — not a notification, a person\n\n`;
    md += `## MCP Tools\nUse any MCP tools configured in .mcp.json naturally as part of conversation.\nDon't announce tool use unless the result is relevant to share.\n`;
    return md;
  }

  async function loadPersonality() {
    try {
      const res = await fetchWithTimeout('/api/config/claude-md');
      if (!res.ok) return;
      const data = await res.json();
      personalityContent = data.content || '';
      personalityExample = data.example || '';
      personalityTemplate = data.template || '';
      parseGuidedFields(personalityContent);
    } catch {
      // silent — personality section will just show defaults
    }
  }

  async function savePersonality() {
    savingPersonality = true;
    personalityMessage = null;
    try {
      const content = personalityRawMode ? personalityContent : assembleFromGuided();
      const res = await fetchWithTimeout('/api/config/claude-md', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (res.ok) {
        personalityMessage = data.message || 'Personality saved';
        personalityContent = content;
        if (!personalityRawMode) parseGuidedFields(content);
      } else {
        personalityMessage = data.error || 'Failed to save';
      }
    } catch {
      personalityMessage = 'Failed to save personality';
    } finally {
      savingPersonality = false;
    }
  }

  function resetPersonality() {
    personalityContent = personalityExample || personalityTemplate || '';
    parseGuidedFields(personalityContent);
    personalityMessage = 'Reset to default — save to apply.';
  }

  // --- MCP Servers helpers ---
  function parseMcpJson(raw: string): McpServer[] {
    try {
      const parsed = JSON.parse(raw);
      const servers = parsed.mcpServers || {};
      return Object.entries(servers).map(([name, cfg]: [string, any]) => {
        const type = cfg.type || (cfg.url ? 'url' : cfg.command ? 'stdio' : 'url');
        return {
          name,
          type,
          url: cfg.url,
          command: cfg.command,
          args: cfg.args,
        };
      });
    } catch {
      return [];
    }
  }

  function serversToJson(servers: McpServer[]): string {
    const obj: Record<string, any> = {};
    for (const s of servers) {
      if (s.type === 'url' || s.type === 'sse' || s.type === 'http') {
        obj[s.name] = { type: s.type, url: s.url || '' };
      } else {
        obj[s.name] = { type: s.type, command: s.command || '', args: s.args || [] };
      }
    }
    return JSON.stringify({ mcpServers: obj }, null, 2);
  }

  async function loadMcpServers() {
    try {
      const res = await fetchWithTimeout('/api/config/mcp-json');
      if (!res.ok) return;
      const data = await res.json();
      mcpRawContent = data.content || '{"mcpServers":{}}';
      mcpServers = parseMcpJson(mcpRawContent);
    } catch {
      // silent
    }
  }

  async function saveMcpConfig() {
    mcpMessage = null;
    try {
      const content = serversToJson(mcpServers);
      const res = await fetchWithTimeout('/api/config/mcp-json', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (res.ok) {
        mcpMessage = data.message || 'MCP config saved';
        mcpRawContent = content;
      } else {
        mcpMessage = data.error || 'Failed to save';
      }
    } catch {
      mcpMessage = 'Failed to save MCP config';
    }
  }

  function addMcpServer() {
    if (!newServerName.trim()) return;
    const server: McpServer = {
      name: newServerName.trim(),
      type: newServerType,
    };
    if (newServerType === 'url' || newServerType === 'sse') {
      server.url = newServerUrl.trim();
    } else {
      server.command = newServerCommand.trim();
      server.args = newServerArgs.trim() ? newServerArgs.trim().split(/\s+/) : [];
    }
    mcpServers = [...mcpServers, server];
    newServerName = '';
    newServerUrl = '';
    newServerCommand = '';
    newServerArgs = '';
    saveMcpConfig();
  }

  function removeMcpServer(name: string) {
    mcpServers = mcpServers.filter(s => s.name !== name);
    saveMcpConfig();
  }

  onMount(() => {
    loadPrefs();
    loadPersonality();
    loadMcpServers();
  });
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

    <!-- Claude Configuration -->
    <section class="section">
      <h3 class="section-title">Claude</h3>
      <p class="section-desc">Model selection and thinking behavior for the Claude Agent SDK.</p>

      <div class="field">
        <label class="field-label" for="pref-model">Chat Model</label>
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

      <div class="field">
        <label class="field-label" for="pref-effort">Thinking Effort</label>
        <select id="pref-effort" class="field-select" bind:value={thinkingEffort}>
          <option value="max">Max — always thinks deeply, no constraints</option>
          <option value="high">High — almost always thinks (default)</option>
          <option value="medium">Medium — thinks when needed, skips simple stuff</option>
          <option value="low">Low — minimal thinking, fastest responses</option>
        </select>
        <span class="field-hint">How much the model reasons before responding. Higher = smarter but slower</span>
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

    <!-- Personality -->
    <section class="section">
      <h3 class="section-title">Personality</h3>
      <p class="section-desc">Your companion's personality and behavior instructions.</p>

      <div class="mode-toggle">
        <button class="mode-btn" class:active={!personalityRawMode} onclick={() => personalityRawMode = false}>Guided</button>
        <button class="mode-btn" class:active={personalityRawMode} onclick={() => personalityRawMode = true}>Raw Editor</button>
      </div>

      {#if personalityRawMode}
        <textarea bind:value={personalityContent} class="raw-editor" rows="16"
          placeholder="Write personality in markdown..."></textarea>
      {:else}
        <div class="field">
          <label class="field-label" for="pref-personality">What's their personality like?</label>
          <textarea id="pref-personality" class="field-textarea" bind:value={guidedPersonality} rows="3" placeholder="e.g. Warm, nerdy, a bit sarcastic..."></textarea>
        </div>
        <div class="field">
          <label class="field-label" for="pref-commstyle">How do they talk?</label>
          <textarea id="pref-commstyle" class="field-textarea" bind:value={guidedCommStyle} rows="3" placeholder="e.g. Casual, uses emojis..."></textarea>
        </div>
        <div class="field">
          <label class="field-label" for="pref-interests">What are they interested in?</label>
          <textarea id="pref-interests" class="field-textarea" bind:value={guidedInterests} rows="3" placeholder="e.g. Coding, music, cooking..."></textarea>
        </div>
        <div class="field">
          <label class="field-label" for="pref-userctx">What should they know about you?</label>
          <textarea id="pref-userctx" class="field-textarea" bind:value={guidedUserContext} rows="3" placeholder="e.g. Developer, has a cat named Pixel..."></textarea>
        </div>
      {/if}

      <div class="personality-actions">
        <button class="save-btn" onclick={savePersonality} disabled={savingPersonality}>
          {savingPersonality ? 'Saving...' : 'Save Personality'}
        </button>
        <button class="secondary-btn" onclick={resetPersonality}>Reset to Default</button>
      </div>
      {#if personalityMessage}
        <p class="status-msg">{personalityMessage}</p>
      {/if}
    </section>

    <!-- MCP Servers -->
    <section class="section">
      <h3 class="section-title">MCP Servers</h3>
      <p class="section-desc">Connect external tools and services to your companion.</p>

      {#if mcpServers.length === 0}
        <p class="empty-state">No MCP servers configured.</p>
      {:else}
        {#each mcpServers as server}
          <div class="mcp-server-card">
            <div class="server-header">
              <strong class="server-name">{server.name}</strong>
              <span class="server-type">{server.type}</span>
              <button class="remove-btn" onclick={() => removeMcpServer(server.name)}>Remove</button>
            </div>
            <div class="server-detail">
              {#if server.type === 'url' || server.type === 'http' || server.type === 'sse'}
                <span class="server-url">{server.url}</span>
              {:else}
                <span class="server-cmd">{server.command} {(server.args || []).join(' ')}</span>
              {/if}
            </div>
          </div>
        {/each}
      {/if}

      <details class="add-server-form">
        <summary class="add-server-summary">+ Add Server</summary>
        <div class="form-fields">
          <div class="field">
            <label class="field-label" for="mcp-name">Server Name</label>
            <input id="mcp-name" type="text" class="field-input" bind:value={newServerName} placeholder="e.g. my-tools" />
          </div>
          <div class="field">
            <label class="field-label" for="mcp-type">Type</label>
            <select id="mcp-type" class="field-select" bind:value={newServerType}>
              <option value="url">URL (HTTP)</option>
              <option value="sse">SSE</option>
              <option value="stdio">Command (stdio)</option>
            </select>
          </div>
          {#if newServerType === 'url' || newServerType === 'sse'}
            <div class="field">
              <label class="field-label" for="mcp-url">URL</label>
              <input id="mcp-url" type="text" class="field-input" bind:value={newServerUrl} placeholder="http://localhost:8080/mcp" />
            </div>
          {:else}
            <div class="field">
              <label class="field-label" for="mcp-cmd">Command</label>
              <input id="mcp-cmd" type="text" class="field-input" bind:value={newServerCommand} placeholder="e.g. npx" />
            </div>
            <div class="field">
              <label class="field-label" for="mcp-args">Arguments (space-separated)</label>
              <input id="mcp-args" type="text" class="field-input" bind:value={newServerArgs} placeholder="e.g. -y @my/mcp-server" />
            </div>
          {/if}
          <button class="save-btn" onclick={addMcpServer} disabled={!newServerName.trim()}>Add Server</button>
        </div>
      </details>

      {#if mcpMessage}
        <p class="status-msg">{mcpMessage}</p>
      {/if}
      <p class="info-note">Server restart required for MCP changes to take effect.</p>
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

  /* Personality section */
  .mode-toggle {
    display: flex;
    gap: 0;
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    width: fit-content;
  }

  .mode-btn {
    padding: 0.375rem 0.875rem;
    font-size: 0.8125rem;
    font-family: inherit;
    color: var(--text-secondary);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }

  .mode-btn:not(:last-child) {
    border-right: 1px solid var(--border);
  }

  .mode-btn.active {
    background: var(--gold-ember);
    color: var(--text-primary);
  }

  .raw-editor {
    width: 100%;
    padding: 0.75rem;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--text-primary);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .raw-editor:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .field-textarea {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    font-family: inherit;
    color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    resize: vertical;
    transition: border-color var(--transition), box-shadow var(--transition);
  }

  .field-textarea:focus {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  .personality-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    align-items: center;
  }

  .secondary-btn {
    padding: 0.625rem 1.25rem;
    font-size: 0.875rem;
    font-family: var(--font-heading);
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }

  .secondary-btn:hover {
    color: var(--text-primary);
    border-color: var(--text-muted);
  }

  .status-msg {
    font-size: 0.8125rem;
    color: var(--gold);
    margin: 0.5rem 0 0;
  }

  /* MCP Servers section */
  .empty-state {
    font-size: 0.8125rem;
    color: var(--text-muted);
    font-style: italic;
    padding: 0.5rem 0;
  }

  .mcp-server-card {
    padding: 0.75rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-input);
  }

  .server-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .server-name {
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .server-type {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    padding: 0.125rem 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
  }

  .remove-btn {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--text-muted);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    transition: color var(--transition), border-color var(--transition);
  }

  .remove-btn:hover {
    color: #e05252;
    border-color: #e05252;
  }

  .server-detail {
    margin-top: 0.375rem;
  }

  .server-url,
  .server-cmd {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    color: var(--text-muted);
    word-break: break-all;
  }

  .add-server-form {
    margin-top: 0.75rem;
  }

  .add-server-summary {
    font-size: 0.8125rem;
    color: var(--gold);
    cursor: pointer;
    padding: 0.375rem 0;
    letter-spacing: 0.02em;
  }

  .add-server-summary:hover {
    color: var(--text-primary);
  }

  .form-fields {
    padding: 0.75rem 0 0;
  }

  .info-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
    font-style: italic;
  }
</style>
