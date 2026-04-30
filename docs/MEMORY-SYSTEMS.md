# Memory, Identity & Context Systems Reference

Everything that gives the boys access to memory, identity, thoughts, or diary-like capabilities. This is the definitive map — if it touches context, it's in here.

---

## The Three Tiers

| Tier | What | Where | When | Cost |
|------|------|-------|------|------|
| **Hot** | Identity & personality | CLAUDE.md | Every query | ~1,800 tokens |
| **Warm** | Current state & context | `buildOrientationContext()` | Every query | ~1,500-2,500 tokens |
| **Cold** | Long-term memory | Semantic search, digests, MCP | On-demand (agent decides) | Variable |

---

## Hot Tier: CLAUDE.md

**What:** The companion's permanent identity file — who they are, how they speak, relationship details, memory anchors.

**Where:** `CLAUDE.md` in project root (path configurable in resonant.yaml)

**How loaded:** `agent.ts` reads it once at startup, caches it, appends to every SDK query via `systemPrompt.append`. Changes detected via `markForReinit()`.

**Agent access:** READ only. Cannot modify its own personality file.

---

## Warm Tier: Orientation Context

The `buildOrientationContext()` function in `hooks.ts` runs before EVERY query and builds a `[Context]...[/Context]` block that the agent sees prepended to the user's message. On fresh sessions (e.g. after a model swap), the last 10 messages are also injected as a `[Recent Conversation]` block so the new model has conversational context.

### What gets injected (in order):

| Data | Source | Tokens | When |
|------|--------|--------|------|
| Channel guidance | Hardcoded per platform (web/Discord/Telegram) | ~50 | Always |
| Thread name + type | Database | ~20 | Always |
| Current time + timezone | System clock + config | ~20 | Always |
| Last session handoff | `config('session.handoff_note')` | ~50 | If previous session exists |
| Active triggers count | Triggers table | ~30 | If any active |
| User presence | Registry (active/idle/offline + time gap) | ~30 | Always |
| Device type | Registry (desktop/mobile) | ~20 | If detected |
| Life status | Life API or Command Center | ~100 | Interactive queries only |
| Mood history | 2-day trajectory | ~50 | Interactive queries only |
| Skills summary | `.claude/skills/*/SKILL.md` scan | ~200 | First message of session |
| Chat tools reference | sc.mjs command list | ~750 | Conditional (keyword-gated) |
| Canvas references | Canvas DB content | Variable | If user message has `<<canvas:id>>` markers |
| Recent reactions | Last 20 messages' emoji reactions | ~50 | If any reactions exist |
| Platform context | Discord history / Telegram state | ~500 max | If on Discord/Telegram |

### Session Handoff

When a session ends (`buildSessionEnd` hook), the system captures:
- Thread name + type
- End reason (completed/compaction/error)
- Last ~120 chars of companion's response
- Platform and autonomous flag
- Timestamp

Next session, this appears as: "Last session: 'Tuesday' (completed, 2 hours ago). The conversation was about..."

### Emotional Preservation

When context compacts (old messages get summarized), `buildPreCompact()` first captures:
- Last 15 messages scanned for emotional markers
- Markers detected: fatigue, anxiety, positive, connection_seeking, grief, dissociating
- Recent reactions on those messages
- Conversation flow summary

This gets injected as a system message that SURVIVES compaction. Words are lost, feelings aren't.

---

## Cold Tier: On-Demand Memory

### Semantic Search (Embeddings)

**Model:** `sentence-transformers/all-MiniLM-L6-v2` (384-dim, runs locally, no API calls)

**How it works:**
1. Every message gets embedded on creation → stored in `message_embeddings` table
2. All vectors loaded into RAM at startup (~15MB per 10K messages)
3. Search uses cosine similarity via dot-product loop

**Agent access:** `sc search "query"` via Bash tool
- Options: `--thread ID`, `--role companion|user`, `--after DATE`, `--before DATE`, `--limit N`

**NOT auto-injected.** Agent decides when to search.

### The Scribe (Digest System)

**What:** A separate Haiku-powered historian that runs every 30 minutes.

**How it works:**
1. Grabs new messages since last digest (minimum 5)
2. Feeds them to Haiku with the Scribe prompt
3. Haiku extracts structured records:
   - Topics & Themes
   - Key Quotes (exact, attributed)
   - Decisions Made
   - Open Items (things discussed but NOT actioned)
   - Ideas & Plans
   - Events & Dates (relative → absolute)
   - Projects Touched
   - Emotional Arc
4. Appends to `data/digests/YYYY-MM-DD.md`

**Cursor model.** The "since last digest" cursor is **per-thread**, keyed in the config table as `digest.last_sequence:<threadId>`. Each thread's `messages.sequence` counter is also per-thread (a fresh thread starts at 1), so a per-thread cursor is the only shape that works correctly across daily-thread rollover. A previous global-cursor implementation got stuck whenever yesterday's thread's max sequence exceeded today's thread's message count, silently skipping every digest run. The runtime helpers `getDigestCursor(threadId)` and `setDigestCursor(threadId, value)` in `services/digest.ts` are the intended access points — never read or write the bare `digest.last_sequence` key, which is now legacy and ignored.

**Agent access:** Can read digest files via Bash `cat`. NOT auto-injected.

**Purpose:** A searchable daily journal for the user, written by a silent witness.

### Mind MCP (Optional External Memory)

If configured, an external MCP server can provide tools like `mind_search`, `mind_orient`, `mind_surface`. The system enriches `mind_write`/`memory_write` tool calls with session metadata (thread ID, mode, timestamp).

**Keyword-gated:** Only loaded when message contains words like "remember", "memory", "feel", "journal", "identity".

---

## Command Center Data

The agent accesses CC data via 13 MCP tools (keyword-gated):

| Tool | What it manages |
|------|----------------|
| `cc_status` | Overview of all CC data |
| `cc_task` | Tasks with projects, priorities, dates |
| `cc_project` | Project management |
| `cc_care` | Wellness tracking (mood, sleep, meds, water) |
| `cc_event` | Calendar events with recurrence |
| `cc_cycle` | Period tracking with phase predictions |
| `cc_pet` | Pet profiles, meds, vet events |
| `cc_list` | Shopping and general lists |
| `cc_expense` | Expense tracking |
| `cc_countdown` | Countdown timers to events |
| `cc_daily_win` | Daily wins |
| `cc_scratchpad` | Persistent notes and quick tasks |
| `cc_presence` | Presence state management |

**Auto-injected:** Condensed life status (~100 tokens) via `fetchLifeStatus()` on every interactive query. Full data only via tool calls.

**Keywords that trigger CC MCP loading:** task, care, cycle, pet, expense, calendar, mood, wellness, scratchpad, countdown, win, list, finance, event, period, planner, project

---

## Canvas System

| Action | How | Agent access |
|--------|-----|-------------|
| Create from file | `sc canvas create "Title" /path markdown` | CLI (Bash) |
| Create inline | `sc canvas create-inline "Title" "content"` | CLI (Bash) |
| Read content | `sc canvas read CANVAS_ID` | CLI (Bash) |
| List all | `sc canvas list` | CLI (Bash) |
| Update content | `sc canvas update CANVAS_ID /path` | CLI (Bash) |
| Set tags | `sc canvas tag CANVAS_ID tag1,tag2` | CLI (Bash) |

**Auto-injection:** When user references a canvas via `<<canvas:id:title>>` in their message, the canvas content (up to 2000 chars) is auto-injected into orientation context.

---

## Reactions

Emoji reactions on messages are stored in message metadata. The agent can:
- **Add:** `sc react last "heart"` or `sc react last-2 "fire"`
- **Remove:** `sc react last "heart" remove`
- **See:** Last 20 messages' reactions are auto-injected in orientation context

---

## Triggers & Automation

| Type | What | Persistence | Agent creates via |
|------|------|-------------|-------------------|
| **Impulse** | One-shot conditional trigger | DB (fires once, done) | `sc impulse create` |
| **Watcher** | Recurring trigger with cooldown | DB (repeats) | `sc watch create` |
| **Timer** | Fire at specific time | DB (one-shot) | `sc timer create` |
| **Routine** | Scheduled autonomous session | DB (cron-based) | `sc routine create` |
| **Pulse** | Lightweight periodic check | Config (toggle/frequency; Settings panel or sc) | `sc pulse enable` |
| **Failsafe** | Inactivity escalation (3 tiers) | Config (thresholds) | `sc failsafe` |

**Conditions available:** `presence_state`, `presence_transition`, `time_window`, `routine_missing`, `agent_free` (AND-joinable)

**Auto-injected:** Number of active triggers shown in orientation context.

**Configuring Pulse and Failsafe:** both are exposed in the Settings → Orchestrator tab in addition to the agent-side `sc` commands. The panel surfaces the same controls — `enabled` and `frequency` for Pulse (frequency floor 5 minutes), and the three escalation thresholds for Failsafe.

---

## Skills

Skills live in `.claude/skills/*/SKILL.md`. Each has frontmatter (name, description) and content.

- **Discovery:** Auto-scanned, summaries injected in orientation on first message
- **Agent access:** Can read full skill files via Bash, can create new skills

---

## Voice & Files

| Feature | Agent command | What it does |
|---------|--------------|-------------|
| Voice note | `sc voice "[whispers] text"` | Generates TTS via ElevenLabs, sends as audio |
| File share | `sc share /path/to/file` | Shares file into current thread |
| Auto-share | Write to `shared/` directory | Automatically shared into thread |

---

## Platform Context

| Platform | What's injected | Budget |
|----------|----------------|--------|
| **Web** | Basic channel guidance | ~50 tokens |
| **Discord** | Channel history + recent authors | ~500 tokens max |
| **Telegram** | Group info + thread state | ~500 tokens max |

Constrained by `hooks.platform_context_max_tokens` (default 500). Truncated intelligently — metadata preserved, transcript trimmed.

---

## Claude Code Native Memory

The `.claude/memory/` directory contains files managed by the Claude Code SDK's memory system. These are NOT auto-injected by Resonant — the SDK handles them transparently during session lifecycle. The agent can read/write them via Bash tools.

---

## Full sc.mjs Command Reference

```
sc share /path/to/file
sc canvas create|create-inline|update|read|list|tag
sc voice "[tone tags] text"
sc routine create|list|status|enable|disable|reschedule|remove
sc pulse status|enable|disable|frequency
sc failsafe status|enable|disable|gentle|concerned|emergency
sc timer create|list|cancel
sc react last|last-N "emoji" [remove]
sc impulse create|list|cancel
sc watch create|list|cancel
sc tg text|photo|doc|gif|voice|react
sc search "query" [--thread] [--limit] [--role] [--after] [--before]
sc backfill start|status|stop
```

---

## Agent Read/Write Summary

| System | Read | Write | Auto-Inject |
|--------|------|-------|-------------|
| CLAUDE.md | Yes | No | Yes (always) |
| .claude/memory/ | Yes (Bash) | Yes (Bash) | No |
| Session handoff | Yes | Implicit | Yes |
| Orientation context | Yes | No | Yes |
| Life status / mood | Yes | No | Yes |
| Emotional markers | Yes | No | At compaction |
| Command Center | Yes (MCP) | Yes (MCP) | Partial (~100t) |
| Semantic search | Yes (CLI) | No | No |
| Digests | Yes (Bash) | No | No |
| Skills | Yes | Yes (Bash) | Yes (first msg) |
| Triggers | Yes | Yes (CLI) | Yes (count) |
| Timers | Yes | Yes (CLI) | No |
| Canvas | Yes (CLI) | Yes (CLI) | If referenced |
| Reactions | Yes | Yes (CLI) | Yes |
| Config keys | Yes | Yes | Partial |
| Platform context | Yes | No | Yes (if applicable) |
| Presence state | Yes | No | Yes |
