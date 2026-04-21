# @resonant/watchparty

Optional **DLC-style addon**: sync YouTube watch parties with live chat. Works on PC, mobile, and Android TV browsers.

> **This package is fully self-contained.** It does not import from, depend on, or modify any other workspace package. Delete the folder and remove the one line from the root `package.json` `workspaces` array to remove it completely.

## Run

```bash
npm install                    # from repo root, once
npm run dev:watchparty         # starts server on http://localhost:5179
```

Then open `http://<your-lan-ip>:5179/` on any device. Pick a room code, share it with your friends, and whoever joins first becomes host.

## Environment

- `WATCHPARTY_PORT` — default `5179`
- `WATCHPARTY_HOST` — default `0.0.0.0` (bind all interfaces for LAN access)

## How it works

- Static PWA frontend (vanilla JS, no build step) uses the YouTube iframe API.
- Node HTTP server serves `public/` and a WebSocket endpoint at `/ws`.
- In-memory rooms: first peer to join is host, host drives play/pause/seek, clients reconcile on drift > 1.2s.
- Chat is broadcast to all peers in the room. Nothing is persisted.

## Platform notes

- **Android TV**: works in the built-in browser. YouTube autoplay may require a remote click on "play" the first time.
- **Mobile Safari**: videos require a user gesture to start — tap the player once.
- **HTTPS**: if served over HTTPS, the client auto-uses `wss://`. For LAN testing HTTP is fine.

## Scope / non-goals

- No accounts, no persistence, no moderation tools — rooms are ephemeral.
- YouTube-only for now. An anime/direct-video mode (shared `<video>` + HLS) can be added later without breaking the protocol.
