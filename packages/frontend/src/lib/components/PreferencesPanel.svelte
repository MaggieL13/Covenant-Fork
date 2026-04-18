<script lang="ts">
  import { onMount } from 'svelte';
  import McpServersEditor from '$lib/components/preferences-panel/McpServersEditor.svelte';
  import PersonalityEditor from '$lib/components/preferences-panel/PersonalityEditor.svelte';
  import PreferencesAuthCard from '$lib/components/preferences-panel/PreferencesAuthCard.svelte';
  import PreferencesGeneralCard from '$lib/components/preferences-panel/PreferencesGeneralCard.svelte';
  import PreferencesModelCard from '$lib/components/preferences-panel/PreferencesModelCard.svelte';
  import { MODELS } from '$lib/models';
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
      companionName = prefs!.identity.companion_name;
      userName = prefs!.identity.user_name;
      timezone = prefs!.identity.timezone;
      // ORDER: the DB-backed model selector must win over YAML so the settings draft matches the chat header pill.
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
      // ORDER: only include auth updates when the user actually typed a new password.
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
        // ORDER: sync the settings store only after the API save succeeds so the header reflects persisted state.
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
    md += `## Orchestrator\nWhen you wake up via the orchestrator (scheduled messages), you should:\n1. Orient yourself - what time is it? What's been happening?\n2. Decide whether to reach out or do independent work\n3. If reaching out, be genuine - not a notification, a person\n\n`;
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
      // ORDER: parse guided fields immediately after loading raw content so guided mode reflects the saved markdown on first render.
      parseGuidedFields(personalityContent);
    } catch {
      // silent - personality section will just show defaults
    }
  }

  async function savePersonality() {
    savingPersonality = true;
    personalityMessage = null;
    try {
      // ORDER: guided mode must assemble markdown before saving so raw and guided views serialize the same source.
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
        // ORDER: re-parse the saved content after a guided save so switching modes does not drift.
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
    // ORDER: reset raw content first, then derive the guided fields from that exact same source.
    personalityContent = personalityExample || personalityTemplate || '';
    parseGuidedFields(personalityContent);
    personalityMessage = 'Reset to default - save to apply.';
  }

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
      // ORDER: load raw JSON first, then derive cards so the editor mirrors the persisted config exactly.
      mcpRawContent = data.content || '{"mcpServers":{}}';
      mcpServers = parseMcpJson(mcpRawContent);
    } catch {
      // silent
    }
  }

  async function saveMcpConfig() {
    mcpMessage = null;
    try {
      // ORDER: serialize from the current server list at save time, then update raw content only after a successful response.
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
    // ORDER: update the in-memory list before saving so the serialized JSON includes the newly added server.
    mcpServers = [...mcpServers, server];
    newServerName = '';
    newServerUrl = '';
    newServerCommand = '';
    newServerArgs = '';
    saveMcpConfig();
  }

  function removeMcpServer(name: string) {
    // ORDER: filter the list before saving so the next serialized JSON reflects the removal.
    mcpServers = mcpServers.filter((server) => server.name !== name);
    saveMcpConfig();
  }

  onMount(() => {
    // ORDER: load base preferences before dependent sections render against draft state.
    loadPrefs();
    loadPersonality();
    loadMcpServers();
  });
</script>

<div class="prefs-panel">
  {#if loading}
    <p class="loading-text">Loading preferences...</p>
  {:else if prefs}
    <PreferencesGeneralCard
      identity={{ companionName, userName, timezone }}
      features={{ orchestratorEnabled, voiceEnabled, discordEnabled, telegramEnabled }}
      commonTimezones={COMMON_TIMEZONES}
      oncompanionnamechange={(value) => companionName = value}
      onusernamechange={(value) => userName = value}
      ontimezonechange={(value) => timezone = value}
      onorchestratorchange={(value) => orchestratorEnabled = value}
      onvoicechange={(value) => voiceEnabled = value}
      ondiscordchange={(value) => discordEnabled = value}
      ontelegramchange={(value) => telegramEnabled = value}
    />

    <PreferencesModelCard
      models={MODELS}
      {model}
      {modelAutonomous}
      {thinkingEffort}
      onmodelchange={(value) => model = value}
      onautonomousmodelchange={(value) => modelAutonomous = value}
      onthinkingeffortchange={(value) => thinkingEffort = value}
    />

    <PreferencesAuthCard
      hasPassword={prefs.auth.has_password}
      {newPassword}
      onpasswordchange={(value) => newPassword = value}
    />

    <PersonalityEditor
      editor={{
        rawMode: personalityRawMode,
        personalityContent,
        guidedPersonality,
        guidedCommStyle,
        guidedInterests,
        guidedUserContext,
        savingPersonality,
        personalityMessage,
      }}
      ontogglerawmode={(value) => personalityRawMode = value}
      onpersonalitycontentchange={(value) => personalityContent = value}
      onguidedpersonalitychange={(value) => guidedPersonality = value}
      onguidedcommstylechange={(value) => guidedCommStyle = value}
      onguidedinterestschange={(value) => guidedInterests = value}
      onguidedusercontextchange={(value) => guidedUserContext = value}
      onsave={savePersonality}
      onreset={resetPersonality}
    />

    <McpServersEditor
      servers={mcpServers}
      draft={{ newServerName, newServerType, newServerUrl, newServerCommand, newServerArgs }}
      message={mcpMessage}
      onservernamechange={(value) => newServerName = value}
      onservertypechange={(value) => newServerType = value}
      onserverurlchange={(value) => newServerUrl = value}
      onservercommandchange={(value) => newServerCommand = value}
      onserverargschange={(value) => newServerArgs = value}
      onaddserver={addMcpServer}
      onremoveserver={removeMcpServer}
    />

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

  :global(.section) {
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  :global(.section:last-of-type) {
    border-bottom: none;
  }

  :global(.section-title) {
    font-family: var(--font-heading);
    font-size: 0.9375rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.375rem;
  }

  :global(.section-desc) {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin: 0 0 1rem;
    line-height: 1.5;
  }

  :global(.field) {
    margin-bottom: 1rem;
  }

  :global(.field-label) {
    display: block;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    margin-bottom: 0.375rem;
    letter-spacing: 0.02em;
  }

  :global(.field-input),
  :global(.field-select) {
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

  :global(.field-input:focus),
  :global(.field-select:focus) {
    outline: none;
    border-color: var(--gold-dim);
    box-shadow: 0 0 0 2px rgba(196, 168, 114, 0.08);
  }

  :global(.field-hint) {
    display: block;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  :global(.toggle-row) {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.75rem 0;
    cursor: pointer;
    border-bottom: 1px solid var(--border);
  }

  :global(.toggle-row:last-of-type) {
    border-bottom: none;
  }

  :global(.toggle-row input[type="checkbox"]) {
    margin-top: 0.125rem;
    width: 1rem;
    height: 1rem;
    accent-color: var(--gold);
    flex-shrink: 0;
  }

  :global(.toggle-label) {
    font-size: 0.875rem;
    color: var(--text-primary);
    min-width: 5rem;
    flex-shrink: 0;
  }

  :global(.toggle-desc) {
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

  :global(.setup-guide) {
    margin: 0.5rem 0 1rem 1.75rem;
    padding: 1rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-left: 2px solid var(--gold-dim);
    border-radius: 6px;
  }

  :global(.guide-title) {
    font-family: var(--font-heading);
    font-size: 0.8125rem;
    font-weight: 400;
    color: var(--text-accent);
    letter-spacing: 0.04em;
    margin: 0 0 0.75rem;
  }

  :global(.guide-steps) {
    margin: 0;
    padding-left: 1.25rem;
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  :global(.guide-steps li) {
    margin-bottom: 0.5rem;
  }

  :global(.guide-steps a) {
    color: var(--gold);
    text-decoration: none;
    border-bottom: 1px solid var(--gold-dim);
  }

  :global(.guide-steps a:hover) {
    border-bottom-color: var(--gold);
  }

  :global(.guide-steps code) {
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.75rem;
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--gold);
  }

  :global(.guide-code) {
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
