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

## How to use this file

1. Run the relevant section after a batch merges
2. If something breaks, **don't ship it** — revert the batch branch, fix, retry
3. When a new UI behavior is added, add a check here in the same PR
4. Keep each item specific and observable — "it feels right" is not a test
