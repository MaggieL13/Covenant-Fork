import { WebSocketServer } from 'ws';
import { Server as HTTPServer } from 'http';
import type { ClientMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from './registry.js';
import { listCanvases, listThreads, getTodayThread } from './db.js';
import { AgentService } from './agent.js';
import { Orchestrator } from './orchestrator.js';
import type { VoiceService } from './voice.js';
import type { DiscordService } from './discord/index.js';
import type { TelegramService } from './telegram/index.js';
import { buildCommandRegistry } from './commands.js';
import { createSocketLifecycleServer } from './ws/socket.js';
import { sendError, threadsToSummaries } from './ws/shared.js';
import { handleMessageSend } from './ws/handlers/messages.js';
import { handleSync, handleRead, handleSwitchThread, handleCreateThread } from './ws/handlers/sync.js';
import { handleRequestStatus } from './ws/handlers/status.js';
import { handleVoiceStart, handleVoiceAudio, handleVoiceStop, handleVoiceMode } from './ws/handlers/voice.js';
import {
  handleCanvasCreate,
  handleCanvasUpdate,
  handleCanvasUpdateTitle,
  handleCanvasUpdateTags,
  handleCanvasDelete,
  handleCanvasList,
} from './ws/handlers/canvases.js';
import { handleAddReaction, handleRemoveReaction } from './ws/handlers/reactions.js';
import { handlePinThread, handleUnpinThread } from './ws/handlers/threads.js';
import { handleWsCommand } from './ws/handlers/commands.js';
import { handleMcpReconnect, handleMcpToggle } from './ws/handlers/mcp.js';

const MAX_TEXT_MESSAGE_SIZE = 10 * 1024; // 10KB for text messages
const MAX_VOICE_MESSAGE_SIZE = 512 * 1024; // 512KB for voice audio chunks

export { registry } from './registry.js';

let voiceServiceInstance: VoiceService | null = null;

export function setVoiceService(vs: VoiceService): void {
  voiceServiceInstance = vs;
}

function getVoiceService(): VoiceService | null {
  return voiceServiceInstance;
}

export interface GatewayServices {
  discord?: DiscordService | null;
  telegram?: TelegramService | null;
}

let gatewayServices: GatewayServices = {};

export function setGatewayServices(services: GatewayServices): void {
  gatewayServices = services;
}

export function createWebSocketServer(server: HTTPServer, agentService?: AgentService, orchestrator?: Orchestrator): WebSocketServer {
  const agent = agentService ?? new AgentService();
  return createSocketLifecycleServer(server, agent, orchestrator, {
    buildConnectedMessage: () => {
      const threads = listThreads({ includeArchived: false });
      const today = getTodayThread();

      return {
        type: 'connected',
        sessionStatus: agent.getPresenceStatus(),
        threads: threadsToSummaries(threads),
        activeThreadId: today?.id ?? null,
        commands: buildCommandRegistry(),
      };
    },
    buildCanvasListMessage: () => {
      const canvases = listCanvases();
      return canvases.length > 0 ? { type: 'canvas_list', canvases } : null;
    },
    attachMessageHandler: (ws, context) => {
      attachMessageHandler(ws, context.agent, context.orchestrator);
    },
  });
}

function attachMessageHandler(
  extWs: ExtendedWebSocket,
  agent: AgentService,
  orchestrator?: Orchestrator
): void {
  extWs.on('message', async (data: Buffer) => {
    try {
      const rawMessage = data.toString();
      let msgType: string | undefined;
      try {
        const peek = JSON.parse(rawMessage);
        msgType = peek?.type;
      } catch {
        sendError(extWs, 'invalid_message', 'Invalid JSON');
        return;
      }

      // ORDER: rate limiter counters live on the connection object and are
      // initialized during socket bootstrap in ws/socket.ts.
      if (msgType !== 'pong' && msgType !== 'visibility') {
        const now = Date.now();
        if (now - extWs.messageWindowStart > 60000) {
          extWs.messageCount = 0;
          extWs.messageWindowStart = now;
        }
        extWs.messageCount++;
        if (extWs.messageCount > 120) {
          sendError(extWs, 'rate_limited', 'Too many messages');
          return;
        }
      }

      const maxSize = msgType === 'voice_audio' ? MAX_VOICE_MESSAGE_SIZE : MAX_TEXT_MESSAGE_SIZE;
      if (data.length > maxSize) {
        sendError(extWs, 'message_too_large', `Message exceeds ${maxSize / 1024}KB limit`);
        return;
      }

      const clientMsg = JSON.parse(rawMessage) as ClientMessage;

      switch (clientMsg.type) {
        case 'ping':
          extWs.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'message':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          await handleMessageSend(clientMsg, extWs, agent, getVoiceService);
          break;
        case 'sync':
          handleSync(clientMsg, extWs);
          break;
        case 'read':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleRead(clientMsg);
          break;
        case 'switch_thread':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleSwitchThread(clientMsg, extWs);
          break;
        case 'create_thread':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCreateThread(clientMsg);
          break;
        case 'request_status':
          handleRequestStatus(extWs, agent, gatewayServices, orchestrator);
          break;
        case 'voice_start':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleVoiceStart(extWs, clientMsg);
          break;
        case 'voice_audio':
          handleVoiceAudio(extWs, clientMsg);
          break;
        case 'voice_stop':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleVoiceStop(extWs, getVoiceService);
          break;
        case 'voice_mode':
          handleVoiceMode(extWs, clientMsg);
          break;
        case 'voice_interrupt':
          break;
        case 'canvas_create':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCanvasCreate(clientMsg, extWs);
          break;
        case 'canvas_update':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCanvasUpdate(clientMsg, extWs);
          break;
        case 'canvas_update_title':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCanvasUpdateTitle(clientMsg, extWs);
          break;
        case 'canvas_update_tags':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCanvasUpdateTags(clientMsg, extWs);
          break;
        case 'canvas_delete':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleCanvasDelete(clientMsg, extWs);
          break;
        case 'canvas_list':
          handleCanvasList(extWs);
          break;
        case 'add_reaction':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleAddReaction(clientMsg, extWs);
          break;
        case 'remove_reaction':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleRemoveReaction(clientMsg, extWs);
          break;
        case 'pin_thread':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handlePinThread(clientMsg);
          break;
        case 'unpin_thread':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          handleUnpinThread(clientMsg);
          break;
        case 'visibility':
          extWs.tabVisible = clientMsg.visible;
          break;
        case 'stop_generation':
          agent.stopGeneration();
          break;
        case 'mcp_reconnect':
          await handleMcpReconnect(clientMsg, extWs, agent);
          break;
        case 'mcp_toggle':
          await handleMcpToggle(clientMsg, extWs, agent);
          break;
        case 'rewind_files': {
          const result = await agent.rewindFiles(clientMsg.userMessageId, clientMsg.dryRun);
          const rewindMsg: import('@resonant/shared').ServerMessage = {
            type: 'rewind_result',
            canRewind: result.canRewind,
            filesChanged: result.filesChanged,
            insertions: result.insertions,
            deletions: result.deletions,
            error: result.error,
          };
          extWs.send(JSON.stringify(rewindMsg));
          break;
        }
        case 'command':
          registry.touchUserActivity();
          registry.touchUserWebActivity();
          await handleWsCommand(clientMsg, extWs, agent, orchestrator);
          break;
        default:
          console.warn('Unhandled message type:', (clientMsg as any).type);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
      sendError(extWs, 'invalid_message', 'Invalid message format');
    }
  });
}
