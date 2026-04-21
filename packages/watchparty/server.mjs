import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.WATCHPARTY_PORT ?? 5179);
const HOST = process.env.WATCHPARTY_HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function safeResolve(reqPath) {
  const clean = decodeURIComponent(reqPath.split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  const full = safeResolve(req.url ?? '/');
  if (!full) { res.writeHead(400); res.end('bad request'); return; }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
});

// --- Realtime sync ---------------------------------------------------------
// Rooms live in memory. First peer to join becomes host; host reassigns on exit.

const rooms = new Map(); // roomId -> { peers: Set<ws>, hostId, video: {id,title}|null, state: {...} }

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { peers: new Set(), hostId: null, video: null, state: { playing: false, time: 0, rate: 1, at: Date.now() } };
    rooms.set(id, r);
  }
  return r;
}

function broadcast(room, msg, exceptWs) {
  const payload = JSON.stringify(msg);
  for (const p of room.peers) {
    if (p === exceptWs) continue;
    if (p.readyState === 1) p.send(payload);
  }
}

function peerList(room) {
  return [...room.peers].map(p => ({ id: p._id, name: p._name, host: p._id === room.hostId }));
}

const wss = new WebSocketServer({ server, path: '/ws' });
let nextPeerId = 1;

wss.on('connection', (ws) => {
  ws._id = `p${nextPeerId++}`;
  ws._name = 'anon';
  ws._room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg?.type;

    if (t === 'join') {
      const roomId = String(msg.room ?? 'lobby').slice(0, 64);
      ws._name = String(msg.name ?? 'anon').slice(0, 32);
      const room = getRoom(roomId);
      ws._room = roomId;
      room.peers.add(ws);
      if (!room.hostId) room.hostId = ws._id;
      ws.send(JSON.stringify({
        type: 'joined',
        room: roomId,
        youAre: ws._id,
        host: room.hostId,
        peers: peerList(room),
        video: room.video,
        state: room.state,
      }));
      broadcast(room, { type: 'peers', peers: peerList(room) }, ws);
      return;
    }

    const room = ws._room ? rooms.get(ws._room) : null;
    if (!room) return;
    const isHost = ws._id === room.hostId;

    if (t === 'load' && isHost) {
      room.video = { id: String(msg.videoId ?? '').slice(0, 32), title: String(msg.title ?? '').slice(0, 200) };
      room.state = { playing: false, time: 0, rate: 1, at: Date.now() };
      broadcast(room, { type: 'load', video: room.video, state: room.state });
    } else if (t === 'state' && isHost) {
      room.state = {
        playing: !!msg.playing,
        time: Number(msg.time) || 0,
        rate: Number(msg.rate) || 1,
        at: Date.now(),
      };
      broadcast(room, { type: 'state', state: room.state }, ws);
    } else if (t === 'chat') {
      const text = String(msg.text ?? '').slice(0, 500);
      if (!text) return;
      broadcast(room, { type: 'chat', from: ws._name, id: ws._id, text, at: Date.now() });
    } else if (t === 'claim-host') {
      // allow any peer to grab host if current host is gone (defensive)
      if (![...room.peers].some(p => p._id === room.hostId)) {
        room.hostId = ws._id;
        broadcast(room, { type: 'peers', peers: peerList(room) });
      }
    } else if (t === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    }
  });

  ws.on('close', () => {
    const room = ws._room ? rooms.get(ws._room) : null;
    if (!room) return;
    room.peers.delete(ws);
    if (room.peers.size === 0) {
      rooms.delete(ws._room);
      return;
    }
    if (room.hostId === ws._id) {
      room.hostId = [...room.peers][0]._id;
    }
    broadcast(room, { type: 'peers', peers: peerList(room) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[watchparty] http://${HOST}:${PORT}  (ws path: /ws)`);
});
