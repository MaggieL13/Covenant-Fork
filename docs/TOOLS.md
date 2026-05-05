# Built-in Tools

Resonant ships a set of tools your agent can use via Bash during conversations. These extend beyond Claude Code's native tools (Read, Write, Edit, Bash, Grep, Glob) with conversation-aware capabilities.

Tools are accessed through `tools/sc.mjs` — a CLI that wraps Resonant's internal API. The agent's orientation context includes the full command reference on every message, so it knows what's available.

All commands auto-detect the current thread from `.resonant-thread` (written per-query). Port is read from `resonant.yaml`.

---

## Configuration

These settings in `resonant.yaml` control tool behavior:

```yaml
discord:
  history_limit: 10          # Messages included in channel history (default: 10, was 25)

hooks:
  platform_context_max_tokens: 500   # Token budget for platform context
  cc_mcp_server_name: ""             # Override CC MCP server detection
  mind_mcp_server_name: ""           # Override Mind MCP server detection
```

### Dynamic MCP Loading

MCP servers are loaded dynamically based on message content:

- **Command Center MCP** — loaded when message contains keywords like "task", "calendar", "pet", "expense", etc.
- **Mind MCP** — loaded on first message in a thread, autonomous wakes, or when message contains keywords like "remember", "memory", "feel", etc.
- **All other MCP servers** — always loaded

This uses word-boundary matching (`\bpet\b`) to prevent false positives like "compete" matching "pet".

---

## Chat Tools

### Share Files
Share a file from disk into the current chat thread. Appears as a message with the file attached.

```bash
sc share /absolute/path/to/file
```

**Auto-share + dedup.** Files the companion writes into the **`/shared/`** folder (the personal scratch directory at the repo root, gitignored) are auto-surfaced as chat cards by the Write hook, no explicit `sc share` needed. If the companion ALSO calls `sc share` for the same path, a recently-surfaced-file-card dedup tracker keyed by `threadId::basename` (30-second window, shared between the Write hook and the explicit share route) suppresses the duplicate card.

> **Naming reminder.** `/shared/` (root) is the user's personal scratch + companion-writable directory and is ignored by git. `packages/shared/` is the tracked workspace package containing shared TypeScript types — it is NOT a write target for the auto-share flow. Don't confuse them.

**In-app surfaces for files:**
- **Library** — the cross-thread store at `/files` (page title "Library"). Browse every file the system has saved, filter by content type, see which files are referenced by active messages vs. orphaned, delete anything you don't need. Library owns disk-level deletion authority.
- **Per-thread Files drawer** — paperclip icon in the chat header. Slide-out panel showing every attachment in the current conversation, newest first. Image thumbnails render inline; text files (≤50 KB) show a snippet preview. Click any tile to open `/api/files/<id>` in a new tab. Read-only — no delete from this surface.

### Paste-as-file (composer)

Long pastes auto-convert into a file attachment instead of dropping inline into the message draft.

- **Image paste takes priority.** If the clipboard carries an image (screenshot, copied image), that image-bearing item is uploaded as a file regardless of any text alongside it.
- **Long-text paste** — when the clipboard's `text/plain` length is `>= 1000` characters, the paste is intercepted and wrapped as a `File`, then pushed through the existing upload pipeline. Shorter pastes fall through to default inline-paste behavior.
- **Sniffed extension.** Content shape decides the saved file's extension: `.md` for content with markdown headings, bullet lists, or fenced code blocks; `.json` when the trimmed text both looks like JSON and parses; otherwise `.txt`.
- **Filename.** Generated as `pasted-text-YYYYMMDD-HHMMSS.{ext}` using browser-local time (the timestamp reflects the user's machine clock at the moment of paste).

### Canvas
Create or update collaborative documents alongside chat.

```bash
sc canvas create "Title" /path/to/file.md markdown
sc canvas create-inline "Title" "short text content" text
sc canvas update CANVAS_ID /path/to/file
sc canvas read CANVAS_ID              # Read canvas content
sc canvas list                        # List all canvases
sc canvas tag CANVAS_ID tag1,tag2     # Add tags for organization
```

Content types: `markdown`, `code`, `text`, `html`

### Stickers
Send sticker images in chat. Sticker packs are managed via Settings.

```bash
sc sticker send "pack-name" "sticker-name"
sc sticker list                       # List all packs and stickers
sc sticker list PACK_ID               # List stickers in a specific pack
```

### Reactions
React to messages with emoji. Uses offset-based targeting — no message IDs needed. Reactions target user messages only (companion's own messages are skipped).

```bash
sc react last "❤️"              # React to last user message
sc react last-2 "🔥"            # React to 2nd-to-last user message
sc react last "❤️" remove       # Remove a reaction
```

### Voice
Send a text-to-speech message using ElevenLabs. Supports tone tags for expressive delivery.

```bash
sc voice "[whispers] hey [sighs] I missed you"
```

Tone tags: `[whispers]` `[softly]` `[excited]` `[laughs]` `[sighs]` `[playfully]` `[calm]` `[gasps]` `[dramatically]` `[deadpan]` `[cheerfully]` `[nervous]` `[mischievously]`

Requires `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` in `.env`.

**Fallback when voice is unavailable.** The agent's system prompt carries a static tool-behavior rule (see "Tool-behavior rules" below) that broadly says: when the Voice tool is unavailable, send the intended message as a normal chat reply rather than improvising via canvas, file write, or any other persistence-based workaround. The Voice tool's own error message ALSO carries this explicit guidance for the **not-configured** path (`ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` unset). Other failure modes — non-OK responses from ElevenLabs, network errors — surface a more generic error string; the system prompt rule is what lands the companion on the right behavior in those cases.

---

## Semantic Search

Search conversation history by meaning using local ML embeddings. No external API calls — runs entirely on your machine.

```bash
sc search "what did we talk about last week"
sc search "that architecture discussion" --thread THREAD_ID
sc search "query" --limit 5
sc search "query" --role companion     # Filter by speaker
sc search "query" --after 2026-03-01   # Filter by date range
sc search "query" --before 2026-03-15
```

Returns matched messages with surrounding conversation context (2 messages before and after each match).

### Backfill

New messages are embedded automatically. To index existing history:

```bash
sc backfill start                  # Background indexing (50/batch, 5s interval)
sc backfill start 100 3000         # Custom batch size and interval (ms)
sc backfill status                 # Check progress
sc backfill stop                   # Halt background indexing
```

See [semantic-search.md](semantic-search.md) for setup and technical details.

---

## Scheduling

### Orchestrator
Control the autonomous wake schedule. The orchestrator triggers your agent at configured times with specific prompts.

```bash
sc schedule status                 # Show all schedules
sc schedule enable                 # Enable orchestrator
sc schedule disable                # Disable orchestrator
sc schedule reschedule morning_anchor "0 8 * * *"   # Reschedule a wake
sc routine remove ROUTINE_ID       # Remove a custom routine
```

> `sc routine` and `sc schedule` are aliases — both work identically.

Wake types depend on your `resonant.yaml` orchestrator config and `wake-prompts.md`.

### Timers
One-shot scheduled reminders. Fire once at a specific time.

```bash
# Wall-clock in your identity timezone (preferred for human/agent-set reminders)
sc timer create "label" "context" "2026-04-26 09:00"
sc timer create "label" "context" "2026-04-26T09:00:00" --prompt "wake text"

# Absolute ISO with explicit Z or ±HH:MM offset
sc timer create "label" "context" "2026-04-26T12:00:00Z"
sc timer create "label" "context" "2026-04-26T09:00:00-03:00"

sc timer list
sc timer cancel TIMER_ID
```

**`fireAt` accepts two forms:**
- **Wall-clock in identity timezone** — offsetless `YYYY-MM-DD HH:mm`,
  `YYYY-MM-DDTHH:mm:ss`, or `YYYY-MM-DD` (midnight). Interpreted in
  whatever zone is configured at `identity.timezone` in `resonant.yaml`.
  This is the right shape for "remind me at 9 in the morning" — what
  the user/agent actually means.
- **Absolute ISO** — with explicit `Z` (UTC) or `±HH:mm` offset. The
  zone marker wins; identity.timezone is ignored.

Fires within ~60 seconds of the target time. The optional `--prompt`
sets the text used to wake the agent when the timer fires.

Timer creation and `sc timer list` responses include a `fire_at_local`
field with the human-readable identity-zone wall clock alongside the
canonical UTC `fire_at`.

### Impulses
One-shot, condition-based triggers. Fire once when all conditions are met, then auto-complete.

```bash
sc impulse create "label" --condition presence_state:active --prompt "tell them X"
sc impulse create "label" --condition time_window:18:00 --condition routine_missing:meal:14 --prompt "remind about food"
sc impulse create "label" --condition agent_free --prompt "journal entry"
sc impulse list
sc impulse cancel TRIGGER_ID
```

### Watchers
Recurring, cooldown-protected triggers. Fire repeatedly whenever conditions are met, with a minimum interval between firings.

```bash
sc watch create "label" --condition presence_transition:offline:active --prompt "Good morning" --cooldown 480
sc watch create "label" --condition presence_state:active --condition time_window:13:00 --prompt "check in" --cooldown 120
sc watch list
sc watch cancel TRIGGER_ID
```

`--cooldown` is in minutes (default 120). Prevents the watcher from firing again too soon.

### Condition Reference

All conditions are AND-joined — every condition must be true for the trigger to fire.

| Condition | Syntax | Description |
|-----------|--------|-------------|
| Presence state | `presence_state:active` | User is currently in the given state |
| Presence transition | `presence_transition:offline:active` | User just transitioned between states |
| Agent free | `agent_free` | No query currently running |
| Time window | `time_window:18:00` | Current time is after HH:MM |
| Time window (range) | `time_window:09:00:17:00` | Current time is between start and end |
| Routine missing | `routine_missing:meal:14` | Named routine hasn't been logged since hour N |

---

## Telegram Tools

Available when the user is on Telegram. These appear in the agent's context automatically.

```bash
sc tg photo /path/to/image.png "caption"
sc tg photo --url "https://..." "caption"
sc tg doc /path/to/file.pdf "caption"
sc tg gif "search query" "optional caption"     # Searches GIPHY
sc tg react last "❤️"
sc tg react last-2 "🔥"
sc tg voice "text with [tone tags]"
sc tg text "proactive message"
```

---

## Command Center MCP Tools

When `command_center.enabled` is true, 13 tools are available via the MCP endpoint at `/mcp/cc`. The companion uses these to manage life data from chat.

| Tool | Actions | Description |
|------|---------|-------------|
| `cc_status` | — | Aggregated dashboard: tasks, events, care, cycle, pets, countdowns, wins |
| `cc_task` | add, list, complete, update, delete | Task management with projects and priorities |
| `cc_project` | add, list, update, delete | Project management with deadlines and colors |
| `cc_care` | set, get, history | Wellness tracking (toggles, ratings, counters, notes) |
| `cc_event` | add, list, update, delete | Calendar events with recurrence |
| `cc_cycle` | status, history, predict, start_period, end_period, log | Cycle tracking with phase predictions |
| `cc_pet` | add, list, update, log, med_add, med_given, upcoming | Pet care with medication schedules |
| `cc_list` | create, view, list_all, add, check, delete_list, delete_item, clear | Shopping and general lists |
| `cc_expense` | add, list, stats | Expense tracking with category breakdown |
| `cc_countdown` | add, list, delete | Countdown timers to events |
| `cc_scratchpad` | status, add_note, add_task, add_event, remove_note, remove_task, clear_notes | Persistent scratchpad — notes and tasks stay until removed |
| `cc_daily_win` | — | Record one win per person per day |
| `cc_presence` | get, set | Presence status with emoji and label |

All tools accept JSON parameters via the MCP protocol. The companion's hooks system automatically includes CC status in its orientation context.

---

## The Scribe (Digest Agent)

A background agent that runs every 30 minutes on Haiku, producing structured daily digests of conversation. Digests are saved to `data/digests/YYYY-MM-DD.md`.

Each digest block extracts:
- **Topics & Themes** — categorized by work, personal, health, creative, etc.
- **Key Quotes** — attributed, significant moments
- **Decisions Made** — what was resolved
- **Open Items** — discussed but not actioned (the things that slip through cracks)
- **Ideas & Plans** — "we should..." and "what if..." moments
- **Events & Dates** — anything with a timeline
- **Projects Touched** — what changed, shipped, or broke
- **Emotional Arc** — observable mood shape of the conversation block

### Configuration

- Toggle: set `digest.enabled` to `false` in the config DB to disable
- The Scribe skips runs when the companion is actively processing
- Requires at least 5 new messages since the last digest
- Uses `companion_name` and `user_name` from `resonant.yaml` for speaker labels

---

## Spawning Agents — Model Selection

When the companion spawns subagents via the `Agent` tool, a `model` parameter controls which Claude model handles the work. The parameter accepts either a **family alias** (server-side resolves to "latest in that family") or a **pinned model ID** (locks to a specific version). Pinned IDs are useful when you want the new generation explicitly — family aliases lag the latest pinned by a week or so.

### Available values

**Family aliases** (auto-track latest of each family):

| Alias | Currently resolves to | Min CC | Best for |
|-------|----------------------|--------|----------|
| `"sonnet"` | Sonnet 4.6 | — | Research agents, quick scans, parallel scouts — faster, newer |
| `"opus"` | Opus 4.7 | 2.1.111 | Deep dives, synthesis, complex reasoning — matches main brain |
| `"haiku"` | Haiku 4.5 | — | Lightweight tasks, summaries (what the Scribe runs on) |

**Pinned model IDs** (stable until you change them):

| ID | Min CC | Notes |
|----|--------|-------|
| `"claude-opus-4-7"` | 2.1.111 | Latest Opus generation. Newer reasoning, longer context window. |
| `"claude-opus-4-6"` | — | Previous Opus. Stable fallback if 4.7 misbehaves. |
| `"claude-opus-4-5"` | — | Older Opus. |
| `"claude-sonnet-4-6"` | — | Latest Sonnet. Currently what `"sonnet"` alias points to. |
| `"claude-sonnet-4-5"` | — | Older Sonnet. |
| `"claude-haiku-4-5"` | — | Latest Haiku. Currently what `"haiku"` alias points to. |

The "Min CC" column shows the minimum bundled Claude Code runtime required. Settings → System → Claude Runtime Health surfaces the current bundled version and warns if a configured model needs a higher floor than what's loaded.

### Usage

```
Agent({
  model: "sonnet",                 // family alias — auto-tracks latest Sonnet
  description: "...",
  prompt: "..."
})

Agent({
  model: "claude-opus-4-7",        // pinned — locks to Opus 4.7 explicitly
  description: "...",
  prompt: "..."
})
```

If `model` is omitted, the spawned agent inherits from the parent — see `agent.model` / `agent.model_autonomous` in `resonant.yaml` for the configured tier defaults.

### Practical guidance

- **Use `"sonnet"` for research and discovery agents** — faster output, current generation, good for parallel spawns
- **Use `"opus"` (or `"claude-opus-4-7"` pinned) when you need top reasoning** — slower but the best at synthesis and architecture work
- **Pin a specific ID when behavior matters** — family aliases auto-migrate when Anthropic ships a new generation, which can shift the feel of an agent's output unexpectedly
- **Model versions change over time.** The tables above reflect what was live when this was written. Test with a self-report prompt to confirm what a model resolves to.

> **Discovery note (2026-05-04):** Opus 4.7 became reachable after the bundled Claude Code runtime crossed 2.1.111 (currently 2.1.126). Selecting it before that floor would silently fail at request time — the runtime-health panel surfaces the requirement and offers in-app SDK updates.

---

## Slash Commands

Type `/` in the chat input to open the CommandPalette. Commands are auto-discovered from installed skills and built-in UI commands.

- **UI commands** — executed client-side (e.g., theme toggle, navigation)
- **SDK commands** — passed through to the agent as tool calls

---

## Tool-behavior rules (system prompt prefix)

The agent's system prompt is built from the `claude_code` preset followed by the repo's `CLAUDE.md` persona file. **Prepended before that** is a small static `TOOL_BEHAVIOR_RULES` block defined inline in `services/agent.ts`. The rules live there (not in `CLAUDE.md`) so the persona file stays untouched and the rules apply uniformly across every persona.

Current rules:

1. **Default Write target.** When using the Write tool to save user-facing content (scripts, stories, notes, markdown, ElevenLabs scripts, personal writing), default to the `shared/` folder relative to the project root. Repo-root writes are appropriate only for files that genuinely belong at the root (`package.json`, `README.md`, config, explicitly-requested test artifacts).
2. **Voice fallback.** When the Voice tool returns an unavailable / not-configured error, send the intended message as a normal chat reply. Do NOT improvise via canvas, file write, or any other persistence-based workaround for what was meant to be a voice note.

The rules block is short and additive — adding a new rule is a one-line edit in `services/agent.ts::TOOL_BEHAVIOR_RULES`.

---

## Public Endpoints

A small set of read endpoints are reachable without the localhost gate (subject to the standard auth middleware where applicable):

| Endpoint | Purpose |
|----------|---------|
| `GET /api/timezones` | Flat sorted array of `{ iana, city, country, countryCode, region }` entries — every IANA zone the runtime knows, enriched with country metadata via `Intl.DisplayNames`. The Settings timezone picker groups the result by region in the UI; the API itself returns the list directly without grouping. |

---

## Internal API

All other tools wrap localhost-only REST endpoints. These require no authentication — just the request must come from `127.0.0.1`.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/internal/share` | Share files into chat |
| `POST /api/internal/canvas` | Create/update canvases |
| `POST /api/internal/tts` | Text-to-speech |
| `POST /api/internal/react` | Message reactions |
| `POST /api/internal/orchestrator` | Schedule management |
| `POST /api/internal/timer` | Timer CRUD |
| `POST /api/internal/trigger` | Impulse/watcher CRUD |
| `POST /api/internal/telegram-send` | Send to Telegram |
| `POST /api/internal/search-semantic` | Semantic search |
| `POST /api/internal/embed-backfill` | Embedding backfill |
| `POST /api/internal/sticker` | Sticker send/list |

The `sc` CLI is the recommended interface. Direct API access is available for custom integrations.
