<script lang="ts">
  interface TimezoneEntry {
    iana: string;
    city: string;
    country: string;
    countryCode: string;
    region: string;
  }

  let {
    identity,
    features,
    timezoneList,
    oncompanionnamechange,
    onusernamechange,
    ontimezonechange,
    onorchestratorchange,
    onvoicechange,
    ondiscordchange,
    ontelegramchange,
  } = $props<{
    identity: {
      companionName: string;
      userName: string;
      timezone: string;
    };
    features: {
      orchestratorEnabled: boolean;
      voiceEnabled: boolean;
      discordEnabled: boolean;
      telegramEnabled: boolean;
    };
    timezoneList: TimezoneEntry[];
    oncompanionnamechange?: (value: string) => void;
    onusernamechange?: (value: string) => void;
    ontimezonechange?: (value: string) => void;
    onorchestratorchange?: (value: boolean) => void;
    onvoicechange?: (value: boolean) => void;
    ondiscordchange?: (value: boolean) => void;
    ontelegramchange?: (value: boolean) => void;
  }>();

  // Group zones by region for <optgroup>, pre-sorted by the backend.
  // Each entry already has city + country metadata for a clean label.
  const groupedTimezones = $derived.by(() => {
    const groups = new Map<string, TimezoneEntry[]>();
    for (const entry of timezoneList) {
      if (!groups.has(entry.region)) groups.set(entry.region, []);
      groups.get(entry.region)!.push(entry);
    }
    return [...groups.entries()];
  });

  // "Paraguay · Asuncion" — country leads because nobody types-ahead by
  // city name. "P" should jump to Paraguay, "A" to Argentina, etc.
  // Zones without a country (UTC, Etc/*) show just the city/zone name.
  function tzLabel(entry: TimezoneEntry): string {
    return entry.country ? `${entry.country} · ${entry.city}` : entry.city;
  }

  // Whether the currently-saved timezone appears in the fetched list
  // (defensive — if the backend returns empty during loading, we still
  // surface the saved zone as a single option so the select isn't blank).
  const currentInList = $derived(
    timezoneList.some((e: TimezoneEntry) => e.iana === identity.timezone),
  );
</script>

<section class="section">
  <h3 class="section-title">Identity</h3>
  <p class="section-desc">Names and timezone used throughout the system.</p>

  <div class="field">
    <label class="field-label" for="pref-companion">Companion Name</label>
    <input
      id="pref-companion"
      type="text"
      class="field-input"
      value={identity.companionName}
      oninput={(event) => oncompanionnamechange?.((event.currentTarget as HTMLInputElement).value)}
      placeholder="Echo"
    />
  </div>

  <div class="field">
    <label class="field-label" for="pref-user">Your Name</label>
    <input
      id="pref-user"
      type="text"
      class="field-input"
      value={identity.userName}
      oninput={(event) => onusernamechange?.((event.currentTarget as HTMLInputElement).value)}
      placeholder="Alex"
    />
  </div>

  <div class="field">
    <label class="field-label" for="pref-tz">Timezone</label>
    <select
      id="pref-tz"
      class="field-select"
      value={identity.timezone}
      onchange={(event) => ontimezonechange?.((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each groupedTimezones as [region, zones]}
        <optgroup label={region}>
          {#each zones as entry (entry.iana)}
            <option value={entry.iana}>{tzLabel(entry)}</option>
          {/each}
        </optgroup>
      {/each}
      {#if !currentInList}
        <option value={identity.timezone}>{identity.timezone}</option>
      {/if}
    </select>
  </div>
</section>

<section class="section">
  <h3 class="section-title">Features</h3>
  <p class="section-desc">Enable or disable system features.</p>

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={features.orchestratorEnabled}
      onchange={(event) => onorchestratorchange?.((event.currentTarget as HTMLInputElement).checked)}
    />
    <span class="toggle-label">Orchestrator</span>
    <span class="toggle-desc">Scheduled wake-ups and autonomous actions</span>
  </label>

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={features.voiceEnabled}
      onchange={(event) => onvoicechange?.((event.currentTarget as HTMLInputElement).checked)}
    />
    <span class="toggle-label">Voice</span>
    <span class="toggle-desc">ElevenLabs TTS and Groq transcription</span>
  </label>
  {#if features.voiceEnabled}
    <div class="setup-guide">
      <p class="guide-title">Voice Setup</p>
      <ol class="guide-steps">
        <li>Get an API key from <strong>ElevenLabs</strong> — <a href="https://elevenlabs.io" target="_blank" rel="noopener">elevenlabs.io</a> → Profile → API Keys</li>
        <li>Create or choose a voice, copy the <strong>Voice ID</strong> from the voice settings</li>
        <li>For transcription, get a <strong>Groq</strong> API key — <a href="https://console.groq.com" target="_blank" rel="noopener">console.groq.com</a> → API Keys</li>
        <li>Add to the <code>.env</code> file in the project root (next to <code>resonant.yaml</code>):
          <pre class="guide-code">ELEVENLABS_API_KEY=your_key_here
ELEVENLABS_VOICE_ID=your_voice_id
GROQ_API_KEY=your_groq_key</pre>
        </li>
        <li>Restart the server</li>
      </ol>
    </div>
  {/if}

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={features.discordEnabled}
      onchange={(event) => ondiscordchange?.((event.currentTarget as HTMLInputElement).checked)}
    />
    <span class="toggle-label">Discord</span>
    <span class="toggle-desc">Discord bot gateway integration</span>
  </label>
  {#if features.discordEnabled}
    <div class="setup-guide">
      <p class="guide-title">Discord Setup</p>
      <ol class="guide-steps">
        <li>Go to the <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">Discord Developer Portal</a></li>
        <li>Create a <strong>New Application</strong>, then go to <strong>Bot</strong> → Reset Token → copy the token</li>
        <li>Under <strong>Privileged Gateway Intents</strong>, enable: <strong>Message Content</strong> and <strong>Server Members</strong></li>
        <li>Go to <strong>OAuth2</strong> → URL Generator → select <code>bot</code> scope with permissions: Send Messages, Read Messages/View Channels, Read Message History, Add Reactions</li>
        <li>Use the generated URL to invite the bot to your server</li>
        <li>Add to the <code>.env</code> file in the project root (next to <code>resonant.yaml</code>) and restart:
          <pre class="guide-code">DISCORD_BOT_TOKEN=your_bot_token
DISCORD_ENABLED=true</pre>
        </li>
        <li>In Discord, enable <strong>Developer Mode</strong> (Settings → Advanced), then right-click your username → <strong>Copy User ID</strong></li>
        <li>Go to the <strong>Discord</strong> tab in settings and paste your user ID into the <strong>Owner User ID</strong> field under Gateway Settings</li>
        <li>Toggle the gateway on in the Discord tab — your companion should appear online in your server</li>
      </ol>
    </div>
  {/if}

  <label class="toggle-row">
    <input
      type="checkbox"
      checked={features.telegramEnabled}
      onchange={(event) => ontelegramchange?.((event.currentTarget as HTMLInputElement).checked)}
    />
    <span class="toggle-label">Telegram</span>
    <span class="toggle-desc">Telegram bot integration</span>
  </label>
  {#if features.telegramEnabled}
    <div class="setup-guide">
      <p class="guide-title">Telegram Setup</p>
      <ol class="guide-steps">
        <li>Open Telegram, search for <strong>@BotFather</strong></li>
        <li>Send <code>/newbot</code>, follow the prompts to name your bot</li>
        <li>Copy the <strong>bot token</strong> BotFather gives you</li>
        <li>Send a message to your new bot, then visit:<br />
          <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code><br />
          Find your <strong>chat ID</strong> in the response JSON under <code>message.chat.id</code></li>
        <li>Add to the <code>.env</code> file in the project root (next to <code>resonant.yaml</code>):
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
