// ConnectionRegistry — tracks WebSocket connections per user.
// Extracted from ws.ts to break the circular dependency with agent.ts.

import { WebSocket } from 'ws';
import type { ServerMessage } from '@resonant/shared';

// ---------------------------------------------------------------------------
// ExtendedWebSocket — augmented WebSocket with per-connection metadata
// ---------------------------------------------------------------------------

export interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string;
  remoteIp: string;
  voiceModeEnabled: boolean;
  audioChunks: Buffer[];
  isRecording: boolean;
  audioMimeType: string;
  deviceType: 'mobile' | 'desktop' | 'unknown';
  userAgent: string;
  tabVisible: boolean;
  messageCount: number;
  messageWindowStart: number;
  prosodyAbort: AbortController | null;
}

// ---------------------------------------------------------------------------
// ConnectionRegistry
// ---------------------------------------------------------------------------

export class ConnectionRegistry {
  private connections = new Map<string, Set<ExtendedWebSocket>>();
  private _lastUserActivity: Date = new Date();
  private _lastUserWebActivity: Date = new Date(0);
  private connectionsByIp = new Map<string, number>();
  private readonly MAX_CONNECTIONS_PER_IP = 10;

  canAcceptConnection(ip: string): boolean {
    const current = this.connectionsByIp.get(ip) || 0;
    return current < this.MAX_CONNECTIONS_PER_IP;
  }

  add(userId: string, ws: ExtendedWebSocket, ip?: string): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);
    if (ip) {
      this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) || 0) + 1);
    }
    if (userId === 'user') {
      this._lastUserActivity = new Date();
      this._lastUserWebActivity = new Date();
    }
  }

  remove(userId: string, ws: ExtendedWebSocket, ip?: string): void {
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(ws);
      if (userConnections.size === 0) {
        this.connections.delete(userId);
      }
    }
    if (ip) {
      const current = this.connectionsByIp.get(ip) || 0;
      if (current <= 1) {
        this.connectionsByIp.delete(ip);
      } else {
        this.connectionsByIp.set(ip, current - 1);
      }
    }
  }

  touchUserActivity(): void {
    this._lastUserActivity = new Date();
  }

  touchUserWebActivity(): void {
    this._lastUserWebActivity = new Date();
  }

  minutesSinceLastUserWebActivity(): number {
    return (Date.now() - this._lastUserWebActivity.getTime()) / 60000;
  }

  broadcast(message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  broadcastExcept(excludeWs: WebSocket, message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  getCount(): number {
    let count = 0;
    for (const connections of this.connections.values()) {
      count += connections.size;
    }
    return count;
  }

  hasConnections(): boolean {
    return this.getCount() > 0;
  }

  isUserConnected(): boolean {
    const userConns = this.connections.get('user');
    return !!userConns && userConns.size > 0;
  }

  getLastUserActivity(): Date {
    return this._lastUserActivity;
  }

  minutesSinceLastUserActivity(): number {
    return (Date.now() - this._lastUserActivity.getTime()) / 60000;
  }

  getConnectionsForUser(userId: string): ExtendedWebSocket[] {
    const conns = this.connections.get(userId);
    if (!conns) return [];
    return Array.from(conns).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  getUserDeviceType(): 'mobile' | 'desktop' | 'unknown' {
    const conns = this.getConnectionsForUser('user');
    if (conns.length === 0) return 'unknown';
    // Return device type of most recent connection (last in set)
    return conns[conns.length - 1].deviceType;
  }

  isUserTabVisible(): boolean {
    const conns = this.getConnectionsForUser('user');
    return conns.some(c => c.tabVisible);
  }

  getUserPresenceState(): 'active' | 'idle' | 'offline' {
    if (!this.isUserConnected()) return 'offline';
    if (!this.isUserTabVisible()) return 'idle';
    if (this.minutesSinceLastUserActivity() < 5) return 'active';
    return 'idle';
  }
}

// Singleton instance — shared across the application
export const registry = new ConnectionRegistry();
