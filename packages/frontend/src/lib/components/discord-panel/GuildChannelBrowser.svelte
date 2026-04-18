<script lang="ts">
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

  let {
    browser,
    selection,
    ontoggleguild,
    ontogglechannel,
    ontoggleguildrule,
    onloadchannelsforguild,
  } = $props<{
    browser: {
      guilds: GuildInfo[];
      guildChannels: Record<string, ChannelInfo[]>;
      guildsLoading: boolean;
      channelsLoading: string | null;
      serverRules: Record<string, ServerRule>;
    };
    selection: {
      allowedGuilds: string[];
      activeChannels: string[];
    };
    ontoggleguild?: (guildId: string) => void;
    ontogglechannel?: (channelId: string) => void;
    ontoggleguildrule?: (guildId: string, field: 'muted' | 'allowPublicResponses', value: boolean) => void;
    onloadchannelsforguild?: (guildId: string) => void;
  }>();
</script>

<div class="form-group">
  <span class="form-label">Servers</span>
  <span class="form-hint">Toggle servers ON where the bot should respond. OFF = bot ignores that server entirely.</span>
  {#if browser.guildsLoading}
    <p class="form-hint">Loading servers...</p>
  {:else if browser.guilds.length > 0}
    <div class="selector-list">
      {#each browser.guilds as guild}
        {@const isAllowed = selection.allowedGuilds.includes(guild.id)}
        {@const guildRule = browser.serverRules[guild.id]}
        <div class="selector-item" class:active={selection.allowedGuilds.includes(guild.id)}>
          <div class="selector-main" role="button" tabindex="0" onclick={() => ontoggleguild?.(guild.id)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') ontoggleguild?.(guild.id); }}>
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
              class:on={selection.allowedGuilds.includes(guild.id)}
              aria-label="Restrict to {guild.name}"
              onclick={(e) => { e.stopPropagation(); ontoggleguild?.(guild.id); }}
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
                    onclick={() => ontoggleguildrule?.(guild.id, 'allowPublicResponses', !guildRule?.allowPublicResponses)}
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
                    onclick={() => ontoggleguildrule?.(guild.id, 'muted', !guildRule?.muted)}
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
              <button class="channel-expand" onclick={() => onloadchannelsforguild?.(guild.id)}>
                {#if browser.guildChannels[guild.id]}&#9662;{:else}&#9656;{/if} Channels
              </button>
              <span class="form-hint channel-hint">Toggle channels ON where the bot can respond. OFF = bot ignores that channel.</span>
              {#if browser.channelsLoading === guild.id}
                <p class="form-hint">Loading channels...</p>
              {/if}
              {#if browser.guildChannels[guild.id]}
                <div class="channel-list">
                  {#each browser.guildChannels[guild.id] as channel}
                    <div class="channel-item">
                      <span class="channel-name"># {channel.name}</span>
                      {#if channel.parentName}
                        <span class="channel-category">{channel.parentName}</span>
                      {/if}
                      <button
                        class="toggle-switch tiny"
                        class:on={selection.activeChannels.includes(channel.id)}
                        aria-label="Always listen in #{channel.name}"
                        onclick={() => ontogglechannel?.(channel.id)}
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
    {#if selection.allowedGuilds.length === 0}
      <span class="form-hint warning-hint">No servers enabled - bot won't respond in any server</span>
    {/if}
  {:else}
    <span class="form-hint">No servers found - is the bot in any servers?</span>
  {/if}
</div>

<style>
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

  .form-hint {
    font-size: 0.6875rem;
    color: var(--text-muted);
    font-style: italic;
  }

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

  .toggle-switch.tiny {
    width: 28px;
    height: 16px;
    flex-shrink: 0;
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





