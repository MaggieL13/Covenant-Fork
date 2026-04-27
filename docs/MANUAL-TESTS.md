# Manual Test Checklist

Run this after any batch that touches **chat UI, stickers, WebSocket, or frontend composition**. The automated Vitest suite covers the backend data layer — these are the things we can only verify by actually using the app.

Keep this list short and specific. If a batch adds a new load-bearing UI behavior, add a test here in the same PR.

---

## 🌿 Quick Smoke (≤ 2 minutes)

Do these after every UI-touching batch.

### 1. Sticker inline rendering
- [ ] Type `:zephyr_pout:` in the composer and send
- [ ] Message renders with the sticker image inline, not the raw `:name:` text
- [ ] Hover shows sticker name tooltip

### 2. WebSocket reconnect
- [ ] With chat open, stop the backend (`Ctrl+C` in terminal)
- [ ] Frontend shows some "disconnected" indication within a few seconds
- [ ] Restart backend (`npm start`)
- [ ] Frontend reconnects automatically, thread list reappears, no refresh needed

### 3. Message delivery
- [ ] Open a thread
- [ ] Send a message
- [ ] Message appears in the correct thread (not a different one)
- [ ] Message persists after refresh

### 4. New thread modal
- [ ] Open the new-thread modal from the chat UI
- [ ] Close it without creating anything
- [ ] Re-open it, create a named thread, and confirm the new thread opens selected

### 5. Search overlay
- [ ] Open search from the chat button and close it again
- [ ] Open search with `Ctrl+K` or `Cmd+K`
- [ ] Search for a known message, select a result, and confirm chat jumps to the right thread/message

### 6. Canvas drawer
- [ ] Open the canvas drawer from the chat header button and close it with the overlay
- [ ] Open an active canvas and confirm the drawer shows the canvas view, not the canvas list
- [ ] Use the canvas reference action and confirm the canvas is attached into the composer

### 7. Header and sidebar chrome
- [ ] Open the mobile sidebar from the menu button and close it with the overlay
- [ ] Toggle the desktop sidebar collapse button and confirm the thread list hides/shows cleanly
- [ ] Confirm header buttons still open search, canvas, files, settings, and theme toggle correctly

### 8. Chat interaction behavior
- [ ] Scroll up in an active thread until the jump-to-bottom button appears, then click it and confirm chat snaps back to the latest messages
- [ ] In a long thread, scroll near the top and confirm older messages load without the viewport jumping to a different spot
- [ ] Open search with `Ctrl+K` or `Cmd+K`, then confirm `Escape` still closes the canvas drawer, mobile sidebar, and new-thread modal in the same order they used to
- [ ] Open a thread with unread companion messages, scroll to the bottom, and confirm the unread badge clears
- [ ] Use message context menu or keyboard activation on a message and confirm reply-to appears correctly in the composer
- [ ] In the empty state, click a suggested prompt and confirm the expected prompt text sends

---

## 🔍 Deeper Checks (≤ 5 minutes)

Do these after Batches 4 (WS untangle), 5 (Chat split), or 6 (Component split).

### 9. Thread list behavior
- [ ] Pin a thread → moves to top of list, stays after refresh
- [ ] Unpin → drops back into chronological position
- [ ] Archive a thread → disappears from main list
- [ ] Toggle "show archived" → archived thread reappears
- [ ] Unarchive → thread returns to main list

### 10. Canvas
- [ ] Create a canvas inside a thread
- [ ] Canvas appears in canvas list
- [ ] Delete the thread that owns the canvas
- [ ] **Canvas still exists** in the canvas list (detached, not deleted)
- [ ] Open the detached canvas — still readable

### 11. Reactions
- [ ] React to a message with an emoji
- [ ] Reaction appears on the message, persists after refresh
- [ ] Add a second different emoji → both show
- [ ] Remove a reaction → only the remaining one shows
- [ ] Companion reacting shows distinct attribution (not user)

### 12. Streaming feel
- [ ] Send a message that triggers a companion response
- [ ] Response streams in character-by-character (not all at once at the end)
- [ ] Tool use shows an indicator (thinking, searching, etc.)
- [ ] After response finishes, thread list updates (last message preview, timestamp)

### 13. Settings basics
- [ ] Open Settings and confirm current companion name, user name, and timezone render correctly
- [ ] Change companion name, user name, and timezone; save; refresh; confirm the values persist
- [ ] Change chat model, autonomous model, and thinking effort; save; refresh; confirm the values persist
- [ ] Confirm a saved chat model change is reflected in the chat header model indicator
- [ ] Toggle orchestrator, voice, Discord, and Telegram; save; refresh; confirm each toggle persists
- [ ] Verify the Voice, Discord, and Telegram setup guides only appear when their related toggles are enabled
- [ ] Set or change the password; save; confirm the success behavior is unchanged and the explanatory text still matches whether a password exists
- [ ] Confirm shared save success and error messages still render in the same place at the bottom of the panel
- [ ] Personality round-trip: edit guided fields, save, switch to raw, save unchanged, switch back to guided, and confirm no content drift
- [ ] Personality round-trip: edit raw markdown, save, switch to guided, save unchanged, switch back to raw, and confirm the bytes are still identical
- [ ] Use Reset to Default in Personality and confirm the editor updates before save
- [ ] Add an MCP URL/SSE server and a stdio server, refresh, and confirm card rendering still matches the persisted config
- [ ] Remove an MCP server, refresh, and confirm the removal persists without other MCP entries drifting
- [ ] In Discord settings, verify the gateway setup guide still appears when the bot token is missing
- [ ] With Discord enabled, verify the status card still shows bot identity, guild count, ping button, stats, and deferred notice
- [ ] Approve a pending pairing request and confirm the user moves into Approved Users without other pairing rows drifting
- [ ] Revoke an approved user and confirm they disappear from Approved Users after refresh
- [ ] Expand Gateway Settings and confirm lazy-loading still shows the loading state before the form appears on first open
- [ ] Use Auto-detect Owner and confirm the field fills without moving the save/status area
- [ ] Change debounce, mention, expiry, owner-active-threshold, defer, and allowed-users settings; save; refresh; confirm each persists
- [ ] Verify the guild/channel selector still appears inside Gateway Settings in the same place and all toggles behave unchanged
- [ ] Expand Recent Activity and confirm loading, empty, and populated log states still render correctly
- [ ] Verify Recent Activity date separators and log row formatting still match the previous UI
- [ ] Close and reopen Recent Activity and confirm the log view re-renders cleanly without stale rows
- [ ] Toggle a guild on or off, save, refresh, and confirm the selection persists
- [ ] Expand a guild's channels, toggle a channel on or off, save, refresh, and confirm the selection persists
- [ ] Toggle `Anyone can talk` and `Silence bot`, save, refresh, and confirm both guild options persist
- [ ] Trigger a Discord action that shows status or error feedback and confirm the footer message still appears in the same place
- [ ] Expand Rules and confirm first-open lazy loading still works
- [ ] Switch between Servers / Channels / Users tabs and confirm counts and active tab state stay correct
- [ ] Begin adding a rule, switch tabs, switch back, and confirm the partially filled form is still present on the original tab
- [ ] Edit and save an existing server rule, refresh, and confirm persistence
- [ ] Edit and save an existing channel rule including toggle fields, refresh, and confirm persistence
- [ ] Edit and save an existing user rule, refresh, and confirm persistence
- [ ] Add a server/channel/user rule and confirm the new rule appears and stays expanded after save
- [ ] Delete a server/channel/user rule and confirm it disappears without stale expanded state

---

## 🚨 After Batch 7 (migrations)

Extra paranoid — this touches the database directly.

- [ ] Before migrating: copy `data/resonant.db` to `data/resonant.db.pre-migration.bak`
- [ ] Open chat → all threads present, message history intact
- [ ] Open a canvas → content intact
- [ ] Stickers still render → sticker table intact
- [ ] Scribe digests still readable → digest table intact
- [ ] Config settings intact (theme, voice, discord settings)
- [ ] Restart server → migrations don't re-run on boot

If anything feels off: stop, restore from `.pre-migration.bak`, diagnose.

---

## 🕒 After the timezone-sovereignty pass

For installs in zones whose tzdata Node may be late to update (Paraguay's 2024 DST abolition, late-arriving IANA changes for Greenland, anywhere else recently rule-shifted). These confirm scheduling lands on the correct local wall-clock moment regardless of Node ICU freshness.

### 14. Per-thread Files drawer
- [ ] Click the paperclip icon in the chat header → slide-out panel opens from the right
- [ ] Panel lists every file in the active thread, newest first
- [ ] Image attachments render as inline thumbnails; text files (≤50 KB) show a snippet preview; audio and other binaries show a glyph + extension badge
- [ ] Click any tile → file opens in a new browser tab via `/api/files/<id>`
- [ ] On mobile (≤768 px viewport), drawer goes full-screen
- [ ] Empty thread shows "No files yet. Attach something in chat to get started."

### 15. Library page (renamed from "Files")
- [ ] Open the library icon in the chat header → page title reads **Library** (not "Files")
- [ ] Files render as a thumbnail grid, not a vertical text list
- [ ] Filter tabs (all / image / audio / file / orphan) still work
- [ ] Delete-with-confirm flow: click Delete → Confirm/Cancel pair appears → Confirm removes the file and updates total size + count + orphan count without a page reload
- [ ] Switch to the "orphan" filter — any file on disk whose UUID isn't referenced by message metadata appears here. To synthesize one for testing without going through the share path (which would create a referencing message): copy an existing file like `data/files/<some-uuid>.txt` to `data/files/<freshly-generated-uuid>.txt`. The new file has no corresponding message row, so Library flags it orphan.

### 16. Long-paste auto-converts to file attachment
- [ ] In the composer, paste a block of text ≥1000 chars (a markdown doc, JSON, or just a long paragraph)
- [ ] Composer textarea stays empty; a file card appears in the attachment tray named `pasted-text-YYYYMMDD-HHMMSS.{ext}`
- [ ] Sniffed extension matches the content shape: `.md` for markdown, `.json` for valid JSON, `.txt` otherwise
- [ ] Paste a short block (<1000 chars) → text drops inline as before, no file card
- [ ] Paste an image (clipboard screenshot) → file card uploads as image regardless of any text alongside (image takes priority)

### 17. Voice fallback when synthesis unavailable
- [ ] With `ELEVENLABS_API_KEY` unset, ask the companion to send a voice message
- [ ] Companion responds with a normal chat reply (NOT a canvas, file, or any persistence-based workaround)
- [ ] Confirm the same fallback behavior on a network error if the env is set but ElevenLabs is unreachable

### 18. Timer wall-clock parsing

> **Precondition for the equivalence checks below:** `identity.timezone` set to a UTC−3 zone (e.g. `America/Asuncion` while DST is abolished there). The three example shapes only resolve to the same UTC instant under that offset; in any other zone the wall-clock and ISO-with-offset forms will diverge — adjust accordingly. Replace `<future-date>` with a YYYY-MM-DD a few minutes in the future so you can actually wait for the fire window.

- [ ] Create a timer using identity-zone wall-clock: `sc timer create "test" "ctx" "<future-date> 09:00"`
- [ ] Response includes both canonical UTC `fire_at` AND `fire_at_local` (a human-readable string in identity timezone)
- [ ] `sc timer list` shows the same two fields per row
- [ ] Wait for the fire window — the timer fires within ~60 seconds of 09:00 LOCAL, not 09:00 UTC, regardless of host process timezone
- [ ] Repeat with explicit ISO offset (`<future-date>T09:00:00-03:00`) — under a UTC−3 identity timezone this fires at the same instant as the wall-clock form above
- [ ] Repeat with `Z` (`<future-date>T12:00:00Z`) — same instant under UTC−3, intentionally NOT under any other zone

### 19. Cron startup hardening
- [ ] In the DB config table, set `cron.morning.schedule` to an obviously malformed value (e.g. `0 0 8 * * *` — six fields) or `not-a-cron`
- [ ] Restart the backend
- [ ] Server starts cleanly (no crash) and logs a warning naming the rejected value and the default fallback it used
- [ ] Reset to `0 8 * * *` and confirm normal behavior resumes after restart

### 20. Orchestrator recency awareness
- [ ] Have a real conversation with the companion (a few exchanges)
- [ ] Within 5 minutes, manually trigger a scheduled wake (or wait for one)
- [ ] Wake response acknowledges the recent activity — does NOT perform a fresh "good morning" / full-orientation entrance
- [ ] Brand-new thread + manual wake trigger → wake DOES do full intro behavior (no recency context to dampen it)

---

## How to use this file

1. Run the relevant section after a batch merges
2. If something breaks, **don't ship it** — revert the batch branch, fix, retry
3. When a new UI behavior is added, add a check here in the same PR
4. Keep each item specific and observable — "it feels right" is not a test
