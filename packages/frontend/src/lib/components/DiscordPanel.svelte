<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/utils/api';
  import DiscordPairingsPanel from '$lib/components/discord-panel/DiscordPairingsPanel.svelte';
  import DiscordSettingsCard from '$lib/components/discord-panel/DiscordSettingsCard.svelte';
  import DiscordStatusCard from '$lib/components/discord-panel/DiscordStatusCard.svelte';

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

  interface DiscordSettings {
    ownerUserId: string;
    requireMentionInGuilds: boolean;
    debounceMs: number;
    pairingExpiryMs: number;
    ownerActiveThresholdMin: number;
    deferPollIntervalMs: number;
    deferMaxAgeMs: number;
    allowedUsers: string[];
    allowedGuilds: string[];
    activeChannels: string[];
  }

  interface ServerRule {
    id: string;
    name: string;
    context: string;
    requireMention?: boolean;
    ignoredChannels?: string[];
    ignoredUsers?: string[];
    allowPublicResponses?: boolean;
    muted?: boolean;
  }

  interface GuildInfo {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
  }

  interface ChannelInfo {
    id: string;
    name: string;
    type: number;
    parentId: string | null;
    parentName: string | null;
  }

  interface ChannelRule {
    id: string;
    name: string;
    serverId: string;
    context?: string;
    requireMention?: boolean;
    alwaysListen?: boolean;
    ignore?: boolean;
    readOnly?: boolean;
  }

  interface UserRule {
    id: string;
    name: string;
    context?: string;
    allowedServers?: string[];
    blockedServers?: string[];
    trustLevel: 'full' | 'standard' | 'limited';
    relationship?: string;
  }

  interface RulesData {
    servers: Record<string, ServerRule>;
    channels: Record<string, ChannelRule>;
    users: Record<string, UserRule>;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let statusMessage = $state<string | null>(null);
  let discordStatus = $state<DiscordStatus | null>(null);
  let pendingPairings = $state<PairingEntry[]>([]);
  let approvedPairings = $state<PairingEntry[]>([]);
  let actionLoading = $state<string | null>(null);
  let toggling = $state(false);

  // Settings state
  let settings = $state<DiscordSettings | null>(null);
  let settingsLoading = $state(false);
  let settingsDirty = $state(false);

  // Rules state
  let rules = $state<RulesData | null>(null);
  let rulesLoading = $state(false);
  let expandedRules = $state<Set<string>>(new Set());

  // Guild & channel selector state
  let guilds = $state<GuildInfo[]>([]);
  let guildChannels = $state<Record<string, ChannelInfo[]>>({});
  let guildsLoading = $state(false);
  let channelsLoading = $state<string | null>(null);
  let pingResult = $state<number | null>(null);
  let pingLoading = $state(false);
  let serverRules = $state<Record<string, ServerRule>>({});

  // Activity log state
  interface LogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    event: string;
    detail?: string;
  }
  let activityLogs = $state<LogEntry[]>([]);
  let logsLoading = $state(false);
  let showLogs = $state(false);
  let logsTimer: ReturnType<typeof setInterval> | null = null;

  // Section collapse state
  let showSettings = $state(false);
  let showRules = $state(false);
  let rulesSection = $state<'servers' | 'channels' | 'users'>('servers');

  // Add rule form state
  let addingRule = $state<string | null>(null);
  let newRuleId = $state('');
  let newRuleName = $state('');

  let isEnabled = $derived(discordStatus?.enabled ?? false);

  type DiscordSettingsField =
    | 'ownerUserId'
    | 'requireMentionInGuilds'
    | 'debounceMs'
    | 'pairingExpiryMs'
    | 'ownerActiveThresholdMin'
    | 'deferPollIntervalMs'
    | 'deferMaxAgeMs'
    | 'allowedUsers';

  async function loadData() {
    try {
      // ORDER: load status and pairings together so the panel reflects one coherent gateway snapshot.
      const [statusRes, pairingsRes] = await Promise.all([
        apiFetch('/api/discord/status'),
        apiFetch('/api/discord/pairings'),
      ]);

      if (statusRes.ok) {
        discordStatus = await statusRes.json();
      }

      if (pairingsRes.ok) {
        const data = await pairingsRes.json();
        pendingPairings = data.pending || [];
        approvedPairings = data.approved || [];
      }
    } catch {
      error = 'Failed to load Discord status';
    } finally {
      loading = false;
    }
  }

  async function loadLogs() {
    logsLoading = true;
    try {
      const res = await apiFetch('/api/discord/logs?limit=100');
      if (res.ok) {
        activityLogs = await res.json();
      }
    } catch {
      // silent — non-critical
    } finally {
      logsLoading = false;
    }
  }

  function toggleLogs() {
    showLogs = !showLogs;
    if (showLogs) {
      loadLogs();
      logsTimer = setInterval(loadLogs, 10000);
    } else if (logsTimer) {
      clearInterval(logsTimer);
      logsTimer = null;
    }
  }

  function formatLogTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatLogDate(iso: string): string {
    const d = new Date(iso);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  async function loadSettings() {
    settingsLoading = true;
    try {
      const res = await apiFetch('/api/discord/settings');
      if (res.ok) {
        settings = await res.json();
        settingsDirty = false;
      }
    } catch {
      error = 'Failed to load Discord settings';
    } finally {
      settingsLoading = false;
    }
  }

  async function saveSettings() {
    if (!settings) return;
    settingsLoading = true;
    error = null;
    try {
      const res = await apiFetch('/api/discord/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      const data = await res.json();
      settings = data;
      settingsDirty = false;
      statusMessage = 'Settings saved';
      setTimeout(() => statusMessage = null, 3000);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save settings';
    } finally {
      settingsLoading = false;
    }
  }

  async function loadRules() {
    rulesLoading = true;
    try {
      const res = await apiFetch('/api/discord/rules');
      if (res.ok) {
        rules = await res.json();
      }
    } catch {
      error = 'Failed to load Discord rules';
    } finally {
      rulesLoading = false;
    }
  }

  async function saveRule(type: 'server' | 'channel' | 'user', rule: ServerRule | ChannelRule | UserRule) {
    actionLoading = `save-${type}-${rule.id}`;
    error = null;
    try {
      const res = await apiFetch(`/api/discord/rules/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      statusMessage = `${type.charAt(0).toUpperCase() + type.slice(1)} rule saved`;
      setTimeout(() => statusMessage = null, 3000);
      await loadRules();
    } catch (err) {
      error = err instanceof Error ? err.message : `Failed to save ${type} rule`;
    } finally {
      actionLoading = null;
    }
  }

  async function deleteRule(type: 'server' | 'channel' | 'user', id: string) {
    actionLoading = `delete-${type}-${id}`;
    error = null;
    try {
      const res = await apiFetch(`/api/discord/rules/${type}/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Delete failed');
      }
      statusMessage = `${type.charAt(0).toUpperCase() + type.slice(1)} rule deleted`;
      setTimeout(() => statusMessage = null, 3000);
      expandedRules.delete(`${type}-${id}`);
      expandedRules = new Set(expandedRules);
      await loadRules();
    } catch (err) {
      error = err instanceof Error ? err.message : `Failed to delete ${type} rule`;
    } finally {
      actionLoading = null;
    }
  }

  function toggleRule(key: string) {
    if (expandedRules.has(key)) {
      expandedRules.delete(key);
    } else {
      expandedRules.add(key);
    }
    expandedRules = new Set(expandedRules);
  }

  function startAddRule(type: string) {
    addingRule = type;
    newRuleId = '';
    newRuleName = '';
  }

  function cancelAddRule() {
    addingRule = null;
    newRuleId = '';
    newRuleName = '';
  }

  async function confirmAddRule() {
    if (!newRuleId || !newRuleName || !addingRule) return;
    const type = addingRule;

    let rule: ServerRule | ChannelRule | UserRule;
    if (type === 'server') {
      rule = { id: newRuleId, name: newRuleName, context: '', requireMention: true } as ServerRule;
    } else if (type === 'channel') {
      rule = { id: newRuleId, name: newRuleName, serverId: '' } as ChannelRule;
    } else {
      rule = { id: newRuleId, name: newRuleName, trustLevel: 'standard' as const } as UserRule;
    }

    await saveRule(type as 'server' | 'channel' | 'user', rule);
    expandedRules.add(`${type}-${newRuleId}`);
    expandedRules = new Set(expandedRules);
    cancelAddRule();
  }

  async function toggleDiscord() {
    toggling = true;
    error = null;
    const newState = !isEnabled;
    try {
      const res = await apiFetch('/api/discord/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newState }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Toggle failed');
      }
      statusMessage = newState ? 'Discord gateway starting...' : 'Discord gateway stopped';
      setTimeout(() => statusMessage = null, 3000);
      if (newState) {
        // ORDER: wait 2000ms for gateway state to materialize before refetching status after enabling.
        await new Promise(r => setTimeout(r, 2000));
      }
      await loadData();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to toggle Discord';
    } finally {
      toggling = false;
    }
  }

  async function approvePairing(code: string) {
    actionLoading = `approve-${code}`;
    error = null;
    try {
      const res = await apiFetch(`/api/discord/pairings/${code}/approve`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Approval failed');
      }
      statusMessage = 'Pairing approved';
      setTimeout(() => statusMessage = null, 3000);
      await loadData();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to approve';
    } finally {
      actionLoading = null;
    }
  }

  async function revokePairing(userId: string) {
    actionLoading = `revoke-${userId}`;
    error = null;
    try {
      const res = await apiFetch(`/api/discord/pairings/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Revocation failed');
      }
      statusMessage = 'Access revoked';
      setTimeout(() => statusMessage = null, 3000);
      await loadData();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to revoke';
    } finally {
      actionLoading = null;
    }
  }

  async function loadGuilds() {
    guildsLoading = true;
    try {
      const res = await apiFetch('/api/discord/guilds');
      if (res.ok) {
        guilds = await res.json();
        // Load rules to get per-guild muted/public state
        const rulesRes = await apiFetch('/api/discord/rules');
        if (rulesRes.ok) {
          const data = await rulesRes.json();
          serverRules = data.servers || {};
        }
        // Auto-enable all guilds on first setup (empty allowlist = new install)
        if (settings && settings.allowedGuilds.length === 0 && guilds.length > 0) {
          settings.allowedGuilds = guilds.map(g => g.id);
          settingsDirty = true;
          await saveSettings();
        }
      }
    } catch {
      // non-critical
    } finally {
      guildsLoading = false;
    }
  }

  async function loadChannelsForGuild(guildId: string) {
    if (guildChannels[guildId]) return;
    channelsLoading = guildId;
    try {
      const res = await apiFetch(`/api/discord/guilds/${guildId}/channels`);
      if (res.ok) {
        const channels: ChannelInfo[] = await res.json();
        guildChannels[guildId] = channels;
        guildChannels = { ...guildChannels };
        // Auto-enable all channels on first load (empty activeChannels = new setup)
        if (settings && settings.activeChannels.length === 0 && channels.length > 0) {
          settings.activeChannels = channels.map(c => c.id);
          settingsDirty = true;
          await saveSettings();
        }
      }
    } catch {
      // non-critical
    } finally {
      channelsLoading = null;
    }
  }

  async function testConnection() {
    pingLoading = true;
    pingResult = null;
    try {
      const res = await apiFetch('/api/discord/ping');
      if (res.ok) {
        const data = await res.json();
        pingResult = data.ping;
      }
    } catch {
      pingResult = -1;
    } finally {
      pingLoading = false;
    }
  }

  async function autoDetectOwner() {
    try {
      const res = await apiFetch('/api/discord/owner-id');
      if (res.ok) {
        const data = await res.json();
        if (data.ownerId && settings) {
          settings.ownerUserId = data.ownerId;
          settingsDirty = true;
          statusMessage = 'Owner ID detected';
          setTimeout(() => statusMessage = null, 3000);
        }
      }
    } catch {
      // silent
    }
  }

  function toggleGuild(guildId: string) {
    if (!settings) return;
    const idx = settings.allowedGuilds.indexOf(guildId);
    if (idx >= 0) {
      settings.allowedGuilds = settings.allowedGuilds.filter(id => id !== guildId);
    } else {
      settings.allowedGuilds = [...settings.allowedGuilds, guildId];
    }
    settingsDirty = true;
  }

  function toggleChannel(channelId: string) {
    if (!settings) return;
    const idx = settings.activeChannels.indexOf(channelId);
    if (idx >= 0) {
      settings.activeChannels = settings.activeChannels.filter(id => id !== channelId);
    } else {
      settings.activeChannels = [...settings.activeChannels, channelId];
    }
    settingsDirty = true;
  }

  async function toggleGuildRule(guildId: string, field: 'muted' | 'allowPublicResponses', value: boolean) {
    try {
      const res = await apiFetch(`/api/discord/guilds/${guildId}/rule`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        const data = await res.json();
        serverRules[guildId] = data.rule;
        serverRules = { ...serverRules };
      }
    } catch {
      // silent
    }
  }

  function updateSettingsField(key: DiscordSettingsField, value: string | boolean | number | string[]) {
    if (!settings) return;

    settings = {
      ...settings,
      [key]: value,
    };
    settingsDirty = true;
  }

  onMount(async () => {
    // ORDER: load guilds and settings only after status confirms the gateway is connected.
    await loadData();
    if (discordStatus?.connected) {
      loadGuilds();
      loadSettings();
    }
  });
</script>

<div class="discord-panel">
  {#if loading}
    <p class="loading">Loading Discord status...</p>
  {:else}
    <DiscordStatusCard
      {discordStatus}
      {isEnabled}
      {toggling}
      {pingLoading}
      {pingResult}
      ontoggle={toggleDiscord}
      ontestconnection={testConnection}
    />

    <!-- Activity Log -->
    {#if isEnabled}
      <section class="section">
        <button class="collapsible-header" onclick={toggleLogs}>
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
    {/if}

    <DiscordPairingsPanel
      {pendingPairings}
      {approvedPairings}
      {actionLoading}
      onapprove={approvePairing}
      onrevoke={revokePairing}
    />

    <DiscordSettingsCard
      settings={settings && {
        ownerUserId: settings.ownerUserId,
        requireMentionInGuilds: settings.requireMentionInGuilds,
        debounceMs: settings.debounceMs,
        pairingExpiryMs: settings.pairingExpiryMs,
        ownerActiveThresholdMin: settings.ownerActiveThresholdMin,
        deferPollIntervalMs: settings.deferPollIntervalMs,
        deferMaxAgeMs: settings.deferMaxAgeMs,
        allowedUsers: settings.allowedUsers,
      }}
      {settingsLoading}
      {settingsDirty}
      {showSettings}
      ontoggleopen={() => {
        // ORDER: flip open state before lazy-loading so the loading UI appears immediately on first expand.
        showSettings = !showSettings;
        if (showSettings && !settings) loadSettings();
      }}
      onupdatefield={updateSettingsField}
      onsave={saveSettings}
      onautodetectowner={autoDetectOwner}
    >
      <div class="form-group">
        <span class="form-label">Servers</span>
        <span class="form-hint">Toggle servers ON where the bot should respond. OFF = bot ignores that server entirely.</span>
        {#if guildsLoading}
          <p class="form-hint">Loading servers...</p>
        {:else if guilds.length > 0 && settings}
          <div class="selector-list">
            {#each guilds as guild}
              {@const isAllowed = settings.allowedGuilds.includes(guild.id)}
              {@const guildRule = serverRules[guild.id]}
              <div class="selector-item" class:active={settings.allowedGuilds.includes(guild.id)}>
                <div class="selector-main" role="button" tabindex="0" onclick={() => toggleGuild(guild.id)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleGuild(guild.id); }}>
                  {#if guild.icon}
                    <img class="guild-icon" src={guild.icon} alt="" />
                  {:else}
                    <span class="guild-icon-fallback">{guild.name.charAt(0)}</span>
                  {/if}
                  <div class="selector-info">
                    <span class="selector-name">{guild.name}</span>
                    <span class="selector-meta">{guild.memberCount} members</span>
                  </div>
                  <button
                    class="toggle-switch small"
                    class:on={settings.allowedGuilds.includes(guild.id)}
                    aria-label="Restrict to {guild.name}"
                    onclick={(e) => { e.stopPropagation(); toggleGuild(guild.id); }}
                  >
                    <span class="toggle-knob"></span>
                  </button>
                </div>
                {#if isAllowed}
                  <div class="guild-options">
                    <div class="guild-option-block">
                      <div class="guild-option-row">
                        <span class="guild-option-label">Anyone can talk</span>
                        <button
                          class="toggle-switch tiny"
                          class:on={guildRule?.allowPublicResponses}
                          aria-label="Let anyone talk in {guild.name}"
                          onclick={() => toggleGuildRule(guild.id, 'allowPublicResponses', !guildRule?.allowPublicResponses)}
                        >
                          <span class="toggle-knob"></span>
                        </button>
                      </div>
                      <span class="guild-option-desc">
                        {guildRule?.allowPublicResponses
                          ? 'Anyone in this server can message the bot'
                          : 'Only the owner and approved users get responses'}
                      </span>
                    </div>
                    <div class="guild-option-block">
                      <div class="guild-option-row">
                        <span class="guild-option-label">Silence bot</span>
                        <button
                          class="toggle-switch tiny"
                          class:on={guildRule?.muted}
                          aria-label="Silence bot in {guild.name}"
                          onclick={() => toggleGuildRule(guild.id, 'muted', !guildRule?.muted)}
                        >
                          <span class="toggle-knob"></span>
                        </button>
                      </div>
                      <span class="guild-option-desc">
                        {guildRule?.muted
                          ? 'Bot is silent - won\'t auto-respond to anything here'
                          : 'Bot is active and will respond normally'}
                      </span>
                    </div>
                  </div>

                  <div class="channel-section">
                    <button class="channel-expand" onclick={() => loadChannelsForGuild(guild.id)}>
                      {guildChannels[guild.id] ? '▾' : '▸'} Channels
                    </button>
                    <span class="form-hint channel-hint">Toggle channels ON where the bot can respond. OFF = bot ignores that channel.</span>
                    {#if channelsLoading === guild.id}
                      <p class="form-hint">Loading channels...</p>
                    {/if}
                    {#if guildChannels[guild.id]}
                      <div class="channel-list">
                        {#each guildChannels[guild.id] as channel}
                          <div class="channel-item">
                            <span class="channel-name"># {channel.name}</span>
                            {#if channel.parentName}
                              <span class="channel-category">{channel.parentName}</span>
                            {/if}
                            <button
                              class="toggle-switch tiny"
                              class:on={settings.activeChannels.includes(channel.id)}
                              aria-label="Always listen in #{channel.name}"
                              onclick={() => toggleChannel(channel.id)}
                            >
                              <span class="toggle-knob"></span>
                            </button>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
          {#if settings.allowedGuilds.length === 0}
            <span class="form-hint warning-hint">No servers enabled - bot won't respond in any server</span>
          {/if}
        {:else}
          <span class="form-hint">No servers found - is the bot in any servers?</span>
        {/if}
      </div>
    </DiscordSettingsCard>

    <!-- Rules Editor -->
    <section class="section">
      <button class="collapsible-header" onclick={() => { showRules = !showRules; if (showRules && !rules) loadRules(); }}>
        <h3 class="section-title">Rules</h3>
        <span class="chevron" class:open={showRules}>&#9656;</span>
      </button>

      {#if showRules}
        {#if rulesLoading && !rules}
          <p class="loading">Loading rules...</p>
        {:else if rules}
          <!-- Rules sub-tabs -->
          <nav class="rules-tabs">
            <button class="rules-tab" class:active={rulesSection === 'servers'} onclick={() => rulesSection = 'servers'}>
              Servers ({Object.keys(rules.servers).length})
            </button>
            <button class="rules-tab" class:active={rulesSection === 'channels'} onclick={() => rulesSection = 'channels'}>
              Channels ({Object.keys(rules.channels).length})
            </button>
            <button class="rules-tab" class:active={rulesSection === 'users'} onclick={() => rulesSection = 'users'}>
              Users ({Object.keys(rules.users).length})
            </button>
          </nav>

          <!-- Server Rules -->
          {#if rulesSection === 'servers'}
            <div class="rules-list">
              {#each Object.values(rules.servers) as rule (rule.id)}
                {@const key = `server-${rule.id}`}
                <div class="rule-card">
                  <button class="rule-header" onclick={() => toggleRule(key)}>
                    <span class="rule-name">{rule.name}</span>
                    <span class="rule-id">{rule.id}</span>
                    <span class="chevron small" class:open={expandedRules.has(key)}>&#9656;</span>
                  </button>
                  {#if expandedRules.has(key)}
                    <div class="rule-body">
                      <label class="form-group">
                        <span class="form-label">Name</span>
                        <input type="text" class="form-input" bind:value={rule.name} />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Context</span>
                        <textarea class="form-textarea" bind:value={rule.context} rows="4"></textarea>
                      </label>
                      <div class="form-group">
                        <span class="form-label">Require @mention</span>
                        <button class="toggle-switch small" class:on={rule.requireMention ?? true} aria-label="Require @mention" aria-pressed={rule.requireMention ?? true} onclick={() => rule.requireMention = !(rule.requireMention ?? true)}>
                          <span class="toggle-knob"></span>
                        </button>
                      </div>
                      <div class="form-group">
                        <span class="form-label">Allow public responses</span>
                        <button class="toggle-switch small" class:on={rule.allowPublicResponses ?? false} aria-label="Allow public responses" aria-pressed={rule.allowPublicResponses ?? false} onclick={() => rule.allowPublicResponses = !(rule.allowPublicResponses ?? false)}>
                          <span class="toggle-knob"></span>
                        </button>
                      </div>
                      <label class="form-group">
                        <span class="form-label">Ignored channels (IDs)</span>
                        <input type="text" class="form-input"
                          value={(rule.ignoredChannels || []).join(', ')}
                          onchange={(e) => rule.ignoredChannels = (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)}
                        />
                      </label>
                      <div class="rule-actions">
                        <button class="btn btn-primary" onclick={() => saveRule('server', rule)} disabled={actionLoading === `save-server-${rule.id}`}>
                          {actionLoading === `save-server-${rule.id}` ? 'Saving...' : 'Save'}
                        </button>
                        <button class="btn btn-danger" onclick={() => deleteRule('server', rule.id)} disabled={actionLoading === `delete-server-${rule.id}`}>
                          {actionLoading === `delete-server-${rule.id}` ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
              {#if addingRule === 'server'}
                <div class="rule-card add-form">
                  <label class="form-group">
                    <span class="form-label">Server ID</span>
                    <input type="text" class="form-input" bind:value={newRuleId} placeholder="Discord server ID" />
                  </label>
                  <label class="form-group">
                    <span class="form-label">Name</span>
                    <input type="text" class="form-input" bind:value={newRuleName} placeholder="Server name" />
                  </label>
                  <div class="rule-actions">
                    <button class="btn btn-primary" onclick={confirmAddRule} disabled={!newRuleId || !newRuleName}>Add</button>
                    <button class="btn btn-muted" onclick={cancelAddRule}>Cancel</button>
                  </div>
                </div>
              {:else}
                <button class="btn btn-muted add-btn" onclick={() => startAddRule('server')}>+ Add server rule</button>
              {/if}
            </div>
          {/if}

          <!-- Channel Rules -->
          {#if rulesSection === 'channels'}
            <div class="rules-list">
              {#each Object.values(rules.channels) as rule (rule.id)}
                {@const key = `channel-${rule.id}`}
                <div class="rule-card">
                  <button class="rule-header" onclick={() => toggleRule(key)}>
                    <span class="rule-name">#{rule.name}</span>
                    <span class="rule-id">{rule.id}</span>
                    <span class="chevron small" class:open={expandedRules.has(key)}>&#9656;</span>
                  </button>
                  {#if expandedRules.has(key)}
                    <div class="rule-body">
                      <label class="form-group">
                        <span class="form-label">Name</span>
                        <input type="text" class="form-input" bind:value={rule.name} />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Server ID</span>
                        <input type="text" class="form-input" bind:value={rule.serverId} />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Context</span>
                        <textarea class="form-textarea" bind:value={rule.context} rows="3"></textarea>
                      </label>
                      <div class="form-group inline-toggles">
                        <div class="toggle-item">
                          <span class="form-label">Require @mention</span>
                          <button class="toggle-switch small" class:on={rule.requireMention ?? false} aria-label="Require @mention" aria-pressed={rule.requireMention ?? false} onclick={() => rule.requireMention = !(rule.requireMention ?? false)}>
                            <span class="toggle-knob"></span>
                          </button>
                        </div>
                        <div class="toggle-item">
                          <span class="form-label">Always listen</span>
                          <button class="toggle-switch small" class:on={rule.alwaysListen ?? false} aria-label="Always listen" aria-pressed={rule.alwaysListen ?? false} onclick={() => rule.alwaysListen = !(rule.alwaysListen ?? false)}>
                            <span class="toggle-knob"></span>
                          </button>
                        </div>
                        <div class="toggle-item">
                          <span class="form-label">Ignore</span>
                          <button class="toggle-switch small" class:on={rule.ignore ?? false} aria-label="Ignore" aria-pressed={rule.ignore ?? false} onclick={() => rule.ignore = !(rule.ignore ?? false)}>
                            <span class="toggle-knob"></span>
                          </button>
                        </div>
                        <div class="toggle-item">
                          <span class="form-label">Read-only</span>
                          <button class="toggle-switch small" class:on={rule.readOnly ?? false} aria-label="Read-only" aria-pressed={rule.readOnly ?? false} onclick={() => rule.readOnly = !(rule.readOnly ?? false)}>
                            <span class="toggle-knob"></span>
                          </button>
                        </div>
                      </div>
                      <div class="rule-actions">
                        <button class="btn btn-primary" onclick={() => saveRule('channel', rule)} disabled={actionLoading === `save-channel-${rule.id}`}>
                          {actionLoading === `save-channel-${rule.id}` ? 'Saving...' : 'Save'}
                        </button>
                        <button class="btn btn-danger" onclick={() => deleteRule('channel', rule.id)} disabled={actionLoading === `delete-channel-${rule.id}`}>
                          {actionLoading === `delete-channel-${rule.id}` ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
              {#if addingRule === 'channel'}
                <div class="rule-card add-form">
                  <label class="form-group">
                    <span class="form-label">Channel ID</span>
                    <input type="text" class="form-input" bind:value={newRuleId} placeholder="Discord channel ID" />
                  </label>
                  <label class="form-group">
                    <span class="form-label">Name</span>
                    <input type="text" class="form-input" bind:value={newRuleName} placeholder="Channel name" />
                  </label>
                  <div class="rule-actions">
                    <button class="btn btn-primary" onclick={confirmAddRule} disabled={!newRuleId || !newRuleName}>Add</button>
                    <button class="btn btn-muted" onclick={cancelAddRule}>Cancel</button>
                  </div>
                </div>
              {:else}
                <button class="btn btn-muted add-btn" onclick={() => startAddRule('channel')}>+ Add channel rule</button>
              {/if}
            </div>
          {/if}

          <!-- User Rules -->
          {#if rulesSection === 'users'}
            <div class="rules-list">
              {#each Object.values(rules.users) as rule (rule.id)}
                {@const key = `user-${rule.id}`}
                <div class="rule-card">
                  <button class="rule-header" onclick={() => toggleRule(key)}>
                    <span class="rule-name">{rule.name}</span>
                    <span class="rule-id">{rule.id}</span>
                    <span class="chevron small" class:open={expandedRules.has(key)}>&#9656;</span>
                  </button>
                  {#if expandedRules.has(key)}
                    <div class="rule-body">
                      <label class="form-group">
                        <span class="form-label">Name</span>
                        <input type="text" class="form-input" bind:value={rule.name} />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Trust level</span>
                        <select class="form-input" bind:value={rule.trustLevel}>
                          <option value="full">Full</option>
                          <option value="standard">Standard</option>
                          <option value="limited">Limited</option>
                        </select>
                      </label>
                      <label class="form-group">
                        <span class="form-label">Relationship</span>
                        <input type="text" class="form-input" bind:value={rule.relationship} />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Context</span>
                        <textarea class="form-textarea" bind:value={rule.context} rows="3"></textarea>
                      </label>
                      <label class="form-group">
                        <span class="form-label">Allowed servers (IDs)</span>
                        <input type="text" class="form-input"
                          value={(rule.allowedServers || []).join(', ')}
                          onchange={(e) => rule.allowedServers = (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)}
                        />
                      </label>
                      <label class="form-group">
                        <span class="form-label">Blocked servers (IDs)</span>
                        <input type="text" class="form-input"
                          value={(rule.blockedServers || []).join(', ')}
                          onchange={(e) => rule.blockedServers = (e.target as HTMLInputElement).value.split(',').map(s => s.trim()).filter(Boolean)}
                        />
                      </label>
                      <div class="rule-actions">
                        <button class="btn btn-primary" onclick={() => saveRule('user', rule)} disabled={actionLoading === `save-user-${rule.id}`}>
                          {actionLoading === `save-user-${rule.id}` ? 'Saving...' : 'Save'}
                        </button>
                        <button class="btn btn-danger" onclick={() => deleteRule('user', rule.id)} disabled={actionLoading === `delete-user-${rule.id}`}>
                          {actionLoading === `delete-user-${rule.id}` ? 'Deleting...' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/each}
              {#if addingRule === 'user'}
                <div class="rule-card add-form">
                  <label class="form-group">
                    <span class="form-label">User ID</span>
                    <input type="text" class="form-input" bind:value={newRuleId} placeholder="Discord user ID" />
                  </label>
                  <label class="form-group">
                    <span class="form-label">Name</span>
                    <input type="text" class="form-input" bind:value={newRuleName} placeholder="User name" />
                  </label>
                  <div class="rule-actions">
                    <button class="btn btn-primary" onclick={confirmAddRule} disabled={!newRuleId || !newRuleName}>Add</button>
                    <button class="btn btn-muted" onclick={cancelAddRule}>Cancel</button>
                  </div>
                </div>
              {:else}
                <button class="btn btn-muted add-btn" onclick={() => startAddRule('user')}>+ Add user rule</button>
              {/if}
            </div>
          {/if}
        {/if}
      {/if}
    </section>

    <!-- Status / Error -->
    {#if statusMessage}
      <p class="status-msg">{statusMessage}</p>
    {/if}
    {#if error}
      <p class="error-msg">{error}</p>
    {/if}
  {/if}
</div>

<style>
  .discord-panel {
    max-width: 40rem;
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
    font-style: italic;
    text-align: center;
    padding: 2rem;
  }

  /* --- Setup Guide --- */
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

  .intent-list {
    margin: 0.375rem 0 0.25rem 1.25rem;
    padding: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
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

  /* Collapsible header */
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

  .chevron.small {
    font-size: 0.625rem;
  }

  /* Toggle switch */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .toggle-row.compact {
    justify-content: flex-start;
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

  /* Status */
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


  /* Buttons */
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

  .btn-muted {
    background: transparent;
    color: var(--text-muted);
    border-color: var(--border);
  }

  .btn-muted:hover:not(:disabled) {
    color: var(--text-secondary);
    border-color: var(--text-muted);
  }

  .save-btn {
    margin-top: 0.75rem;
  }

  .add-btn {
    margin-top: 0.5rem;
    width: 100%;
    text-align: center;
    padding: 0.5rem;
  }

  /* Settings form */
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

  .form-input, .form-textarea {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.8125rem;
    padding: 0.5rem 0.625rem;
    font-family: inherit;
    transition: border-color var(--transition);
  }

  .form-input:focus, .form-textarea:focus {
    outline: none;
    border-color: var(--border-hover);
  }

  .form-textarea {
    resize: vertical;
    min-height: 3rem;
  }

  select.form-input {
    cursor: pointer;
  }

  .form-hint {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .inline-toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    flex-direction: row;
  }

  .toggle-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .toggle-item .form-label {
    margin: 0;
  }

  /* Rules */
  .rules-tabs {
    display: flex;
    gap: 0;
    margin: 0.75rem 0 0.5rem;
    border-bottom: 1px solid var(--border);
  }

  .rules-tab {
    padding: 0.5rem 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    transition: all var(--transition);
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    cursor: pointer;
    letter-spacing: 0.02em;
  }

  .rules-tab:hover {
    color: var(--text-secondary);
  }

  .rules-tab.active {
    color: var(--text-primary);
    background: var(--bg-active);
    border-bottom-color: transparent;
    border-radius: var(--radius-sm);
  }

  .rules-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.5rem;
  }

  .rule-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .rule-card.add-form {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .rule-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.75rem;
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }

  .rule-header:hover {
    background: var(--bg-hover);
  }

  .rule-name {
    font-size: 0.8125rem;
    color: var(--text-primary);
    flex: 1;
  }

  .rule-id {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-family: var(--font-mono, monospace);
  }

  .rule-body {
    padding: 0.75rem;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .rule-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .status-msg {
    font-size: 0.8125rem;
    color: #22c55e;
    margin-top: 0.75rem;
  }

  .error-msg {
    font-size: 0.8125rem;
    color: #ef4444;
    margin-top: 0.75rem;
  }

  /* Activity log */
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

  @media (max-width: 768px) {
    .stats-grid {
      grid-template-columns: repeat(3, 1fr);
    }

    .pairing-card {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }

    .btn {
      text-align: center;
    }

    .inline-toggles {
      flex-direction: column;
      gap: 0.5rem;
    }
  }

  /* --- Connection banner --- */
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

  /* --- Badge --- */
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

  /* --- Input with button --- */
  .input-with-button {
    display: flex;
    gap: 0.375rem;
    align-items: center;
  }

  /* --- Server/Channel Selectors --- */
  .selector-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.375rem;
  }

  .selector-item {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    overflow: hidden;
    background: var(--bg-secondary);
  }

  .selector-item.active {
    border-color: var(--accent, #7c5cbf);
  }

  .selector-main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
  }

  .selector-main:hover {
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
  }

  .guild-icon {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .guild-icon-fallback {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 50%;
    background: var(--bg-tertiary, var(--bg-secondary));
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .selector-info {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .selector-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .selector-meta {
    font-size: 0.6875rem;
    color: var(--text-muted);
  }

  .channel-hint {
    display: block;
    margin-bottom: 0.25rem;
  }

  .warning-hint {
    color: #f59e0b;
  }

  .guild-options {
    display: flex;
    gap: 1rem;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid var(--border);
    background: var(--bg-tertiary, rgba(255,255,255,0.02));
  }

  .guild-option-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .guild-option-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .guild-option-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .guild-option-desc {
    font-size: 0.625rem;
    color: var(--text-muted);
    line-height: 1.3;
  }

  .channel-section {
    border-top: 1px solid var(--border);
    padding: 0.375rem 0.75rem;
  }

  .channel-expand {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .channel-expand:hover {
    color: var(--text-primary);
  }

  .channel-list {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-top: 0.25rem;
  }

  .channel-item {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
  }

  .channel-item:hover {
    background: var(--bg-tertiary, rgba(255,255,255,0.03));
  }

  .channel-name {
    font-size: 0.75rem;
    color: var(--text-primary);
    font-family: var(--font-mono, monospace);
    flex: 1;
  }

  .channel-category {
    font-size: 0.625rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .toggle-switch.tiny {
    width: 28px;
    height: 16px;
    flex-shrink: 0;
  }

  .toggle-switch.tiny .toggle-knob {
    width: 10px;
    height: 10px;
    top: 2px;
    left: 2px;
  }

  .toggle-switch.tiny.on .toggle-knob {
    left: 14px;
  }
</style>

