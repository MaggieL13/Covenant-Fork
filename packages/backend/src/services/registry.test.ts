import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerMessage } from '@resonant/shared';
import { ConnectionRegistry, type ExtendedWebSocket } from './registry.js';

function makeSocket(overrides: Partial<ExtendedWebSocket> = {}): ExtendedWebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    isAlive: true,
    userId: 'user',
    remoteIp: '127.0.0.1',
    voiceModeEnabled: false,
    audioChunks: [],
    isRecording: false,
    audioMimeType: 'audio/webm',
    deviceType: 'desktop',
    userAgent: 'Vitest',
    tabVisible: true,
    messageCount: 0,
    messageWindowStart: 0,
    prosodyAbort: null,
    ...overrides,
  } as unknown as ExtendedWebSocket;
}

describe('ConnectionRegistry', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('tracks add/remove per user and total connection count', () => {
    const registry = new ConnectionRegistry();
    const first = makeSocket({ userId: 'user' });
    const second = makeSocket({ userId: 'user' });
    const companion = makeSocket({ userId: 'companion' });

    registry.add('user', first, '127.0.0.1');
    registry.add('user', second, '127.0.0.1');
    registry.add('companion', companion, '127.0.0.2');

    expect(registry.getCount()).toBe(3);
    expect(registry.hasConnections()).toBe(true);
    expect(registry.isUserConnected()).toBe(true);
    expect(registry.getConnectionsForUser('user')).toEqual([first, second]);

    registry.remove('user', first, '127.0.0.1');
    expect(registry.getCount()).toBe(2);
    expect(registry.getConnectionsForUser('user')).toEqual([second]);

    registry.remove('user', second, '127.0.0.1');
    expect(registry.getConnectionsForUser('user')).toEqual([]);
    expect(registry.isUserConnected()).toBe(false);

    registry.remove('companion', companion, '127.0.0.2');
    expect(registry.getCount()).toBe(0);
    expect(registry.hasConnections()).toBe(false);
  });

  it('enforces and releases the per-IP connection limit', () => {
    const registry = new ConnectionRegistry();
    const sockets = Array.from({ length: 10 }, (_, index) =>
      makeSocket({ userId: `user-${index}` }),
    );

    for (const socket of sockets) {
      expect(registry.canAcceptConnection('10.0.0.1')).toBe(true);
      registry.add(socket.userId, socket, '10.0.0.1');
    }

    expect(registry.canAcceptConnection('10.0.0.1')).toBe(false);

    registry.remove(sockets[0].userId, sockets[0], '10.0.0.1');
    expect(registry.canAcceptConnection('10.0.0.1')).toBe(true);
  });

  it('broadcasts only to open sockets', () => {
    const registry = new ConnectionRegistry();
    const openUser = makeSocket();
    const openCompanion = makeSocket({ userId: 'companion' });
    const closedUser = makeSocket({ readyState: WebSocket.CLOSED });
    const message: ServerMessage = { type: 'presence', status: 'active' };

    registry.add('user', openUser);
    registry.add('companion', openCompanion);
    registry.add('user', closedUser);

    registry.broadcast(message);

    const encoded = JSON.stringify(message);
    expect(openUser.send).toHaveBeenCalledWith(encoded);
    expect(openCompanion.send).toHaveBeenCalledWith(encoded);
    expect(closedUser.send).not.toHaveBeenCalled();
  });

  it('broadcastExcept skips the excluded socket and closed sockets', () => {
    const registry = new ConnectionRegistry();
    const sender = makeSocket();
    const peer = makeSocket();
    const closedPeer = makeSocket({ readyState: WebSocket.CLOSED });
    const message: ServerMessage = { type: 'canvas_deleted', canvasId: 'canvas-1' };

    registry.add('user', sender);
    registry.add('user', peer);
    registry.add('user', closedPeer);

    registry.broadcastExcept(sender, message);

    const encoded = JSON.stringify(message);
    expect(sender.send).not.toHaveBeenCalled();
    expect(peer.send).toHaveBeenCalledWith(encoded);
    expect(closedPeer.send).not.toHaveBeenCalled();
  });

  it('updates user activity timestamps and presence helpers', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T12:00:00Z'));

    const registry = new ConnectionRegistry();
    const desktop = makeSocket({ deviceType: 'desktop', tabVisible: true });
    const mobileHidden = makeSocket({ deviceType: 'mobile', tabVisible: false });

    expect(registry.getUserPresenceState()).toBe('offline');
    expect(registry.minutesSinceLastUserWebActivity()).toBeGreaterThan(1000000);

    registry.add('user', desktop, '127.0.0.1');
    expect(registry.getUserPresenceState()).toBe('active');
    expect(registry.getUserDeviceType()).toBe('desktop');
    expect(registry.isUserTabVisible()).toBe(true);
    expect(registry.minutesSinceLastUserActivity()).toBe(0);
    expect(registry.minutesSinceLastUserWebActivity()).toBe(0);

    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(registry.getUserPresenceState()).toBe('idle');

    registry.touchUserActivity();
    expect(registry.getUserPresenceState()).toBe('active');

    registry.add('user', mobileHidden, '127.0.0.1');
    expect(registry.getUserDeviceType()).toBe('mobile');
    expect(registry.isUserTabVisible()).toBe(true);

    (desktop as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
    expect(registry.getConnectionsForUser('user')).toEqual([mobileHidden]);
    expect(registry.isUserTabVisible()).toBe(false);
    expect(registry.getUserPresenceState()).toBe('idle');

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(registry.minutesSinceLastUserWebActivity()).toBe(2);

    registry.touchUserWebActivity();
    expect(registry.minutesSinceLastUserWebActivity()).toBe(0);
  });
});
