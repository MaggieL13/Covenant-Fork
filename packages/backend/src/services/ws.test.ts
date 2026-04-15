import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket } from 'ws';
import type { AgentService } from './agent.js';
import { initDb } from './db.js';
import { createWebSocketServer, setGatewayServices } from './ws.js';

vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: '127.0.0.1', db_path: ':memory:' },
    agent: { cwd: '/tmp/test' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
    auth: { password: '' },
    cors: { origins: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

describe('createWebSocketServer', () => {
  beforeEach(() => {
    initDb(':memory:');
    setGatewayServices({});
  });

  afterEach(() => {
    setGatewayServices({});
  });

  it('includes configured gateway stats in request_status responses', async () => {
    const discord = {
      getStats: () => ({
        connected: true,
        guilds: 2,
        messagesProcessed: 14,
        errors: 1,
        deferredPending: 3,
        username: 'Zephyr',
      }),
    };
    const telegram = {
      getStats: () => ({
        connected: true,
        messagesProcessed: 9,
        errors: 0,
        restarts: 4,
      }),
    };
    setGatewayServices({ discord: discord as any, telegram: telegram as any });

    const fakeAgent = {
      getPresenceStatus: () => 'active',
      getMcpStatus: () => [],
      isProcessing: () => false,
      getQueueDepth: () => 0,
      stopGeneration: vi.fn(),
    } as unknown as AgentService;

    const server = createServer();
    const wss = createWebSocketServer(server, fakeAgent);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));

    const port = (server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    const statusMessage = await new Promise<any>((resolve, reject) => {
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'connected') {
          ws.send(JSON.stringify({ type: 'request_status' }));
          return;
        }
        if (message.type === 'system_status') {
          resolve(message);
        }
      });
      ws.on('error', reject);
    });

    expect(statusMessage.status.discord).toEqual({
      connected: true,
      guilds: 2,
      messagesProcessed: 14,
      errors: 1,
      deferredPending: 3,
      username: 'Zephyr',
    });
    expect(statusMessage.status.telegram).toEqual({
      connected: true,
      messagesProcessed: 9,
      errors: 0,
      restarts: 4,
    });

    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      ws.close();
    });
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 10000);
});
