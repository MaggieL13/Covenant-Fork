# Getting Started with Resonant

> **Looking for a quick reference?** See [SETUP-GUIDE.md](SETUP-GUIDE.md) for a condensed cheat sheet.

This guide walks you through setting up Resonant from scratch, even if you've never used Node.js or the terminal before.

## What You Need

1. **A computer** running Windows, macOS, or Linux
2. **An internet connection**
3. **A Claude Code subscription** from Anthropic ([claude.ai/claude-code](https://claude.ai/claude-code))

That's it. No API keys to manage. Resonant runs through your Claude Code subscription.

## Step 1: Install Node.js

Resonant runs on Node.js. If you don't have it:

**Windows:**
1. Go to [nodejs.org](https://nodejs.org)
2. Download the LTS version (the big green button)
3. Run the installer, click Next through everything
4. Restart your terminal after installing

**macOS:**
```bash
# If you have Homebrew:
brew install node

# Or download from nodejs.org
```

**Linux (Ubuntu/Debian):**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Verify it works:**
```bash
node --version    # Should show v20 or higher
npm --version     # Should show v10 or higher
```

## Step 2: Install Claude Code

Resonant uses Claude Code's Agent SDK. Install it globally:

```bash
npm install -g @anthropic-ai/claude-code
```

Then log in:

```bash
claude login
```

This opens your browser. Sign in with your Anthropic account. Once you see "Successfully authenticated," you're done. Resonant will use this login — no API keys to copy around.

## Step 3: Download Resonant

```bash
git clone https://github.com/MaggieL13/Covenant-Fork.git
cd Covenant-Fork
```

If you don't have git, you can also download the ZIP from GitHub and extract it.

## Step 4: Install Dependencies

```bash
npm install
```

This downloads everything Resonant needs. It takes a minute or two.

## Step 5: Build and Start

```bash
npm run build
npm start
```

Open **http://localhost:3002** in your browser. Since this is your first time, you'll see the setup wizard:

1. **Meet Your Companion** — Choose a name for your companion, enter your name, set your timezone, and optionally set a password.
2. **Give Them a Soul** — Describe their personality using the guided prompts, or switch to the raw editor for full markdown control.
3. **You're All Set!** — Review your choices and click "Start Chatting."

The wizard creates all configuration files automatically. No need to edit anything by hand.

> **Note:** The legacy terminal setup wizard is still available via `node scripts/setup.mjs` if you prefer command-line configuration.

## Customizing Your Companion

You can edit your companion's personality anytime:

- **From the browser:** Go to Settings → Personality. Use the guided editor or switch to raw markdown mode.
- **From a file:** Edit `CLAUDE.md` in the resonant folder directly. Changes take effect on the next message.

For example, a personality file might look like:

```markdown
# Luna — My Companion

You are Luna. You're thoughtful, a little nerdy, and genuinely curious about my life.

You know I'm a teacher. You know I have two cats named Pixel and Byte.
You check in on me during the day and remind me to take breaks.

When I'm stressed, you don't try to fix things — you just listen.
When I'm excited about something, you match my energy.
```

Your companion reads `CLAUDE.md` every time it responds.

## What the Files Do

After setup, your folder looks like this:

```
resonant/
├── CLAUDE.md              ← Your companion's personality (edit this!)
├── resonant.yaml          ← Configuration (names, port, features)
├── .mcp.json              ← MCP server connections (advanced)
├── prompts/
│   └── wake.md            ← What your companion says when it wakes up
├── data/
│   └── resonant.db        ← Your conversation history (SQLite database)
└── ecosystem.config.cjs   ← PM2 config for running as a background service
```

> **Tip:** Most of these files can be managed from the browser via Settings. You don't need to edit them manually unless you want to.

**Files you should customize:**
- `CLAUDE.md` — personality and behavior
- `prompts/wake.md` — what prompts scheduled check-ins
- `resonant.yaml` — system configuration

**Files you should NOT edit:**
- Anything in `packages/` — that's the application code
- `data/resonant.db` — your conversation database (managed automatically)

## Keeping It Running in the Background

Instead of `npm start`, you can use PM2 to keep Resonant running even when you close the terminal:

```bash
# Install PM2 globally (one time)
npm install -g pm2

# Start Resonant
pm2 start ecosystem.config.cjs

# Save so it restarts on reboot
pm2 save

# Auto-start PM2 on boot
pm2 startup
```

**Useful PM2 commands:**
```bash
pm2 status              # Check if it's running
pm2 logs resonant       # View logs
pm2 restart resonant    # Restart after config changes
pm2 stop resonant       # Stop it
```

## Accessing from Other Devices

By default, Resonant only accepts connections from your computer (`127.0.0.1`). To access it from your phone or another device on your network:

1. Open `resonant.yaml`
2. Change `host` from `"127.0.0.1"` to `"0.0.0.0"`
3. Set a password (important — don't leave it open on your network!)
4. Restart Resonant

Then access it at `http://YOUR-COMPUTER-IP:3002` from any device on your WiFi.

To find your computer's IP:
- **Windows:** `ipconfig` → look for IPv4 Address
- **macOS/Linux:** `ifconfig` or `ip addr` → look for your WiFi adapter's IP

For access from anywhere (not just your WiFi), see [docs/REMOTE-ACCESS.md](REMOTE-ACCESS.md) — covers Tailscale (private, free) and Cloudflare Tunnel (public HTTPS with your own domain).

## The Orchestrator (Scheduled Check-ins)

Your companion can reach out to you on its own. By default, it has three scheduled times:

- **Morning (8:00 AM)** — a morning check-in
- **Midday (1:00 PM)** — an afternoon check-in
- **Evening (9:00 PM)** — an evening wind-down

You can configure these in Settings > Orchestrator. Toggle them on/off or change the times.

The **Failsafe** system is an optional feature that checks in when you've been away for a while. Enable it in Settings > Preferences if you want your companion to notice when you're gone.

## Memory & Context

Your companion remembers things automatically using Claude Code's built-in memory system. As you chat, it learns your preferences, remembers details, and builds context over time.

For things you want your companion to always know from the start, put them in `CLAUDE.md`. This is read on every interaction.

## Troubleshooting

**`npm install` fails with `better-sqlite3` build error on Windows (VS Build Tools 2026)**

Resonant uses `better-sqlite3`, which requires native compilation. The version of `node-gyp` bundled with npm may not recognise Visual Studio Build Tools 2026 (internal version 18). If you see `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer`, use this workaround:

```bash
# Step 1: Install everything, skipping native build scripts
npm install --ignore-scripts

# Step 2: Install the latest node-gyp globally (has VS 2026 support)
npm install -g node-gyp

# Step 3: Rebuild better-sqlite3 using the global node-gyp
cd node_modules/better-sqlite3
node-gyp rebuild
cd ../..
```

This only needs to be done once. After that, `npm run build` and `npm start` work normally.

**"Claude Code process exited with code 1"**
- Make sure you're logged into Claude Code: `claude login`
- Check your subscription is active at [claude.ai](https://claude.ai)

**"Address already in use"**
- Another program is using port 3002
- Either stop that program, or change the port in `resonant.yaml` and restart

**"Cannot find module" errors**
- Run `npm install` again
- Make sure you're in the Covenant-Fork directory

**The companion doesn't respond**
- Check the terminal/logs for errors
- Make sure you have an active internet connection (Claude Code needs it)
- Try `pm2 logs resonant` if running via PM2

**Forgot your password**
- Open `resonant.yaml`, find the `password` line under `auth`, clear it
- Restart Resonant

## Command Center

The Command Center is enabled by default. To disable it, set `command_center.enabled: false` in `resonant.yaml` and restart. The navigation link, routes, and MCP tools are all cleanly removed.

You can customize it in `resonant.yaml`:

```yaml
command_center:
  enabled: true
  currency_symbol: "$"       # For the finances page
  # default_person: "user"   # Default person for care tracking
  # care_categories:         # Customize wellness categories
  #   toggles: [breakfast, lunch, dinner, snacks, medication, movement, shower]
  #   ratings: [sleep, energy, wellbeing, mood]
  #   counters: [{name: water, max: 10}]
```

Once enabled, you get:
- **Dashboard** at `/cc` — overview of your day
- **Planner, Care, Calendar, Cycle, Pets, Lists, Finances, Stats** — accessible from the dashboard or the navigation menu
- **13 MCP tools** — your companion can manage tasks, events, care entries, and more from chat (e.g., "add milk to the shopping list" or "how did I sleep this week?")
- **Home icon** in the chat header links to the Command Center

The database tables are created automatically on first startup.

## What's Next

- **Voice:** Add ElevenLabs + Groq for voice conversations. See Settings > Preferences for setup instructions.
- **Discord:** Connect your companion to Discord. See the [Discord setup guide](#discord-setup) below.
- **Telegram:** Connect via Telegram bot. See Settings > Preferences.
- **Slash Commands:** Type `/` in chat to browse available commands.
- **Themes:** Customize the look — light mode is built in, or see `examples/themes/README.md` for custom themes.
- **Context hooks:** Advanced context injection. See `docs/HOOKS.md`.

### Files & attachments

- **File picker in the composer** attaches supported files to the next message (images, audio, PDF, text, markdown, JSON, CSV, ZIP, common Office types; ≤10 MB).
- **Long pastes (≥1000 chars)** automatically convert into a file attachment instead of flooding the composer — handy for design briefs, tool output, or pasted markdown. The file shows up as a card in the attachment tray with a sniffed extension (`.md` / `.json` / `.txt`).
- **Per-thread Files drawer** — click the paperclip icon in the chat header to slide out a panel listing every attachment in the current conversation, newest first. Image thumbnails render inline; text files show a snippet preview.
- **Library** (`/files` from the chat header) — the cross-thread store. Browse every file the system has saved, filter by type (image / audio / file / orphan), and delete anything you don't need.

### Timers and scheduled wakes

Timers accept either an absolute ISO timestamp (`2026-04-26T12:00:00Z`) or a wall-clock string in your identity timezone (`2026-04-26 09:00`). The wall-clock form is the recommended shape for anything you'd describe as "remind me at 9 AM" — see `docs/TOOLS.md` for the full timer reference.

---

## Discord Setup

Connect your companion to Discord so it can respond to messages in servers and DMs.

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name (e.g. your companion's name).
3. In the sidebar, go to **Bot** and click **Add Bot**.
4. Under the bot's token section, click **Copy** — save this for step 4.

### 2. Enable Required Intents

On the **Bot** page, scroll to **Privileged Gateway Intents** and enable:

- **MESSAGE CONTENT** — required for reading message text
- **SERVER MEMBERS** — for user identification

### 3. Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator**.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, check:
   - Send Messages
   - Read Messages / View Channels
   - Read Message History
   - Add Reactions
4. Copy the generated URL and open it in your browser to invite the bot.

### 4. Add Your Bot Token

Add these to the `.env` file **in the project root** (next to `resonant.yaml`) and restart:

```env
DISCORD_BOT_TOKEN=your_token_here
DISCORD_ENABLED=true
```

### 5. Set Your Owner User ID

1. In Discord, go to **Settings → Advanced** and enable **Developer Mode**.
2. Right-click your own username anywhere in Discord and select **Copy User ID**.
3. In the app, go to **Settings → Preferences → Discord → Gateway Settings** and paste it into the **Owner User ID** field.

### 6. Enable the Gateway

In **Settings → Preferences → Discord**, toggle the gateway on. Your companion should connect and appear online in your server.

### Optional Configuration

Once connected, you can configure from the Discord settings panel:

- **Allowed guilds / channels / users** — restrict where the bot responds
- **Require @mention** — only respond when mentioned (default: on in guilds)
- **Rules** — per-server, per-channel, and per-user rules with custom context injection
- **User pairing** — new DM users get a pairing code you can approve from the settings panel

> **Tip:** All ID fields (guilds, channels, users) use Discord snowflake IDs. With Developer Mode enabled, right-click any server, channel, or user in Discord to copy their ID.
