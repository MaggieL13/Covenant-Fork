<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/utils/api';
  import DiscordActivityLogs from '$lib/components/discord-panel/DiscordActivityLogs.svelte';
  import GuildChannelBrowser from '$lib/components/discord-panel/GuildChannelBrowser.svelte';
  import DiscordPairingsPanel from '$lib/components/discord-panel/DiscordPairingsPanel.svelte';
  import DiscordRulesPanel from '$lib/components/discord-panel/DiscordRulesPanel.svelte';
  import DiscordSettingsCard from '$lib/components/discord-panel/DiscordSettingsCard.svelte';
  import DiscordStatusCard from '$lib/components/discord-panel/DiscordStatusCard.svelte';
  import ChannelRulesEditor from '$lib/components/discord-panel/ChannelRulesEditor.svelte';
  import ServerRulesEditor from '$lib/components/discord-panel/ServerRulesEditor.svelte';
  import UserRulesEditor from '$lib/components/discord-panel/UserRulesEditor.svelte';

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
      // ORDER: load logs immediately before starting the 10s polling interval when opening.
      loadLogs();
      logsTimer = setInterval(loadLogs, 10000);
    } else if (logsTimer) {
      // ORDER: clear the polling interval before nulling the timer when closing.
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
      // ORDER: remove the expansion key before reloading rules so a deleted card cannot reopen from stale expanded state.
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

    // ORDER: save the synthesized default rule before expanding/resetting the add form so the next render targets the persisted rule id.
    await saveRule(type as 'server' | 'channel' | 'user', rule);
    expandedRules.add(`${type}-${newRuleId}`);
    expandedRules = new Set(expandedRules);
    cancelAddRule();
  }

  function updateAddFormField(key: 'newRuleId' | 'newRuleName', value: string) {
    if (key === 'newRuleId') {
      newRuleId = value;
      return;
    }

    newRuleName = value;
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
      <DiscordActivityLogs
        {showLogs}
        {logsLoading}
        {activityLogs}
        ontoggleopen={toggleLogs}
        {formatLogTime}
        {formatLogDate}
      />
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
      <GuildChannelBrowser
        browser={{ guilds, guildChannels, guildsLoading, channelsLoading, serverRules }}
        selection={{
          allowedGuilds: settings?.allowedGuilds ?? [],
          activeChannels: settings?.activeChannels ?? [],
        }}
        ontoggleguild={toggleGuild}
        ontogglechannel={toggleChannel}
        ontoggleguildrule={toggleGuildRule}
        onloadchannelsforguild={loadChannelsForGuild}
      />
    </DiscordSettingsCard>

    <DiscordRulesPanel
      {showRules}
      {rulesLoading}
      {rules}
      {rulesSection}
      ontoggleopen={() => {
        // ORDER: flip showRules before lazy-loading so the loading state appears immediately.
        showRules = !showRules;
        if (showRules && !rules) loadRules();
      }}
      onselectsection={(section) => rulesSection = section}
    >
      {#if rules}
        {#if rulesSection === 'servers'}
          <ServerRulesEditor
            rules={Object.values(rules.servers)}
            {expandedRules}
            addForm={{ addingRule, newRuleId, newRuleName }}
            {actionLoading}
            ontogglerule={toggleRule}
            onsaverule={(rule) => saveRule('server', rule)}
            ondeleterule={(id) => deleteRule('server', id)}
            onstartadd={() => startAddRule('server')}
            oncanceladd={cancelAddRule}
            onconfirmadd={confirmAddRule}
            onaddformupdate={updateAddFormField}
          />
        {/if}

        {#if rulesSection === 'channels'}
          <ChannelRulesEditor
            rules={Object.values(rules.channels)}
            {expandedRules}
            addForm={{ addingRule, newRuleId, newRuleName }}
            {actionLoading}
            ontogglerule={toggleRule}
            onsaverule={(rule) => saveRule('channel', rule)}
            ondeleterule={(id) => deleteRule('channel', id)}
            onstartadd={() => startAddRule('channel')}
            oncanceladd={cancelAddRule}
            onconfirmadd={confirmAddRule}
            onaddformupdate={updateAddFormField}
          />
        {/if}

        {#if rulesSection === 'users'}
          <UserRulesEditor
            rules={Object.values(rules.users)}
            {expandedRules}
            addForm={{ addingRule, newRuleId, newRuleName }}
            {actionLoading}
            ontogglerule={toggleRule}
            onsaverule={(rule) => saveRule('user', rule)}
            ondeleterule={(id) => deleteRule('user', id)}
            onstartadd={() => startAddRule('user')}
            oncanceladd={cancelAddRule}
            onconfirmadd={confirmAddRule}
            onaddformupdate={updateAddFormField}
          />
        {/if}
      {/if}
    </DiscordRulesPanel>

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
</style>


