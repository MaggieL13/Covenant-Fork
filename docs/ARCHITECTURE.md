# Architecture

This doc is the working map of this repo's code. It's written for
whoever is modifying the repo. It is not a pitch. The README handles
what the product is and why it exists; this doc handles where code
lives, where ownership boundaries are, and why things are shaped the
way they are.

## Naming

- **Resonant** is the product/runtime identity — the companion framework
  this codebase implements.
- **Covenant-Fork** is this repository — a hardened, personalized fork
  of upstream Resonant.

Both names appear throughout the code. Usually they refer to the same
running system, but Covenant-Fork is the repo/customization layer and
Resonant is the product/runtime concept.

**`/shared/` (root) is NOT `packages/shared/`.** Two unrelated
directories whose names are easy to confuse:

| Path | Tracked? | Purpose |
|---|---|---|
| `/shared/` (repo root) | gitignored | Personal scratch + companion-writable directory. The Write tool's auto-share hook surfaces files written here as chat cards. Lives outside version control on purpose. |
| `packages/shared/` | tracked | npm workspace package containing TypeScript types shared between backend and frontend. Imported as `@resonant/shared`. |

The root `.gitignore` rule is anchored as `/shared/` (with the leading
slash) so only the root scratch directory is excluded; `packages/shared/`
is not affected. An earlier unanchored `shared/` rule had silently
blocked any new file under `packages/shared/` from being committable —
fixed and not to be reintroduced.

## Shape at a glance

Three packages in a pnpm workspace under `packages/`:

- `packages/backend/` — Node.js (ES modules, TypeScript). Runs the HTTP
  server, the WebSocket gateway, the Claude Agent SDK integration, the
  SQLite database, and any optional gateways (Discord, Telegram, voice).
- `packages/frontend/` — SvelteKit (Svelte 5 runes, TypeScript, static
  adapter). The chat UI, settings, Command Center routes, and canvas
  editor.
- `packages/shared/` — TypeScript types only. Wire contracts between
  frontend and backend (`Message`, `Thread`, `Canvas`, `Reaction`,
  etc.) plus the WebSocket protocol shapes. No runtime code.

Additional repo-level directories that matter:

- `data/` at repo root — SQLite database (`data/resonant.db`), WAL
  sidecars, `data/backups/` (gitignored). Default location resolved
  via `PROJECT_ROOT` in `packages/backend/src/config.ts`.
- `packages/backend/migrations/` — numbered SQL migrations and the
  migration authoring README.

## Runtime model

The backend is the source of truth. It owns persistence, agent
orchestration, gateway integrations, and serves the built frontend
as static files. The frontend is a reactive client over HTTP and
WebSocket, with shared contracts defined in `@resonant/shared`.

Startup order (cold boot): load config → initialize the database
(including running any pending migrations) → start the HTTP server →
attach the WebSocket upgrade handler → initialize optional gateways
and background services (Discord, Telegram, voice, orchestrator).
See `packages/backend/src/server.ts` for the canonical sequence.

## Principles

Eight things the code assumes without restating them per-file:

1. **Single-user architecture.** Auth is a password + cookie, not
   multi-tenant. Data structures, rate limits, and WebSocket registry
   assume one human user. Discord users who pair through the gateway
   are allowed guests, not additional tenants.
2. **Local-first.** SQLite on disk, no cloud sync of private content.
   The user's data lives in `data/resonant.db` and nowhere else unless
   they export.
3. **Companion is first-class.** The bot is not a chatbot — it has a
   persistent identity, memory anchors, and autonomous behavior
   (orchestrator, triggers, timers). The codebase reflects this:
   threads are ongoing relationships, not ephemeral sessions.
4. **Claude Agent SDK, not raw API.** The agent uses tool calling,
   MCP servers, and session continuity managed by the SDK. Direct
   Anthropic API calls are rare and deliberate.
5. **Svelte 5 runes are the current convention.** `$state`, `$derived`,
   `$effect`, `$props`. `export let` has been retired across the
   frontend during recent refactors; new frontend code should follow
   suit.
6. **TypeScript everywhere.** Frontend and backend both. Shared types
   live in `@resonant/shared` and are imported by both sides.
7. **Preservation-first refactors.** Recent batch refactors reorganized
   large swaths of the codebase; every one preserved exact runtime
   behavior. When in doubt, do not change semantics alongside
   reorganization.
8. **Load-bearing behavior is documented in code with `// ORDER:`
   comments.** If a sequence matters, a `// ORDER:` comment explains
   why. Respect these. See the Invariants section for the big ones.

## Timezone sovereignty

Every backend surface that produces a string a human or the agent will
read — agent context headers, Scribe timestamps, daily-thread names,
orchestrator wake labels, scheduled-fire times, timer responses, Discord
channel-history blocks — routes through `packages/backend/src/services/time.ts`.

**The rule.** `Intl.DateTimeFormat` and `Date.prototype.toLocaleString`
with a `timeZone` option are forbidden in user-visible backend code.
Node's bundled ICU lags IANA tzdata by months — Node 22.14 still ships
2024b, which doesn't know Paraguay abolished DST. `services/time.ts`
uses `moment-timezone`, which ships its own tzdata as data files
(2026a at time of writing). Updates flow via `npm update moment-timezone`,
not Node binary upgrades.

**Scope, deliberately narrow.** Sovereignty applies to wall-clock,
user-visible, scheduling-intent values. Plain UTC instants — `Date.now()`,
ISO timestamps written as IDs, debounce windows, rate-limit windows,
file mtimes, queue durations, persistence timestamps — are NOT under
sovereignty. JS `Date` is correct for those; over-correcting them
to moment-tz buys nothing and adds friction. The line is "does the
meaning depend on local civil time?". If yes, sovereignty layer; if
it's an instant or a duration, plain `Date`.

**Frontend.** Browser ICU updates more aggressively than Node's, so
`toLocale*` for display is acceptable on the frontend. The sovereignty
discipline is backend-side.

**Public surface (services/time.ts):**

| Helper | Purpose |
|---|---|
| `localTimeStr(tz, at?)` | "HH:mm" 24-hour wall clock |
| `localDateStr(tz, at?)` | "Wednesday, 22 Apr" |
| `localFullStr(tz, at?)` | "DD/MM/YYYY, HH:mm:ss" — used for timer `fire_at_local` |
| `localHour(tz, at?)` / `localMinute(tz, at?)` | integer accessors for DND / pulse / scheduling |
| `todayLocal(tz, at?)` | "YYYY-MM-DD" for day-keyed ledgers (digests, daily wins) |
| `offsetMinutes(tz, at?)` / `offsetString(tz, at?)` | offset accessors for SQLite date math |
| `parseLocalDateTime(tz, input)` | intent-aware parse: explicit `Z`/offset → absolute, offsetless → wall-clock in `tz`. Used by timer creation. |
| `tzdataInfo()` | diagnostics — moment-tz + tzdata versions |
| `parseCron(expr)` / `cronNextFireTime(expr, tz, from?)` / `isCronSupported(expr)` | cron parser + sovereignty-aware next-fire computation |

**Scheduling: `services/scheduler.ts::ScheduledTask`.** Replaces `croner`
for the orchestrator's needs. Same lifecycle subset (`stop` / `pause`
/ `resume` / `nextRun` / `isStopped` / `isBusy`). Internally uses
`cronNextFireTime` plus `setTimeout` with a recursive reschedule after
each fire — DST transitions and IANA updates flow through automatically
because the next-fire is recomputed from current tzdata every time.

Supported cron grammar (5-field strict POSIX, per `parseCron` /
`isCronSupported`): wildcard `*`, fixed integer, step `*/N`, range
`min-max`, list `v1,v2,v3`. Out-of-range integers are rejected at
parse time. Unsupported: 6-field croner-extended (with seconds),
step-within-range like `1-5/2`. The constructor's current error
message mentions only wildcards/fixed/step — that text predates the
range/list additions and should not be quoted as the supported set;
the parser is the source of truth.

`Orchestrator.resolveCronExpression(savedCron, defaultCron)` defends
startup against malformed persisted or YAML-overridden cron values:
invalid input falls back to the default with a loud warning rather
than throwing on construction.

## How to read this doc

Each section below maps one area of the codebase. Sections are short
enough to read end-to-end. If you need implementation detail, the
section points to the actual files.

- **Backend services** — the backend's internal anatomy
- **Database & migrations** — schema, the migration system, ownership
  of DDL
- **Frontend** — SvelteKit routes, component hierarchy, stores,
  composables, where UI code goes
- **WebSocket protocol** — the real-time gateway between frontend
  and backend
- **Shared contracts** — when a shape belongs in `@resonant/shared`
  vs staying package-local
- **Load-bearing invariants** — the "don't silently break these" list
- **Where to add new features** — ownership boundaries and workflow for
  the common change patterns

---

## Backend services

The backend is a layered Express app with a separate WebSocket gateway.
Entry point is `packages/backend/src/server.ts`. Everything else hangs
off it.

### Layers (top-down)

```
server.ts
  ↓
middleware/        — auth, CSRF, security headers, rate limiter
  ↓
routes/            — composition glue (api.ts) + domain routers
  ↓
services/          — the actual brains
  ↓
services/db/       — schema + queries; every persisted app state write
                     lands here
```

`server.ts` is the only file that wires all layers together. It loads
config, initializes the database (which also runs pending migrations),
deletes expired web sessions, loads the embedding vector cache,
constructs the service singletons (`AgentService`, `VoiceService`,
`PushService`, optional `DiscordService`, optional `TelegramService`,
`Orchestrator`), attaches the WebSocket server, and mounts the HTTP
routes. It also owns static serving for the built frontend and the
`/stickers` asset directory. Nothing else does cross-layer wiring.

### Middleware

`packages/backend/src/middleware/` holds security and auth primitives.
Global stack mounted in `server.ts` (order matters):

1. `helmet` — CSP, frame options, COOP/CORP headers.
2. `securityHeaders` — additional response headers.
3. `rateLimiter` — applied only to `/api` and `/mcp` routes, not static
   assets.
4. `cors` — origins driven by `config.cors.origins` plus localhost in dev.
5. Body parsers (10MB limit).
6. `/api` router from `routes/api.ts`.

Inside the API router, auth is applied selectively: public routes
(`/health`, `/auth/*`, `/identity`, `/setup/*`, `/internal/*`) come
first, then `authMiddleware` and `csrfProtection` gate everything else.
See `routes/api.ts` for the exact ordering. If you add a route that
should be public, mount it BEFORE `router.use(authMiddleware)` in that
file.

`middleware/localhost.ts` provides a `requireLocalhost` guard used
route-locally by sensitive bootstrap/internal surfaces
(`routes/internal.ts`). It is NOT part of the global stack.

### Routes

`routes/api.ts` is composition glue — it mounts domain-specific routers
and enforces the public-vs-authenticated authorization boundary. Each
domain router owns its own URL prefix and its own handler logic:

- `threads.ts`, `canvases.ts`, `stickers.ts`, `files.ts`, `search.ts` —
  CRUD-shaped resources
- `config-admin.ts`, `discord-admin.ts`, `orchestrator-admin.ts`,
  `push-admin.ts` — admin surfaces for each subsystem
- `setup.ts`, `internal.ts` — bootstrap-only endpoints
- `voice.ts` — transcription and TTS
- `cc-routes.ts` — Command Center API. Mounted lazily from `api.ts`
  via `initCcRoutes()` only when `config.command_center.enabled` is true.

`cc-mcp.ts` is a separate concern: it's mounted directly from
`server.ts` at `/mcp/cc` (outside the main `/api` router), conditional
on the same config flag. It serves MCP protocol traffic, not REST.

Routes do request shaping, response formatting, and authorization
boundary enforcement. Business logic belongs in services.

### Services

`packages/backend/src/services/` is where actual work happens. Four
centers of gravity:

- **`db/`** — all schema and queries. Split into domain modules
  (`threads`, `messages`, `canvases`, `stickers`, `sessions`, `config`,
  `reactions`, `digests`, `embeddings`, `push`, `state`, `timers`,
  `triggers`, `init`). Barrel exports at `services/db.ts` and
  `services/db/index.ts` keep import paths stable. Migration runner
  and predicates live here too — see the Database & migrations section.
- **`ws/`** — WebSocket gateway split into `socket.ts` (lifecycle +
  auth + upgrade), `events.ts` (message dispatcher), `handlers/`
  (per-message-type handlers), and `shared.ts` (tiny helpers).
  Facade at `services/ws.ts`. The `registry.ts` connection tracker
  lives as a sibling at `services/registry.ts` (NOT under `ws/`) —
  it pre-dates the WS split and stays at services root. See the
  WebSocket section.
- **`agent.ts` (`AgentService`)** — the Claude Agent SDK wrapper. Owns
  the conversation lifecycle, tool registration, MCP server integration,
  and streaming to connected clients. Single instance shared between
  the WebSocket and the orchestrator.
- **`orchestrator.ts` (`Orchestrator`)** — autonomous scheduling. Owns
  wake prompts, trigger evaluation, timer firing, and push dispatch.
  Started at boot, stopped during graceful shutdown.

Optional gateways (conditionally constructed):

- **`discord/`** — Discord bot integration. Constructed only if
  `discord.enabled` config + `DISCORD_BOT_TOKEN` env var both present.
- **`telegram/`** — Telegram bot integration. Same pattern.
- **`voice.ts` (`VoiceService`)** — TTS and transcription. Constructed
  unconditionally but no-ops if credentials missing.
- **`push.ts` (`PushService`)** — Web Push via VAPID. Constructed
  unconditionally but disabled if VAPID keys missing.

Leaf helpers (single-purpose, stateless where possible):

- `hooks.ts` — context injection before agent calls (time awareness,
  conversation flow, presence markers)
- `commands.ts` — slash command registry for the chat composer
- `digest.ts` — daily digest generation via Scribe
- `semantic-search.ts`, `embeddings.ts`, `vector-cache.ts` — embedding
  pipeline for message/digest search
- `life-status.ts`, `audit.ts`, `triggers.ts` — orchestrator support
- `skills.ts`, `sticker-admin.ts`, `config-files.ts`, `files.ts` —
  resource management for specific route families
- `cc.ts` — Command Center service surface

### Side effects

Where state changes happen:

- **Database writes** — only inside `services/db/` modules. Callers
  pass plain data; the module handles SQL. Never write SQL in routes
  or other services.
- **WebSocket broadcasts** — only via `registry.broadcast()` or
  `registry.broadcastExcept()`. Other services call these; handlers
  also use them.
- **Timers** — only inside `Orchestrator`. Services that need
  scheduling register with the orchestrator rather than spinning up
  their own `setInterval`.
- **External network calls** — agent (Claude API via SDK), voice
  (ElevenLabs + Groq), push (Web Push endpoints), Discord/Telegram
  gateways. Contained in their respective services; wrapped in
  try/catch with graceful fallback.
- **File system writes** — files service (uploaded attachments),
  sticker-admin (sticker asset uploads), backup script (db backups).
  All writes go through helpers that validate the path stays inside
  `data/`.
- **Static asset serving** — owned by `server.ts`, not by any route
  module. The frontend build and the `/stickers` directory are served
  via `express.static` directly from the server entry point.

### Extensibility

To add a new backend capability:

1. If it needs persistence → start by adding a migration under
   `packages/backend/migrations/` and a query module under
   `services/db/`.
2. If it's a new domain with HTTP endpoints → add a new router under
   `routes/` and mount it from `routes/api.ts`.
3. If it's a new WebSocket message type → add a handler under
   `services/ws/handlers/` and a case in `services/ws/events.ts`.
   Shared types go in `@resonant/shared`.
4. If it's a long-running background job → register it with the
   orchestrator. Do not spawn timers in a new top-level module.
5. If it's an integration with an external service → follow the
   gateway pattern: construct conditionally based on config and
   env credentials, own graceful start/stop, expose a narrow surface
   to the rest of the app.

---

## Database & migrations

SQLite is the only structured persistence layer. User-scoped and
session-scoped state lives in one database file; file-backed assets
and operational artifacts live under `data/`, while static config
and secrets live at the repo root.

### What lives where

**SQLite (`data/resonant.db`):**
- Threads, messages, sessions, reactions, canvases
- Sticker packs and sticker metadata (the image files themselves live
  on disk)
- Config values (feature toggles, runtime settings) via the `config`
  key/value table
- Discord pairings, web sessions, audit log, push subscriptions
- Orchestrator state: timers, triggers, session history
- Embedding vectors (message and digest), outbound queue

**Files on disk (under `data/`):**
- `data/resonant.db`, `data/resonant.db-wal`, `data/resonant.db-shm`
  — SQLite main file plus WAL sidecars. Always move all three
  together, or use `npm run db:backup` for an atomic snapshot.
- `data/backups/` — `VACUUM INTO` snapshots (gitignored). Keeps the
  10 most recent by default.
- `data/files/` — user-uploaded attachments (images, audio, generic
  files). Referenced from `messages.metadata`.
- `data/stickers/` — sticker image files (PNG/WEBP). Referenced from
  `stickers.filename`.
- `data/digests/` — daily digest markdown files written by
  `services/digest.ts` and read by `services/hooks.ts` for
  context injection. Companion DB table (`digest_embeddings`) holds
  the semantic index.

**Config file (`resonant.yaml`, repo root):**
- Server host/port/db_path, auth password, CORS origins
- Identity (companion_name, user_name, timezone)
- Feature toggles for voice, Discord, Telegram, orchestrator,
  Command Center
- Agent model preferences, MCP server definitions
- Loaded at startup and cached by `packages/backend/src/config.ts`;
  `reloadConfig()` is available for explicit refresh.
- Specific runtime-overridable keys (for example `agent.model`,
  `discord.*`, `failsafe.*`) are also stored in the `config` table
  and read via `getConfigBool` / `getConfigNumber` / `getConfigString`
  helpers that fall back to the YAML value. For those specific keys
  the DB entry wins. Most YAML values are not DB-shadowed — they
  come straight from the file.

**Env vars (`.env` at repo root):**
- Secrets only: `APP_PASSWORD`, `DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `ELEVENLABS_API_KEY`, `GROQ_API_KEY`, `VAPID_*`.
- Never committed (gitignored).

### SQLite setup

Database is opened with WAL journal mode and a 5000ms busy timeout
(see `services/db/init.ts`). WAL mode allows concurrent reads while
writes are pending. The busy timeout serializes concurrent startup
attempts.

Schema modules under `services/db/`:

| Module | Responsibility |
|---|---|
| `init.ts` | Open DB, set pragmas, run migrations, seed config |
| `state.ts` | Process-wide DB handle access (`getDb()`) — all other modules import this |
| `threads.ts` | Thread CRUD + activity tracking |
| `messages.ts` | Message CRUD + async embedding enqueue |
| `canvases.ts` | Canvas CRUD with detach-on-thread-delete behavior |
| `stickers.ts` | Sticker packs + individual stickers |
| `sessions.ts` | Session history + web session cookies |
| `config.ts` | Key/value config table accessors |
| `reactions.ts` | Reactions attached to messages |
| `digests.ts` | Scribe daily digests (DB-side metadata/embeddings) |
| `embeddings.ts` | Message + digest vector storage |
| `push.ts` | Web push subscription storage |
| `timers.ts`, `triggers.ts` | Orchestrator scheduling state |
| `migrate.ts` | Migration runner (Batch 7) |
| `migration-predicates.ts` | Bootstrap detection predicates |

### The migration system

As of Batch 7, all schema DDL lives in numbered `.sql` files under
`packages/backend/migrations/`. Startup invokes `runPendingMigrations()`
from `services/db/migrate.ts` before any runtime seed/config writes.
A `_migrations` ledger table records what's applied and whether each
was executed fresh or bootstrapped from a pre-existing schema.

Three CLI commands expose the runner:

- `npm run db:migrate` — apply pending migrations (auto-backup first)
- `npm run db:status` — read-only ledger readout
- `npm run db:backup` — standalone `VACUUM INTO` snapshot

Full authoring guide: `packages/backend/migrations/README.md`. This
section only covers the architectural framing.

### 001/002 vs 003+

`001_init.sql` and `002_command_center.sql` are the canonical
fresh-install baseline. They use `CREATE TABLE IF NOT EXISTS` because
they predate the ledger and were historically re-run on every boot.
**Do not edit them, do not rename them, do not split them.** Treat
them as immutable.

Every migration from `003_canvases_tags.sql` onward is plain DDL —
no `IF NOT EXISTS`, no try-catch, no idempotency tricks. Idempotency
comes from the ledger: the runner only executes migrations whose
version isn't already marked applied. New migrations follow this
pattern by default.

One documented exception: the `-- @pragma-outside-tx` file directive.
Migrations that genuinely cannot run inside a transaction (for
example, schema surgery that needs `PRAGMA foreign_keys=OFF`) use
this directive and are executed outside the normal transaction wrap.
Reserved for rare cases; see the migration README for the rules and
the recovery story when such a migration fails partway.

### Bootstrap predicates

The single most important piece of the migration system is bootstrap
detection. Long-running production databases were populated by inline
DDL that ran on every boot before Batch 7. When the migration runner
first meets that database, it must correctly recognize which
migrations' effects are already present and mark them applied without
re-executing the SQL.

That recognition lives in `services/db/migration-predicates.ts`. Each
migration version has a predicate — a read-only function that returns
`true` if the schema already has that migration's effect. The runner
scans registered predicates contiguously from 1 upward; satisfied
ones get ledger rows with `bootstrapped=1`. If any predicate beyond
the first unsatisfied one is also satisfied, that's non-linear drift,
and the runner aborts with `NonLinearSchemaError` — that state
indicates manual intervention is required, and the runner refuses
to "help."

Predicates matter because a missing or weak predicate causes the
runner to re-execute already-applied DDL — duplicate column errors,
duplicate table errors, worst case data loss on a rebuild. When
adding a migration, register its predicate. Never ship a migration
without one.

Predicates use structural checks (`tableExists`, `columnExists`,
`indexExists`). Avoid string-matching on `sqlite_master.sql`. A
behavioral savepoint probe is available for CHECK-constraint
migrations (see `messagesAllowsStickerContentType` in the same file);
reserve it for cases where structural checks genuinely can't work.

### Adding a schema change

Do not add inline DDL to `services/db/init.ts`. It's now a composition
shell. Any attempt to add `ALTER TABLE` or `CREATE TABLE IF NOT EXISTS`
there reintroduces exactly the drift Batch 7 eliminated.

Instead:

1. Create the next-numbered `.sql` file under
   `packages/backend/migrations/`. Plain DDL. No `IF NOT EXISTS`.
2. Register its predicate in `migration-predicates.ts`. Use
   structural checks.
3. Add a predicate test in `services/db/migrate.test.ts`.
4. Run `npm test`. The integration test at the bottom of the suite
   auto-expands to cover any new registered predicate and will fail
   loudly if the new migration doesn't produce a schema the predicate
   recognizes.
5. If you're deploying to a live database, run `npm run db:backup`
   first, then let startup apply the migration or run
   `npm run db:migrate` explicitly.

Full gotchas and the `@pragma-outside-tx` directive for
non-transactional migrations: `packages/backend/migrations/README.md`.

---

## Frontend

SvelteKit with the static adapter. Output is a folder of static files
that the backend serves. No SSR — the backend is the dynamic side;
the frontend is a reactive client.

### Routes

`packages/frontend/src/routes/` follows SvelteKit conventions:

- `+layout.svelte` / `+layout.ts` — top-level layout and load hooks,
  including auth redirect logic
- `+page.svelte` (root) — landing/redirect shell
- `+error.svelte` — error boundary
- `login/` — password gate
- `setup/` — first-run setup wizard
- `chat/` — the main chat UI (the refactor-heaviest surface)
- `settings/` — preferences, Discord panel, MCP servers
- `files/` — file browser for uploaded attachments
- `cc/` — Command Center sub-app (conditionally available based on
  `config.command_center.enabled`)

The preferred pattern is route-as-shell: route files read from stores,
call composables, and compose child components. Business logic and
reusable UI lives under `lib/`. Not every route is as composition-light
as the chat page, but that's the direction.

### The chat page composition

`routes/chat/+page.svelte` is the canonical example of the "route as
shell" discipline. After the Batch 5 refactor it became a composition
shell rather than a monolith — imports, state wiring, effect
registration, and child-component mounting. No inline business logic
beyond orchestration.

It composes:

- **Chat chrome** — `ChatHeader`, `ChatSidebar`, overlays
  (`NewThreadModal`, `SearchOverlay`, `CanvasDrawer`)
- **Message region** — `MessageList` (extracted in Batch 5.4 with
  getter-as-state ref handoff; see the Load-bearing invariants section)
- **Composer** — `MessageInput` plus its subtree (the inline send
  button stays in the parent by design — see invariants)
- **State sources** — `websocket.svelte.ts` store (connection,
  messages, threads, streaming, tool events, rate limits)
- **Composables** — `lib/chat/*.svelte.ts` factories for auto-scroll,
  older-messages loading, read-receipt observer, keyboard shortcuts

### Component hierarchy

`packages/frontend/src/lib/components/` holds the UI leaves. The
refactor batches (5 and 6) grouped related components into subdirectories:

- `components/chat/` — chat-page-specific structural pieces
  (header, sidebar, overlays, message list)
- `components/message-bubble/` — the subcomponents rendered inside
  a single message (content, media, meta, footer controls, tool
  activity panel, read-aloud control)
- `components/message-input/` — composer subcomponents (reply banner,
  attachment tray, canvas ref tray, composer textarea, pickers,
  autocomplete, command palette wrapper)
- `components/discord-panel/` — Discord admin surface (status, pairings,
  settings, rules editors, guild/channel browser, activity logs)
- `components/preferences-panel/` — settings cards (general, model,
  auth, personality editor, MCP servers editor)

Top-level components in `lib/components/` that are reused across
routes or not subdivided: `Canvas`, `CommandPalette`, `ConfirmDialog`,
`ConnectionStatus`, `ModelSelector`, `PresenceIndicator`,
`SearchPanel`, `StickerManager`, and the `Res*` primitives
(`ResCheckbox`, `ResEmpty`, `ResRating`, `ResSkeleton`).

Svelte 5 runes (`$props`, `$state`, `$derived`, `$effect`) throughout.
No `export let` remains in the frontend; new components should follow.

### Stores

`packages/frontend/src/lib/stores/` holds the cross-route reactive
state. Files use the `.svelte.ts` extension because they contain
rune state that survives across components:

- `websocket.svelte.ts` — the big one. Owns connection state,
  messages, threads, active thread, streaming state, unread counts,
  pending-send count, tool events, context usage, compaction notices,
  canvases, rate limit info, command results. Exposes helpers
  (`connect`, `disconnect`, `send`, `loadThread`, etc.) plus a pile
  of `get*()` accessors that return the current rune-backed values.
- `settings.svelte.ts` — identity, companion name, Command Center
  toggle, and other identity/settings surface state.
- `stickers.svelte.ts` — sticker pack + individual sticker state
  for the composer autocomplete and picker.
- `toast.svelte.ts` — transient notification queue.
- `auth.svelte.ts` — auth state for login gate and logout flow.

Stores are singletons in practice — import them anywhere, reactive
reads just work. They're module-level rune state (`$state` and
`$derived` at module scope), not Svelte 4 store contract objects
(`writable` / `readable` with `.subscribe()`). Contributors coming
from classic Svelte stores should expect `getSomething()` accessor
functions, not `$` prefix subscriptions.

### Chat composables

`packages/frontend/src/lib/chat/` is a distinct concept from
`lib/components/chat/`. Composables are factory functions (not
components) that encapsulate non-visual logic used by the chat page:

- `auto-scroll.svelte.ts` — the scroll-to-bottom + stick-to-bottom
  state machine for the message list
- `older-messages.svelte.ts` — infinite-scroll older-message loading
  with scroll-position preservation
- `read-observer.svelte.ts` — IntersectionObserver wiring for marking
  messages as read when the sentinel becomes visible
- `keyboard-shortcuts.svelte.ts` — global shortcut handler
  (Ctrl/Cmd+K, Escape priority chain)

Each exports a `create*Controller(deps)` factory that returns a
state/actions object. The calling component owns `$effect` wiring and
any `bind:this` DOM refs. Composables receive refs via getter callbacks
(`getContainer: () => HTMLElement | null`) so the same factory can
target DOM that lives inside a child component. See
`routes/chat/+page.svelte` for how they're wired together.

### WebSocket-driven state

The frontend never mutates persisted state directly. Every state
change comes from either:

- **Local UI state** — modal visibility, dropdown open/close, form
  drafts. Lives in `$state` inside components.
- **Remote state via WebSocket** — messages, threads, canvases,
  streaming, tool events, presence. Lives in `websocket.svelte.ts`.

The flow: user action → component fires a handler → handler calls a
store helper (e.g., `send({ type: 'message', ... })`) → backend
processes and broadcasts → store's WebSocket message handler updates
rune state → every component reading that state re-renders.

Two invariants worth naming here:

- Components never reach across the boundary to the backend directly
  (no `fetch` in leaf components). HTTP calls go through
  `lib/utils/api.ts`. REST/HTTP is the path for request-response
  admin/file/config work; WebSocket is the primary path for live chat
  state.
- The WebSocket store is the effective source of truth for remote
  state. If a component is showing stale data, first suspect the
  store's message handler and state wiring before blaming the
  component.

Message and WebSocket payload shapes that cross the backend/frontend
boundary belong in `@resonant/shared`. See the Shared contracts
section for the rules.

### Load-bearing seams (don't merge these back)

Five seams established by the refactor batches that look like they
could be flattened but must not be:

- **Chat page as composition shell.** `routes/chat/+page.svelte` is
  short because its children own details. Putting logic back inline
  re-creates the 1535-line monolith that was split in Batch 5.
- **`MessageList` ref handoff via `onregisterrefs`.** The message
  container and sentinel refs live inside `MessageList`; the page
  receives them via callback. Composables consume the page's getter
  functions. This lets auto-scroll and read-observer target the real
  DOM without the page owning `bind:this`.
- **Send button inline in `MessageInput` parent.** Not extracted into
  `ComposerPickers`. The send/stop button renders on the right side
  of the textarea in the existing layout; moving it into the action
  rail on the left is a regression (Batch 6.3 hotfix).
- **Code-copy registration inside `MessageBubble`.** The markdown
  code-copy effect stays on the parent component because it depends
  on the post-render markdown DOM; moving it into a display-only
  child broke it once already.
- **`CommandPalette` parent-mounted, not inside `ComposerTextarea`.**
  The parent delegates keyboard events to the palette via
  `handleKey(event)`. Moving the palette into the textarea shell
  would require tunneling a component ref through a shell seam.

Each of these has `// ORDER:` comments at the relevant call sites
explaining the "why." Respect them.

### Styling

Global styles at `app.css` and `resonant.css`. Component-scoped styles
use Svelte's default scoped `<style>` blocks. Shared form selectors
(used across the preferences-panel children) are wrapped in
`:global(...)` inside `PreferencesPanel.svelte` so child components
inherit the styling without duplicating it.

---

## WebSocket protocol

The primary real-time path between browser and backend. Live message
streaming, presence, reactions, canvas edits, voice transcription,
and tool events all flow here. REST remains the path for
request-response admin surfaces; WebSocket is the path for anything
that needs to feel immediate.

### Files

`packages/backend/src/services/ws/`:

- `ws.ts` (one level up, at `services/ws.ts`) — compatibility facade.
  Owns the module-level singletons for voice service and gateway
  services, exports `createWebSocketServer`, `setVoiceService`,
  `setGatewayServices`, and the `registry`. All other ws.* imports
  go through here.
- `socket.ts` — upgrade handling, origin validation, session
  authentication, connection bootstrap, heartbeat loop, close/error
  cleanup. The lifecycle layer.
- `events.ts` — the dispatcher. Parses incoming messages, applies
  rate limiting and size limits, routes to the right handler.
- `handlers/` — one file per message-type family: `messages.ts`,
  `sync.ts`, `status.ts`, `voice.ts`, `canvases.ts`, `reactions.ts`,
  `threads.ts`, `commands.ts`, `mcp.ts`.
- `shared.ts` — tiny helpers used across handlers (`sendError`,
  `threadsToSummaries`).
- `registry.ts` (at `packages/backend/src/services/registry.ts`,
  sibling of the `ws.ts` facade, NOT under `ws/`) — connection
  tracking, user-to-socket mapping, per-IP connection cap,
  activity-touch state, broadcast primitives.

### Connection handshake

1. Browser opens a WebSocket upgrade against the backend server on
   the same host/port as the HTTP API, with the session cookie
   attached.
2. `socket.ts` receives the HTTP upgrade:
   - Origin check against `config.cors.origins` + localhost defaults.
     Rejected origins get `403 Forbidden` before any WS state is
     allocated.
   - If `config.auth.password` is set, the `resonant_session` cookie
     is validated against the `web_sessions` table. Missing or
     expired session → `401 Unauthorized`.
   - If both checks pass, the upgrade proceeds.
3. On successful upgrade, the new socket is registered via
   `registry.add(userId, ws, ip)`. Per-IP cap (default 10)
   enforced here — excess connections get closed with code 1008.
4. Server sends a `connected` bootstrap message containing
   `sessionStatus`, `threads`, `activeThreadId`, and (optionally)
   `commands` — the exact shape is defined in
   `packages/shared/src/protocol.ts`. The client renders the chat UI
   from this payload.
5. `canvas_list` is sent as a follow-up if any canvases exist.

Order of these steps is load-bearing. `// ORDER:` comments in
`socket.ts` document each: origin before auth before handleUpgrade,
registry add before bootstrap send, `connected` before `canvas_list`.

### Registry

`services/registry.ts` owns every live socket. Responsibilities:

- **Per-user connection sets.** Multiple tabs/devices can be open;
  the registry tracks them as one user's set of sockets.
- **Per-IP connection cap.** Hard cap (10) to prevent a single
  misbehaving client from monopolizing the gateway.
- **Broadcast primitives.** `broadcast(msg)` sends to every open
  socket. `broadcastExcept(senderWs, msg)` sends to everyone else
  (used for canvas updates so the sender's live cursor doesn't
  jump).
- **Activity timestamps.** `touchUserActivity()` records the last
  time the user did anything; `touchUserWebActivity()` is web-only
  (used by the chat-side activity surface, not orchestrator presence).
  Presence state and "idle for N minutes" queries read from here.
- **Device/tab visibility.** Tracks which of the user's connections
  are on desktop vs mobile, which tab is currently visible. Used
  by presence reporting and TTS auto-play.

All writes to remote state that should reach connected clients go
through one of the broadcast helpers. No direct `ws.send(...)` calls
for state updates; direct sends are for sender-only echoes
(`sync_response`, `canvas_list`, errors).

### Dispatcher (`events.ts`)

The dispatcher is what runs on every inbound message. Flow:

1. Parse JSON. Invalid JSON → `error` with code `invalid_message`.
2. Rate limit: 120 messages/minute/socket, with `pong` and
   `visibility` exempted (they're frequent heartbeat traffic).
   Over limit → `error` with code `rate_limited`.
3. Size limit: 10KB for text messages, 512KB for `voice_audio`
   chunks. Over limit → `error` with code `message_too_large`.
4. Parse the inbound payload. The `ClientMessage` union is defined
   in `@resonant/shared`, but the backend currently relies on
   TypeScript typing plus per-handler assumptions after JSON parsing;
   it does not yet enforce full runtime message-shape validation at
   the dispatcher. `isClientMessage()` exists in
   `packages/shared/src/protocol.ts` as a typed guard and is a
   candidate for future hardening here.
5. Switch on `clientMsg.type`, touch activity where appropriate,
   delegate to the matching handler.

`attachMessageHandler` is primarily a switch-based dispatcher.
Adding a new message type means adding one case and one handler
file.

### Handlers

Each handler file is a small module that takes the typed message
plus dependencies and does one thing. Examples (not exhaustive —
see `handlers/` for the full set):

- `messages.ts` — `handleMessageSend` (the main "user sent a message"
  path — includes file attachment handling, prompt construction,
  agent invocation, optional auto-TTS)
- `sync.ts` — `handleSync`, `handleRead`, `handleSwitchThread`,
  `handleCreateThread`
- `status.ts` — `handleRequestStatus` (agent presence, queue depth,
  MCP status, connection counts, optional gateway stats)
- `voice.ts` — `handleVoiceStart`, `handleVoiceAudio`, `handleVoiceStop`,
  `handleVoiceMode`, plus `generateAndStreamTTS` for companion
  responses
- `canvases.ts` — canvas create/update/delete/list. Update uses
  `broadcastExcept` to skip the sender.
- `reactions.ts` — add/remove reactions on messages.
- `threads.ts` — pin/unpin threads.
- `commands.ts` — slash commands from the composer.
- `mcp.ts` — MCP server reconnect/toggle.

Handlers are pure functions plus websocket sends. They never own
timers or long-lived state. Anything stateful (TTS playback
sequencing, prosody abort controllers) is attached to the
`ExtendedWebSocket` itself and cleaned up on close.

### Message shapes

Full client-to-server and server-to-client message shapes live in
`packages/shared/src/protocol.ts`. The `ClientMessage` and
`ServerMessage` type unions are exhaustive; this doc does not
duplicate them.

Rule: if a message shape crosses the WebSocket boundary, it belongs
in `protocol.ts`, not in a package-local file. See the Shared
contracts section.

### Activity-touch pattern

Many handlers call `registry.touchUserActivity()` and
`registry.touchUserWebActivity()` before delegating. These two
timestamps drive:

- Companion presence (idle/active) reported via `request_status`
- Orchestrator failsafe thresholds (inactivity-triggered wake prompts)
- Auto-TTS gating (only auto-play if the tab is recently active)

Messages that don't represent user intent (`pong`, `visibility`,
`sync`, `request_status`, `stop_generation`, `mcp_*`, `rewind_files`,
the voice audio stream itself) do NOT touch activity. Messages that
do (`message`, `read`, `switch_thread`, `create_thread`, `voice_start`,
`voice_stop`, all `canvas_*`, `add_reaction`, `remove_reaction`,
`pin_thread`, `unpin_thread`, `command`) do, before dispatch. The
dispatcher enforces this via a small `touchActivity()` helper;
handlers don't each call both methods themselves.

### Heartbeat

`socket.ts` runs a 30-second `setInterval` that sends `ping` to every
socket. Clients respond with `pong`. Sockets that miss a pong between
intervals get `terminate()`'d. This is WS-layer keepalive, not
application-layer presence.

### Adding a new message type

1. Add the new `{ type: 'foo', ... }` shape to both `ClientMessage`
   (if inbound) and `ServerMessage` (if outbound) in
   `packages/shared/src/protocol.ts`.
2. Add a handler function in an existing `handlers/*.ts` file, or a
   new file if the domain warrants one.
3. Add a case in `events.ts`'s switch, calling the handler. Touch
   activity if the message represents user intent.
4. If the handler needs to broadcast, use `registry.broadcast()` or
   `registry.broadcastExcept()`. Do not call `ws.send(...)` directly
   for state updates.

---

## Shared contracts

`packages/shared/` is the package dedicated to code shared by
frontend and backend. It is types-only — no runtime business logic,
no state, no I/O. There's one small runtime exception:
`isClientMessage()`, a pure typed guard. That exception is not an
open door; the package is still a types-only package in practice and
intent.

### Shape

Two files under `packages/shared/src/`:

- `types.ts` — application data models. Shapes the app passes around
  in memory, over HTTP, or through the database layer: `Thread`,
  `Message`, `Reaction`, `Canvas`, `Sticker`, `StickerPack`,
  `ThreadSummary`, `SearchResult`, `SystemStatus`, `McpServerInfo`,
  `OrchestratorTaskStatus`, `SessionRecord`, `AuditEntry`,
  `WebSession`, `ConfigEntry`. Plus string-literal types that appear
  in wire traffic (`PresenceStatus`, `Platform`, `ReactionUser`,
  `MessageSegment`).
- `protocol.ts` — the wire shapes. `ClientMessage` and `ServerMessage`
  discriminated unions for every WebSocket payload direction. Plus
  supporting types used only in the WS layer
  (`CommandRegistryEntry`) and the `isClientMessage()` guard.

Both are re-exported from `packages/shared/src/index.ts`, so
consumers import from `@resonant/shared` without needing to know the
file split.

### Import convention

Both the backend and frontend import types from the same
`@resonant/shared` package identifier:

```ts
import type { Message, Thread, Reaction } from '@resonant/shared';
import type { ClientMessage, ServerMessage } from '@resonant/shared';
```

Types are always imported with `import type` when only used as
annotations — that way the build dead-strips the import completely
and no runtime coupling is created. The one exception is
`isClientMessage` (a runtime function); it uses a regular `import`.

### Split logic: types.ts vs protocol.ts

The rule is mechanical:

- If the shape is a shared domain/data model used by both sides, it
  goes in `types.ts`.
- If the shape is a transport envelope sent over WebSocket, it goes
  in `protocol.ts`.

A domain type referenced inside a wire message (`Message` inside
`ServerMessage`'s `{ type: 'message'; message: Message }` variant)
still lives in `types.ts`; `protocol.ts` imports it. Types flow one
direction: protocol can depend on domain, domain does not depend on
protocol.

### When to put a shape in `@resonant/shared`

A shape belongs in the shared package when **both** frontend and
backend need to know it. That's the only criterion.

Things that should move there:

- Anything that crosses the HTTP or WebSocket boundary in either
  direction.
- Entity shapes that both sides construct or parse (because the
  backend writes them and the frontend reads them, or vice versa).

Things that should NOT move there:

- Internal implementation details of a single package. A backend
  service's argument object, a frontend component's prop type —
  these stay package-local.
- UI-specific view models. Frontend may derive its own interfaces
  from a shared entity, but the derived interface stays in the
  frontend.
- Database query shapes. Return types of `services/db/*` functions
  use the shared entity types, but any query-specific shape
  (filtered selections, aggregations) lives in the db module.
- Don't move a type to shared just to avoid duplicate imports inside
  one package. "Used twice in the backend" is not a reason; "used
  by the frontend too" is.

### Discipline

- **No runtime code.** `packages/shared/src/` contains type
  declarations and one pure type-guard function. It does not import
  any runtime dependency. Don't add one without serious justification
  — it would couple both frontend and backend bundles to that
  dependency.
- **Shared changes are cross-package API changes.** Changing a shape
  in shared changes it for both frontend and backend simultaneously.
  For additive changes (new optional field), both sides just need a
  rebuild. For breaking changes (renamed field, changed type), both
  sides must update in lockstep. Plan these carefully.
- **No circular imports inside shared.** Keep `types.ts` and
  `protocol.ts` in their one-way dependency (protocol depends on
  types, never the reverse).

### Adding a new shared shape

1. Decide: is this a domain data model or a wire message? Use the
   mechanical split above.
2. Add the type to the appropriate file in `packages/shared/src/`.
3. Export is automatic via `index.ts`'s re-export.
4. Import from `@resonant/shared` in the consuming package(s). Use
   `import type` unless you're importing a runtime guard.

---

## Load-bearing invariants

The behaviors below look like things that could be simplified,
reordered, or merged during refactoring. They cannot be, without
visible regressions. Many are marked with `// ORDER:` comments in
code; others are enforced by tests or structural seams. This section
is the master list; earlier sections reference items here.

### Database & schema

- **Migration predicates must exactly match `initDb` output.** The
  integration test at the bottom of
  `packages/backend/src/services/db/migrate.test.ts` asserts this by
  running `initDb(':memory:')` and checking every registered
  predicate returns `true`. If a future init.ts edit removes a schema
  element, or a predicate stops matching what init produces, this
  test fails loudly. Don't disable it.
- **Bootstrap ledger inserts are atomic.** All predicate-matched
  migrations get marked applied in one transaction. A mid-bootstrap
  crash leaves `_migrations` empty so the next boot can retry
  cleanly. Don't split this into per-row writes.
- **Non-linear schema aborts, never guesses.** If predicate N is
  unsatisfied but a later predicate is satisfied, the runner throws
  `NonLinearSchemaError`. Manual intervention is required in that
  case. Don't "help" — the silent-recovery code path is a data-loss
  vector.
- **Detached canvas on thread delete.** Deleting a thread does NOT
  cascade to delete its canvases. The canvas's `thread_id` is set to
  `NULL` instead, so the canvas remains accessible from the canvas
  list. See `deleteThread()` in `services/db/threads.ts`. This
  behavior has a test in `db.test.ts`.
- **Async embedding enqueue.** `createMessage()` in
  `services/db/messages.ts` enqueues the new message for embedding
  without waiting for the embedding to compute. Messages must appear
  in the UI immediately; embeddings catch up asynchronously.
- **Telegram metadata normalization.** Telegram voice notes and
  photos write `metadata.fileId` (alongside legacy `voiceFileId` /
  `photoFileId` for any historical readers), and the message's
  `content_type` is selected from the metadata shape: voice → `audio`,
  photo → `image`, text-only → `text`. The Library page
  (`/api/files/list`), the per-thread Files panel
  (`FilePanel.svelte`), and `db/threads.ts::deleteThread` each fall
  back through `fileId → voiceFileId → photoFileId` so historical
  pre-normalization rows still surface and are cleaned up correctly
  without a backfill.
- **Trigger evaluation per-row safety.** `Orchestrator.checkTriggers`
  parses every active trigger's conditions JSON to determine
  whether life-status fetch is needed for the tick. The parse is
  wrapped per-row so a single malformed conditions blob logs and
  is skipped, instead of throwing out of the `.some()` loop and
  killing every other valid trigger that tick.

### WebSocket ordering

All in `packages/backend/src/services/ws/`. Each has an `// ORDER:`
comment at the call site.

- **Origin check before auth before `handleUpgrade`.** In `socket.ts`.
  Rejected cross-origin sockets must never get access to session
  validation or WS state. If you move origin validation after auth,
  an unauthenticated origin check failure leaks session-validation
  timing.
- **Registry add before bootstrap send.** New sockets are added to
  the registry before the `connected` message is sent. Broadcasts,
  presence checks, and connection counts must match the visible
  connection state.
- **`connected` before `canvas_list`.** Clients expect the connected
  message first; canvas list is an optional follow-up. Reversing this
  breaks client-side state setup.
- **30-second heartbeat cadence.** `setInterval` at 30000ms matches
  client-side pong expectations. Changing the interval without
  updating the client causes spurious terminations.
- **Rate-limit + size-limit before dispatch.** In `events.ts`.
  Messages that fail these guards must never reach handlers.
- **Activity touch before handler dispatch for user-intent messages.**
  User-intent messages touch `registry.touchUserActivity()` and
  `registry.touchUserWebActivity()` before calling the handler.
  Heartbeat/visibility/low-signal messages intentionally do not touch.
  Presence reporting depends on this partitioning.
- **Voice audio buffer ordering.** `handleVoiceStart` clears the
  buffer before marking recording. `handleVoiceStop` concatenates
  and then immediately clears the live buffer so the next recording
  can start collecting while transcription runs. Prosody abort
  happens before a new controller is installed. See `handlers/voice.ts`.

### Frontend composition

All in `packages/frontend/src/`. Duplicates of the Load-bearing seams
subsection in Section 4 for canonical-list purposes.

- **Chat page as composition shell.** `routes/chat/+page.svelte`
  stays composition-only. Inline business logic re-creates the
  pre-Batch-5 monolith.
- **`MessageList` ref handoff via `onregisterrefs`.** Message
  container and sentinel refs live inside `MessageList`; the page
  receives them via callback. Getter-as-state pattern lets composables
  target real DOM without the page owning `bind:this`.
- **Send button inline in `MessageInput` parent.** NOT extracted into
  `ComposerPickers`. Renders on the right side of the textarea in the
  existing layout. Batch 6.3 hotfix established this after a
  regression.
- **Code-copy registration in `MessageBubble` parent.** The markdown
  code-copy effect depends on post-render markdown DOM; moving it
  into a display-only child broke it once already.
- **`CommandPalette` parent-mounted in `MessageInput`.** Not inside
  `ComposerTextarea`. Parent delegates keyboard events via
  `handleKey(event)`. Moving the palette into the textarea shell
  would require tunneling a component ref through a shell seam.
- **Auto-scroll after message/stream updates.** The auto-scroll
  effect in `routes/chat/+page.svelte` uses a setTimeout deferral so
  the controller measures post-paint layout, not pre-paint.
- **Read observer setup after sentinel exists.** The effect in
  `routes/chat/+page.svelte` is keyed to `messagesEndEl`; setup runs
  after the sentinel's `bind:this` has populated.
- **Slash-command and sticker-autocomplete handle keys before
  Enter-send.** In `MessageInput.handleKeydown`, the palette and
  autocomplete API calls precede the normal Enter path. Reversing
  this causes premature sends.
- **Composer reset only after successful send.** In
  `MessageInput.handleSend`. Reset must not run until the send path
  has completed successfully; otherwise a transient send failure
  wipes in-flight state.
- **`:global()` CSS on shared form selectors.** In
  `PreferencesPanel.svelte`. Svelte scopes styles per-component;
  child components using the same class names need `:global()`
  wrapping to inherit styling without duplicating it. (A Svelte
  styling gotcha, but it already caused real regressions — worth
  listing.)
- **Streaming state is thread-scoped, agent-busy state is global.**
  `isStreaming()` in the WebSocket store returns true only when the
  current stream's `streamingThreadId` matches `activeThreadId` — the
  stop-generation button and Escape-stop-stream shortcut both gate on
  it, and a stop affordance with no visible target is more confusing
  than useful. Cross-thread streams reveal themselves via the sidebar
  unread badge instead. `isAgentBusy()` is the parallel agnostic
  check used to drive the three-stage thinking indicator: `Waiting...`
  (queued behind another thread's stream — `isAgentBusy() && !isStreaming()`),
  `<companion> is thinking...` (this thread's stream started, no
  tokens yet), full message bubble (tokens flowing). Don't merge
  these two getters; their split is the load-bearing distinction.
- **Per-thread Files drawer is read-only; Library owns delete authority.**
  `FilePanel.svelte` (paperclip icon in chat header) lists this
  thread's attachments via the existing `messages` store with no
  delete affordance. The Library page (`/files`, title "Library")
  is the cross-thread store and the ONLY surface that issues a
  `DELETE /api/files/:id`. If a delete affordance is ever added to
  the per-thread drawer, route it through the Library's authority,
  not direct to the API.

### State ownership boundaries

- **Only `services/db/*` writes to SQLite.** Callers pass plain data;
  the module handles SQL. Writing SQL elsewhere is the pattern that
  leads to schema drift and untracked queries.

  > **⚠️ Under review — invariant aspirational, not enforced.** Several
  > services and routes currently issue direct SQL writes outside
  > `services/db/*`. Known sites at the time of writing — **not an
  > exhaustive list** — include `services/cc.ts`,
  > `services/audit.ts`, `services/discord/pairing.ts`,
  > `services/commands.ts` (the `/rename` slash command updates
  > `threads` directly), `services/ws/handlers/messages.ts` (marks
  > newly created user messages `delivered_at` / `read_at` directly),
  > and `routes/threads.ts`. The boundary will resolve in a future
  > pass via either (a) updating this section to describe the real
  > partial boundary, or (b) moving the offending writes behind
  > `services/db/` modules. Until then, do not rely on this invariant
  > when writing new code, and treat any new out-of-`services/db/`
  > write as a deliberate exception that needs justification — not a
  > free pass because "others do it."
- **Only `Orchestrator` owns application/background scheduling
  timers.** Services that need scheduling register with the
  orchestrator. The WebSocket heartbeat in `services/ws/socket.ts`
  is a separate protocol-layer concern and is not "application
  scheduling" in this sense. Ad-hoc `setInterval` in other modules
  escapes graceful shutdown and causes test flakiness.
- **`registry.broadcast*()` for multi-socket state updates.** Direct
  `ws.send(...)` is only for sender-only echoes (`sync_response`,
  `canvas_list`, errors).
- **Frontend never mutates persisted state directly.** All changes
  flow through WebSocket messages to the backend or HTTP calls
  through `lib/utils/api.ts`.

### Security boundaries

- **Public routes mounted before `authMiddleware`.** In `routes/api.ts`.
  `/health`, `/auth/*`, `/identity`, `/setup/*`, `/internal/*` precede
  the auth gate. New public routes must also mount before it, or
  they'll be 401'd.
- **`requireLocalhost` for internal routes only.** In
  `routes/internal.ts`. Not part of the global middleware stack.
- **Rate limiter scoped to `/api` and `/mcp` only.** Not applied to
  static asset serving. Changing this impacts chat responsiveness.

### Testing guardrails

Not architectural invariants per se, but guardrails that catch
architectural violations early.

- **Manual smoke checklist for UI changes.** `docs/MANUAL-TESTS.md`
  holds the list of behaviors automated tests can't cover
  (auto-scroll feel, streaming rendering, voice mode UI, etc.).
  Run the relevant chat/settings section after any frontend refactor.
- **Backend test suite must stay green.** The suite currently
  includes migration/bootstrap defenses, predicate assertions, and
  an anti-drift integration test. Keep it green; be suspicious of
  unexplained test-count drops. Landing code that reduces the suite
  count is almost always wrong.

---

## Where to add new features

A decision guide. Earlier sections explain the map; this one is about
moving through it without getting lost. Each entry is a question a
contributor actually asks before writing code.

### New persisted field or table

Start in the migrations directory. Never in `init.ts`.

- Create the next-numbered `.sql` file under
  `packages/backend/migrations/`.
- Register its predicate in `migration-predicates.ts`.
- Add a predicate test in `migrate.test.ts`.
- Add the query accessor to the appropriate module under
  `services/db/`. If it's a new domain, create a new module.
- If the shape crosses the frontend/backend boundary, update
  `@resonant/shared` too (see Shared contracts).
- Anti-pattern: putting `ALTER TABLE` or
  `CREATE TABLE IF NOT EXISTS` back into `init.ts`. That reintroduces
  exactly the drift Batch 7 eliminated. See Database & migrations.

### New behavior the user triggers — HTTP or WebSocket?

- If it's **request-response** and not latency-sensitive (admin,
  config, file management, search queries that return a result set
  once): HTTP. Add a route under `routes/` and mount it from
  `api.ts`.
- If it's **live, streaming, or multi-socket** (chat messages,
  presence updates, canvas co-editing, voice streaming, tool
  activity): WebSocket. Add a handler under `services/ws/handlers/`
  and a case in `services/ws/events.ts`. Add the message shapes to
  `packages/shared/src/protocol.ts`.
- If you can't tell, start with HTTP unless the feature is clearly
  live/streaming/multi-socket. Moving to WebSocket later is a
  smaller change than moving away from it.

### New frontend behavior — route, store, composable, or leaf component?

- **Route** — only if it needs its own URL. Routes are shells;
  business logic doesn't live inline.
- **Store** (`lib/stores/*.svelte.ts`) — only if it's cross-route
  reactive state that multiple components read. If it's local to one
  component or one route, `$state` inside that component is enough.
- **Composable** (`lib/chat/*.svelte.ts` or equivalent) — only if
  it's non-visual logic used across components that needs rune state
  or `$effect` wiring. Composables are factories; the calling
  component owns `$effect` and `bind:this` refs.
- **Leaf component** (`lib/components/*.svelte`) — the default.
  Most UI changes are leaves. If a leaf starts feeling structurally
  mixed (visual shell plus multiple distinct subregions or
  behaviors), look at the Batch 6 split patterns.
- Anti-pattern: reaching into the backend with `fetch` directly from
  a leaf component. HTTP calls go through `lib/utils/api.ts`.

### New shape — does it belong in `@resonant/shared`?

- If **both frontend and backend** need to know it: yes. Pick
  `types.ts` for domain/data models, `protocol.ts` for WebSocket
  envelopes.
- If only one package uses it: no. Keep it package-local.
- If you're tempted to move a type to shared because it's imported
  twice in the backend: no. That's not the criterion.
- See Shared contracts for the full rules.

### New background behavior — orchestrator or not?

- If it's a **scheduled or trigger-driven task** (wake prompts,
  cooldown-gated reminders, periodic health checks): register it
  with the `Orchestrator`. Don't spawn `setInterval` in a new
  top-level module.
- If it's an **event-driven reaction** to a user action that happens
  right after the action: do it inline in the WebSocket handler or
  service that fired the event.
- If it's a **long-running computation that shouldn't block the
  response** (embeddings, digest generation): use the existing
  async patterns (see `services/db/messages.ts` embedding enqueue,
  `services/digest.ts`).
- Anti-pattern: hiding long-running work in a route handler. Route
  handlers should return quickly; anything that can't should be
  enqueued, delegated to the orchestrator, or run as a fire-and-forget
  follow-up.

### New integration with an external service

- Follow the gateway pattern used by `services/discord/` and
  `services/telegram/`:
  - Construct conditionally on config flag + env credential.
  - Own graceful start/stop that participates in server shutdown.
  - Expose a narrow surface to the rest of the app (one service
    class, clear public methods).
- If the integration is **always-on and credential-optional** (like
  voice and push): construct unconditionally but no-op when
  credentials are missing.
- Anti-pattern: writing external network calls directly from a route
  handler or a leaf component. Wrap them in a service.

### New WebSocket message type

Short version: add the shape to `protocol.ts`, add the handler,
wire the dispatcher case. Full version in the "Adding a new message
type" subsection of the WebSocket protocol section.

### When in doubt

- **Preservation-first.** If you're reorganizing code that works,
  don't change semantics in the same commit. The batch refactor
  history is the template.
- **Respect `// ORDER:` comments.** If a sequence looks arbitrary,
  it probably earned that ordering through a regression. Read the
  comment before rearranging.
- **Prefer explicit over clever.** Getter-based ref passing, typed
  prop contracts, single-transaction ledger inserts — the boring
  pattern is usually the right one here.
- **If a change would break a load-bearing invariant, stop and think
  first.** The Load-bearing invariants section is the canonical list
  of "don't silently break these."

### Still unsure?

Open the relevant section of this doc and follow the cross-reference
chain. The goal is that any contributor can get from "I want to add X"
to "I touch files A, B, C in that order" without spelunking the whole
repo.
