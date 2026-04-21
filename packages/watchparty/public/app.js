// watchparty client — vanilla JS, no build step.
// Talks to the server over /ws. Host drives playback; clients reconcile.

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  me: null,
  hostId: null,
  room: null,
  player: null,
  playerReady: false,
  applyingRemote: false,
  lastSent: 0,
  name: localStorage.getItem('wp.name') ?? '',
  pendingLoad: null,
};

$('inName').value = state.name;
$('inRoom').value = location.hash.replace(/^#/, '') || '';

$('btnJoin').addEventListener('click', joinFromForm);
$('btnLeave').addEventListener('click', () => location.reload());
$('btnLoad').addEventListener('click', loadVideoFromInput);
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('inChat').value.trim();
  if (!text || !state.ws) return;
  state.ws.send(JSON.stringify({ type: 'chat', text }));
  $('inChat').value = '';
});

function joinFromForm() {
  const name = $('inName').value.trim() || 'anon';
  const room = $('inRoom').value.trim() || 'lobby';
  localStorage.setItem('wp.name', name);
  location.hash = room;
  connect(room, name);
}

function connect(room, name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  state.room = room;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room, name }));
  });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });
  ws.addEventListener('close', () => {
    sys('disconnected. reload to rejoin.');
    $('roomLabel').textContent = 'disconnected';
  });

  // heartbeat
  setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
}

function handle(msg) {
  switch (msg.type) {
    case 'joined':
      state.me = msg.youAre;
      state.hostId = msg.host;
      $('gate').hidden = true;
      $('stage').hidden = false;
      $('btnLeave').hidden = false;
      $('roomLabel').textContent = `room: ${msg.room}`;
      renderPeers(msg.peers);
      if (msg.video?.id) loadVideo(msg.video.id, msg.state);
      break;
    case 'peers':
      renderPeers(msg.peers);
      break;
    case 'load':
      loadVideo(msg.video.id, msg.state);
      break;
    case 'state':
      applyState(msg.state);
      break;
    case 'chat':
      chatLine(msg.from, msg.text);
      break;
  }
}

function renderPeers(peers) {
  const hostPeer = peers.find(p => p.host);
  state.hostId = hostPeer?.id ?? state.hostId;
  const el = $('peers');
  el.innerHTML = '';
  for (const p of peers) {
    const s = document.createElement('span');
    s.className = 'peer' + (p.host ? ' host' : '');
    s.textContent = p.host ? `${p.name} (host)` : p.name;
    el.appendChild(s);
  }
  $('hostLabel').textContent = isHost() ? 'you are host' : `host: ${hostPeer?.name ?? '?'}`;
  $('loadBar').style.display = isHost() ? '' : 'none';
}

function isHost() { return state.me && state.me === state.hostId; }

function chatLine(who, text) {
  const el = document.createElement('div');
  el.className = 'm';
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  el.appendChild(w);
  el.append(document.createTextNode(text));
  const c = $('chat'); c.appendChild(el); c.scrollTop = c.scrollHeight;
}
function sys(text) {
  const el = document.createElement('div');
  el.className = 'm sys'; el.textContent = text;
  const c = $('chat'); c.appendChild(el); c.scrollTop = c.scrollHeight;
}

// --- YouTube player --------------------------------------------------------

window.onYouTubeIframeAPIReady = () => {
  state.player = new YT.Player('player', {
    width: '100%', height: '100%',
    playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
    events: {
      onReady: () => {
        state.playerReady = true;
        if (state.pendingLoad) {
          const { id, s } = state.pendingLoad;
          state.pendingLoad = null;
          loadVideo(id, s);
        }
      },
      onStateChange: onPlayerStateChange,
    },
  });
};

function extractVideoId(input) {
  const s = input.trim();
  if (!s) return '';
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const parts = u.pathname.split('/');
    const i = parts.indexOf('embed');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
  } catch {}
  return '';
}

function loadVideoFromInput() {
  if (!isHost() || !state.ws) return;
  const id = extractVideoId($('inVideo').value);
  if (!id) { sys('could not parse video id'); return; }
  state.ws.send(JSON.stringify({ type: 'load', videoId: id }));
  // local load happens via echoed 'load' broadcast from server to other peers;
  // but server doesn't echo to sender, so load locally too:
  loadVideo(id, { playing: false, time: 0, rate: 1, at: Date.now() });
}

function loadVideo(id, s) {
  if (!state.playerReady) { state.pendingLoad = { id, s }; return; }
  state.applyingRemote = true;
  state.player.loadVideoById({ videoId: id, startSeconds: s?.time ?? 0 });
  if (!s?.playing) state.player.pauseVideo();
  setTimeout(() => { state.applyingRemote = false; }, 600);
}

function applyState(s) {
  if (!state.playerReady || isHost()) return;
  state.applyingRemote = true;
  const expected = s.time + (s.playing ? (Date.now() - s.at) / 1000 : 0);
  const actual = state.player.getCurrentTime();
  if (Math.abs(actual - expected) > 1.2) state.player.seekTo(expected, true);
  if (s.playing && state.player.getPlayerState() !== YT.PlayerState.PLAYING) state.player.playVideo();
  if (!s.playing && state.player.getPlayerState() === YT.PlayerState.PLAYING) state.player.pauseVideo();
  try { state.player.setPlaybackRate(s.rate); } catch {}
  setTimeout(() => { state.applyingRemote = false; }, 400);
}

function onPlayerStateChange(e) {
  if (!isHost() || state.applyingRemote || !state.ws) return;
  // debounce — don't spam server during buffering flips
  const now = Date.now();
  if (now - state.lastSent < 150) return;
  state.lastSent = now;
  const playing = e.data === YT.PlayerState.PLAYING;
  const time = state.player.getCurrentTime();
  let rate = 1;
  try { rate = state.player.getPlaybackRate(); } catch {}
  state.ws.send(JSON.stringify({ type: 'state', playing, time, rate }));
}

// periodic host heartbeat so late joiners / drift get corrected
setInterval(() => {
  if (!isHost() || !state.playerReady || !state.ws || state.ws.readyState !== 1) return;
  const playing = state.player.getPlayerState() === YT.PlayerState.PLAYING;
  const time = state.player.getCurrentTime();
  state.ws.send(JSON.stringify({ type: 'state', playing, time, rate: 1 }));
}, 5000);

// Minimal service worker registration (optional, ignored if unsupported)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
