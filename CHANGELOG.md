# Changelog

All notable changes to Resonant will be documented in this file.

## [1.5.0] - 2026-03-30

### Added

- **Command Center** — Built-in life management system with 9 pages and 12 MCP tools
  - **Dashboard** (`/cc`) — Aggregate view of tasks, events, care, pets, countdowns, and daily wins
  - **Planner** (`/cc/planner`) — Task management with projects, priorities, drag-and-drop reordering, and 3-day carry-forward
  - **Care Tracker** (`/cc/care`) — Config-driven wellness tracking with toggles (meals, meds, movement), ratings (sleep, energy, mood), and counters (water)
  - **Calendar** (`/cc/calendar`) — Event management with recurrence (weekly, monthly, yearly)
  - **Cycle Tracker** (`/cc/cycle`) — Period tracking with phase predictions, daily logging, and history
  - **Pet Care** (`/cc/pets`) — Pet profiles, medications with auto-advancing schedules, vet events
  - **Lists** (`/cc/lists`) — Shopping and general lists with checkable items
  - **Finances** (`/cc/finances`) — Expense tracking with category breakdown and configurable currency
  - **Stats** (`/cc/stats`) — Trends dashboard for tasks, care, cycle, and expenses
  - **12 MCP tools** (`cc_status`, `cc_task`, `cc_project`, `cc_care`, `cc_event`, `cc_cycle`, `cc_pet`, `cc_list`, `cc_expense`, `cc_countdown`, `cc_daily_win`, `cc_presence`) accessible via `/mcp/cc`
  - Fully configurable via `resonant.yaml` — `command_center.enabled`, `default_person`, `currency_symbol`, `care_categories`
  - Hooks integration: companion context automatically includes CC status and mood history when enabled

- **Slash Commands** — `/command` system with CommandPalette UI
  - Type `/` in chat to browse available commands
  - Auto-discovers installed skills
  - UI commands (client-side) vs SDK passthrough (agent-side)

- **TTS Read Aloud** — Play button on companion messages
  - Appears on hover for text messages from the companion
  - Generates speech via ElevenLabs (requires `voice.elevenlabs_voice_id` config)
  - Caches audio per message, handles mobile audio unlock

- **New Thread Modal** — Replaced browser `prompt()` with proper modal dialog
  - Backdrop click and Escape to close
  - Loading state during creation

- **Command Center Navigation** — Home icon in chat header links to `/cc`

### Changed

- **Companion Name** — UI now uses configured `companion_name` everywhere instead of hardcoded "Companion" (thanks @irorierorie — [#9](https://github.com/codependentai/resonant/pull/9))
- **Orchestrator** — Migrated from `node-cron` to `croner` for reliable timezone-aware scheduling (fixes DST edge cases)
- **Escape Key** — Now closes sidebar, search panel, and thread modal in addition to stopping generation
- **CSS Design Tokens** — Added spacing scale, typography scale, elevation shadows, semantic colors, and card radius variables

### Fixed

- Timezone-related scheduling bugs caused by `node-cron` v4.x DST handling

## [1.4.1] - 2026-03-28

- Autonomous alignment: routines, pulse, failsafe tools
- Session tracking, vector cache, and search filters

## [1.4.0] - 2026-03-27

- Initial public release
