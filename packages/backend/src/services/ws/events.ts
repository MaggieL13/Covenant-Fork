import type { ClientMessage, ServerMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../registry.js';
import { AgentService } from '../agent.js';
import { Orchestrator } from '../orchestrator.js';
import { sendError } from './shared.js';
import { handleMessageSend } from './handlers/messages.js';
import { handleSync, handleRead, handleSwitchThread, handleCreateThread } from './handlers/sync.js';
import { handleRequestStatus, type GatewayServices } from './handlers/status.js';
import type { GetVoiceService } from './handlers/voice.js';
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

// 100KB for text messages — bumped from 10KB in PR #11 / chip #38.
// 10KB clipped long thoughtful messages around the 2,500 word mark; the
// new cap is ~25,000 words. Voice frames (audio chunks) stay at the
// existing 512KB — different kind of payload, no reason to bump.
const MAX_TEXT_MESSAGE_SIZE = 100 * 1024;
const MAX_VOICE_MESSAGE_SIZE = 512 * 1024;

export interface WsEventDependencies {
  agent: AgentService;
  orchestrator?: Orchestrator;
  getVoiceService: GetVoiceService;
  getGatewayServices: () => GatewayServices;
}

function touchActivity(): void {
  registry.touchUserActivity();
  registry.touchUserWebActivity();
}

export function attachMessageHandler(
  extWs: ExtendedWebSocket,
  deps: WsEventDependencies
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

      // ORDER: rate limiting must happen before dispatch so rejected messages
      // never reach handlers or trigger activity/broadcast side effects.
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

      // ORDER: apply the size limit after peeking the type but before the final
      // parse/dispatch so voice payloads keep their larger cap without reaching handlers.
      const maxSize = msgType === 'voice_audio' ? MAX_VOICE_MESSAGE_SIZE : MAX_TEXT_MESSAGE_SIZE;
      if (data.length > maxSize) {
        sendError(extWs, 'message_too_large', `Message exceeds ${maxSize / 1024}KB limit`);
        return;
      }

      const clientMsg = JSON.parse(rawMessage) as ClientMessage;

      switch (clientMsg.type) {
        // ORDER: ping short-circuits immediately and must not touch activity.
        case 'ping':
          extWs.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage));
          break;
        case 'message':
          // ORDER: touch activity before dispatching mutating handlers so presence
          // reflects user intent even if the handler later fails.
          touchActivity();
          await handleMessageSend(clientMsg, extWs, deps.agent, deps.getVoiceService);
          break;
        case 'sync':
          handleSync(clientMsg, extWs);
          break;
        case 'read':
          touchActivity();
          handleRead(clientMsg);
          break;
        case 'switch_thread':
          touchActivity();
          handleSwitchThread(clientMsg, extWs);
          break;
        case 'create_thread':
          touchActivity();
          handleCreateThread(clientMsg);
          break;
        case 'request_status':
          await handleRequestStatus(extWs, deps.agent, deps.getGatewayServices(), deps.orchestrator);
          break;
        case 'voice_start':
          touchActivity();
          handleVoiceStart(extWs, clientMsg);
          break;
        case 'voice_audio':
          handleVoiceAudio(extWs, clientMsg);
          break;
        case 'voice_stop':
          touchActivity();
          await handleVoiceStop(extWs, deps.getVoiceService);
          break;
        case 'voice_mode':
          handleVoiceMode(extWs, clientMsg);
          break;
        case 'voice_interrupt':
          break;
        case 'canvas_create':
          touchActivity();
          handleCanvasCreate(clientMsg, extWs);
          break;
        case 'canvas_update':
          touchActivity();
          handleCanvasUpdate(clientMsg, extWs);
          break;
        case 'canvas_update_title':
          touchActivity();
          handleCanvasUpdateTitle(clientMsg, extWs);
          break;
        case 'canvas_update_tags':
          touchActivity();
          handleCanvasUpdateTags(clientMsg, extWs);
          break;
        case 'canvas_delete':
          touchActivity();
          handleCanvasDelete(clientMsg, extWs);
          break;
        case 'canvas_list':
          handleCanvasList(extWs);
          break;
        case 'add_reaction':
          touchActivity();
          handleAddReaction(clientMsg, extWs);
          break;
        case 'remove_reaction':
          touchActivity();
          handleRemoveReaction(clientMsg, extWs);
          break;
        case 'pin_thread':
          touchActivity();
          handlePinThread(clientMsg);
          break;
        case 'unpin_thread':
          touchActivity();
          handleUnpinThread(clientMsg);
          break;
        case 'visibility':
          extWs.tabVisible = clientMsg.visible;
          break;
        case 'stop_generation':
          deps.agent.stopGeneration();
          break;
        case 'mcp_reconnect':
          await handleMcpReconnect(clientMsg, extWs, deps.agent);
          break;
        case 'mcp_toggle':
          await handleMcpToggle(clientMsg, extWs, deps.agent);
          break;
        case 'rewind_files': {
          const result = await deps.agent.rewindFiles(clientMsg.userMessageId, clientMsg.dryRun);
          const rewindMsg: ServerMessage = {
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
          touchActivity();
          await handleWsCommand(clientMsg, extWs, deps.agent, deps.orchestrator);
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
