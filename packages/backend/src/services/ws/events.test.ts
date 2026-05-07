import { describe, expect, it, beforeEach, vi } from 'vitest';
import { registry, type ExtendedWebSocket } from '../registry.js';

vi.mock('./handlers/messages.js', () => ({
  handleMessageSend: vi.fn(),
}));
vi.mock('./handlers/sync.js', () => ({
  handleSync: vi.fn(),
  handleRead: vi.fn(),
  handleSwitchThread: vi.fn(),
  handleCreateThread: vi.fn(),
}));
vi.mock('./handlers/status.js', () => ({
  handleRequestStatus: vi.fn(),
}));
vi.mock('./handlers/voice.js', () => ({
  handleVoiceStart: vi.fn(),
  handleVoiceAudio: vi.fn(),
  handleVoiceStop: vi.fn(),
  handleVoiceMode: vi.fn(),
}));
vi.mock('./handlers/canvases.js', () => ({
  handleCanvasCreate: vi.fn(),
  handleCanvasUpdate: vi.fn(),
  handleCanvasUpdateTitle: vi.fn(),
  handleCanvasUpdateTags: vi.fn(),
  handleCanvasDelete: vi.fn(),
  handleCanvasList: vi.fn(),
}));
vi.mock('./handlers/reactions.js', () => ({
  handleAddReaction: vi.fn(),
  handleRemoveReaction: vi.fn(),
}));
vi.mock('./handlers/threads.js', () => ({
  handlePinThread: vi.fn(),
  handleUnpinThread: vi.fn(),
}));
vi.mock('./handlers/commands.js', () => ({
  handleWsCommand: vi.fn(),
}));
vi.mock('./handlers/mcp.js', () => ({
  handleMcpReconnect: vi.fn(),
  handleMcpToggle: vi.fn(),
}));

import { attachMessageHandler } from './events.js';
import { handleMessageSend } from './handlers/messages.js';
import { handleSync, handleRead, handleSwitchThread, handleCreateThread } from './handlers/sync.js';
import { handleRequestStatus } from './handlers/status.js';
import { handleVoiceStart, handleVoiceAudio, handleVoiceStop, handleVoiceMode } from './handlers/voice.js';
import {
  handleCanvasCreate,
  handleCanvasUpdate,
  handleCanvasUpdateTitle,
  handleCanvasUpdateTags,
  handleCanvasDelete,
  handleCanvasList,
} from './handlers/canvases.js';
import { handleAddReaction, handleRemoveReaction } from './handlers/reactions.js';
import { handlePinThread, handleUnpinThread } from './handlers/threads.js';
import { handleWsCommand } from './handlers/commands.js';
import { handleMcpReconnect, handleMcpToggle } from './handlers/mcp.js';

type MessageHandler = (data: Buffer) => Promise<void> | void;

function makeSocket(): ExtendedWebSocket & { trigger: (data: unknown) => Promise<void>; sendMock: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, MessageHandler>();
  const sendMock = vi.fn();
  const ws = {
    send: sendMock,
    on: vi.fn((event: string, handler: MessageHandler) => {
      listeners.set(event, handler);
      return ws;
    }),
    isAlive: true,
    userId: 'user',
    remoteIp: '127.0.0.1',
    voiceModeEnabled: false,
    audioChunks: [],
    isRecording: false,
    audioMimeType: 'audio/webm',
    deviceType: 'desktop',
    userAgent: 'vitest',
    tabVisible: true,
    messageCount: 0,
    messageWindowStart: Date.now(),
    prosodyAbort: null,
    readyState: 1,
    trigger: async (data: unknown) => {
      const handler = listeners.get('message');
      if (!handler) throw new Error('message handler not registered');
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      await handler(buffer);
    },
    sendMock,
  } as unknown as ExtendedWebSocket & { trigger: (data: unknown) => Promise<void>; sendMock: ReturnType<typeof vi.fn> };
  return ws;
}

function makeDeps() {
  let gatewayServices: { discord?: { live: boolean }; telegram?: { live: boolean } } = {
    discord: { live: false },
  };
  const agent = {
    stopGeneration: vi.fn(),
    rewindFiles: vi.fn().mockResolvedValue({
      canRewind: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 4,
      error: undefined,
    }),
  };
  return {
    deps: {
      agent: agent as any,
      orchestrator: { id: 'orch' } as any,
      getVoiceService: vi.fn(() => null),
      getGatewayServices: vi.fn(() => gatewayServices as any),
    },
    agent,
    setGatewayServices: (next: typeof gatewayServices) => {
      gatewayServices = next;
    },
  };
}

describe('attachMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends invalid_message for bad JSON', async () => {
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger('{not-json');

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      code: 'invalid_message',
      message: 'Invalid JSON',
    }));
  });

  it('returns pong for ping', async () => {
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'ping' }));

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });

  it('rate limits non-exempt messages but exempts visibility and pong', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = makeSocket();
    ws.messageCount = 120;
    ws.messageWindowStart = Date.now();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'sync', threadId: 't1', lastSeenSequence: 0 }));
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      code: 'rate_limited',
      message: 'Too many messages',
    }));
    expect(handleSync).not.toHaveBeenCalled();

    ws.sendMock.mockClear();
    await ws.trigger(JSON.stringify({ type: 'visibility', visible: false }));
    expect(ws.tabVisible).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();

    await ws.trigger(JSON.stringify({ type: 'pong' }));
    expect(ws.send).not.toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      code: 'rate_limited',
      message: 'Too many messages',
    }));

    warnSpy.mockRestore();
  });

  it('uses the correct size limit for text and voice payloads', async () => {
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    // PR #11 / chip #38: text cap raised 10KB → 100KB. Use 101KB so we
    // still exceed the cap. Voice cap unchanged at 512KB.
    const largeText = JSON.stringify({ type: 'message', content: 'a'.repeat(101 * 1024) });
    await ws.trigger(largeText);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      code: 'message_too_large',
      message: 'Message exceeds 100KB limit',
    }));
    expect(handleMessageSend).not.toHaveBeenCalled();

    ws.sendMock.mockClear();
    const largeVoice = JSON.stringify({ type: 'voice_audio', data: 'a'.repeat(513 * 1024) });
    await ws.trigger(largeVoice);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      code: 'message_too_large',
      message: 'Message exceeds 512KB limit',
    }));
    expect(handleVoiceAudio).not.toHaveBeenCalled();
  });

  it('does not touch activity for visibility or request_status', async () => {
    const touchUserActivity = vi.spyOn(registry, 'touchUserActivity');
    const touchUserWebActivity = vi.spyOn(registry, 'touchUserWebActivity');
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'visibility', visible: false }));
    await ws.trigger(JSON.stringify({ type: 'request_status' }));

    expect(ws.tabVisible).toBe(false);
    expect(touchUserActivity).not.toHaveBeenCalled();
    expect(touchUserWebActivity).not.toHaveBeenCalled();
    expect(handleRequestStatus).toHaveBeenCalledOnce();
  });

  it('uses the live gateway services getter at dispatch time', async () => {
    const ws = makeSocket();
    const { deps, setGatewayServices } = makeDeps();
    attachMessageHandler(ws, deps as any);

    setGatewayServices({ discord: { live: true }, telegram: { live: true } });
    await ws.trigger(JSON.stringify({ type: 'request_status' }));

    expect(handleRequestStatus).toHaveBeenCalledWith(
      ws,
      deps.agent,
      { discord: { live: true }, telegram: { live: true } },
      deps.orchestrator,
    );
  });

  it('touches activity before routing mutating handler cases', async () => {
    const touchUserActivity = vi.spyOn(registry, 'touchUserActivity');
    const touchUserWebActivity = vi.spyOn(registry, 'touchUserWebActivity');
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    const cases = [
      JSON.stringify({ type: 'message', content: 'hello' }),
      JSON.stringify({ type: 'read', threadId: 't1', beforeId: 'm1' }),
      JSON.stringify({ type: 'switch_thread', threadId: 't1' }),
      JSON.stringify({ type: 'create_thread', name: 'new thread' }),
      JSON.stringify({ type: 'voice_start' }),
      JSON.stringify({ type: 'voice_stop' }),
      JSON.stringify({ type: 'canvas_create', title: 'Canvas' }),
      JSON.stringify({ type: 'canvas_update', canvasId: 'c1', content: 'body' }),
      JSON.stringify({ type: 'canvas_update_title', canvasId: 'c1', title: 'New title' }),
      JSON.stringify({ type: 'canvas_update_tags', canvasId: 'c1', tags: ['a'] }),
      JSON.stringify({ type: 'canvas_delete', canvasId: 'c1' }),
      JSON.stringify({ type: 'add_reaction', messageId: 'm1', emoji: '💜' }),
      JSON.stringify({ type: 'remove_reaction', messageId: 'm1', emoji: '💜' }),
      JSON.stringify({ type: 'pin_thread', threadId: 't1' }),
      JSON.stringify({ type: 'unpin_thread', threadId: 't1' }),
      JSON.stringify({ type: 'command', name: 'help' }),
    ];

    for (const message of cases) {
      await ws.trigger(message);
    }

    expect(touchUserActivity).toHaveBeenCalledTimes(cases.length);
    expect(touchUserWebActivity).toHaveBeenCalledTimes(cases.length);
    expect(handleMessageSend).toHaveBeenCalledOnce();
    expect(handleRead).toHaveBeenCalledOnce();
    expect(handleSwitchThread).toHaveBeenCalledOnce();
    expect(handleCreateThread).toHaveBeenCalledOnce();
    expect(handleVoiceStart).toHaveBeenCalledOnce();
    expect(handleVoiceStop).toHaveBeenCalledOnce();
    expect(handleCanvasCreate).toHaveBeenCalledOnce();
    expect(handleCanvasUpdate).toHaveBeenCalledOnce();
    expect(handleCanvasUpdateTitle).toHaveBeenCalledOnce();
    expect(handleCanvasUpdateTags).toHaveBeenCalledOnce();
    expect(handleCanvasDelete).toHaveBeenCalledOnce();
    expect(handleAddReaction).toHaveBeenCalledOnce();
    expect(handleRemoveReaction).toHaveBeenCalledOnce();
    expect(handlePinThread).toHaveBeenCalledOnce();
    expect(handleUnpinThread).toHaveBeenCalledOnce();
    expect(handleWsCommand).toHaveBeenCalledOnce();
  });

  it('routes non-mutating delegated cases without extra activity touches', async () => {
    const touchUserActivity = vi.spyOn(registry, 'touchUserActivity');
    const touchUserWebActivity = vi.spyOn(registry, 'touchUserWebActivity');
    const ws = makeSocket();
    const { deps } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'sync', threadId: 't1', lastSeenSequence: 0 }));
    await ws.trigger(JSON.stringify({ type: 'voice_audio', data: 'YQ==' }));
    await ws.trigger(JSON.stringify({ type: 'voice_mode', enabled: true }));
    await ws.trigger(JSON.stringify({ type: 'canvas_list' }));
    await ws.trigger(JSON.stringify({ type: 'mcp_reconnect', serverName: 'alpha' }));
    await ws.trigger(JSON.stringify({ type: 'mcp_toggle', serverName: 'alpha', enabled: true }));

    expect(touchUserActivity).not.toHaveBeenCalled();
    expect(touchUserWebActivity).not.toHaveBeenCalled();
    expect(handleSync).toHaveBeenCalledOnce();
    expect(handleVoiceAudio).toHaveBeenCalledOnce();
    expect(handleVoiceMode).toHaveBeenCalledOnce();
    expect(handleCanvasList).toHaveBeenCalledOnce();
    expect(handleMcpReconnect).toHaveBeenCalledOnce();
    expect(handleMcpToggle).toHaveBeenCalledOnce();
  });

  it('sends rewind_result with the current shape', async () => {
    const ws = makeSocket();
    const { deps, agent } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'rewind_files', userMessageId: 'm1', dryRun: true }));

    expect(agent.rewindFiles).toHaveBeenCalledWith('m1', true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'rewind_result',
      canRewind: true,
      filesChanged: 2,
      insertions: 10,
      deletions: 4,
      error: undefined,
    }));
  });

  it('routes stop_generation to the agent directly', async () => {
    const ws = makeSocket();
    const { deps, agent } = makeDeps();
    attachMessageHandler(ws, deps as any);

    await ws.trigger(JSON.stringify({ type: 'stop_generation' }));

    expect(agent.stopGeneration).toHaveBeenCalledOnce();
  });
});
