import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HTTPServer } from 'http';
import type { Socket } from 'net';
import { parse as parseCookie } from 'cookie';
import type { ServerMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../registry.js';
import { getWebSession } from '../db.js';
import { AgentService } from '../agent.js';
import { Orchestrator } from '../orchestrator.js';
import { getResonantConfig } from '../../config.js';

const COOKIE_NAME = 'resonant_session';

function getAllowedOrigins(): string[] {
  const config = getResonantConfig();
  const port = config.server.port;
  const origins = new Set<string>([
    'http://localhost:5173',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'capacitor://localhost',
    'tauri://localhost',
  ]);
  for (const o of config.cors.origins) {
    origins.add(o);
  }
  return Array.from(origins);
}

function parseDeviceType(ua: string): 'mobile' | 'desktop' | 'unknown' {
  if (!ua) return 'unknown';
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua)) {
    return 'mobile';
  }
  if (/Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua)) {
    return 'desktop';
  }
  return 'unknown';
}

export interface SocketLifecycleDependencies {
  buildConnectedMessage: () => ServerMessage;
  buildCanvasListMessage: () => ServerMessage | null;
  attachMessageHandler: (
    ws: ExtendedWebSocket,
    context: { agent: AgentService; orchestrator?: Orchestrator }
  ) => void;
}

export function createSocketLifecycleServer(
  server: HTTPServer,
  agent: AgentService,
  orchestrator: Orchestrator | undefined,
  deps: SocketLifecycleDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const config = getResonantConfig();
  const appPassword = config.auth.password;

  if (!appPassword) {
    console.warn('\u26a0\ufe0f  WARNING: No auth password configured \u2014 WebSocket connections are unauthenticated.');
    console.warn('   Set auth.password in resonant.yaml or APP_PASSWORD env var for production.');
  }

  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const origin = request.headers.origin;
    const allowedOrigins = getAllowedOrigins();

    const remoteAddr = (socket as Socket).remoteAddress || '';
    const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

    // ORDER: origin validation must happen before auth and upgrade acceptance so
    // rejected cross-origin sockets never get access to session validation or WS state.
    if (!isLocalhost) {
      if (!origin || !allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
    } else if (origin && !allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // ORDER: session validation must finish before handleUpgrade so authenticated
    // state stays coupled to upgrade acceptance and unauthorized sockets never connect.
    if (appPassword) {
      const cookieHeader = request.headers.cookie;
      if (!cookieHeader) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const cookies = parseCookie(cookieHeader);
      const sessionToken = cookies[COOKIE_NAME];

      if (!sessionToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const session = getWebSession(sessionToken);
      if (!session || new Date(session.expires_at) < new Date()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const ip = request.socket.remoteAddress || '';

    if (!registry.canAcceptConnection(ip)) {
      ws.close(1008, 'Too many connections from this IP');
      return;
    }

    const extWs = ws as ExtendedWebSocket;
    extWs.isAlive = true;
    extWs.userId = 'user';
    extWs.remoteIp = ip;
    extWs.voiceModeEnabled = false;
    extWs.audioChunks = [];
    extWs.isRecording = false;
    extWs.audioMimeType = 'audio/webm';
    extWs.userAgent = request.headers['user-agent'] || '';
    extWs.deviceType = parseDeviceType(extWs.userAgent);
    extWs.tabVisible = true;
    // ORDER: per-connection rate limit state must be initialized on the socket
    // during bootstrap so later message handling observes the same lifecycle.
    extWs.messageCount = 0;
    extWs.messageWindowStart = Date.now();
    extWs.prosodyAbort = null;

    // ORDER: register the socket before sending bootstrap messages so broadcasts,
    // presence checks, and connection counts match the visible connection state.
    registry.add(extWs.userId, extWs, ip);

    // ORDER: clients expect `connected` before any optional follow-up payloads.
    extWs.send(JSON.stringify(deps.buildConnectedMessage()));

    const canvasListMessage = deps.buildCanvasListMessage();
    if (canvasListMessage) {
      extWs.send(JSON.stringify(canvasListMessage));
    }

    extWs.on('pong', () => {
      extWs.isAlive = true;
    });

    deps.attachMessageHandler(extWs, { agent, orchestrator });

    extWs.on('close', () => {
      if (extWs.prosodyAbort) {
        extWs.prosodyAbort.abort();
        extWs.prosodyAbort = null;
      }
      registry.remove(extWs.userId, extWs, extWs.remoteIp);
    });

    extWs.on('error', (err) => {
      console.error('WebSocket error:', err instanceof Error ? err.message : err);
      registry.remove(extWs.userId, extWs, extWs.remoteIp);
      try { extWs.terminate(); } catch {}
    });
  });

  // ORDER: keep the 30s heartbeat cadence exactly the same as before so idle timeout
  // and pong timing stay unchanged for existing clients.
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}
