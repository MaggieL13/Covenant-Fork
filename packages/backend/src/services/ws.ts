import { WebSocketServer } from 'ws';
import { Server as HTTPServer } from 'http';
import { registry } from './registry.js';
import { listCanvases, listThreads, getTodayThread } from './db.js';
import { AgentService } from './agent.js';
import { Orchestrator } from './orchestrator.js';
import type { VoiceService } from './voice.js';
import { buildCommandRegistry } from './commands.js';
import { createSocketLifecycleServer } from './ws/socket.js';
import { threadsToSummaries } from './ws/shared.js';
import { attachMessageHandler } from './ws/events.js';
import type { GatewayServices } from './ws/handlers/status.js';

export { registry } from './registry.js';
export type { GatewayServices } from './ws/handlers/status.js';

let voiceServiceInstance: VoiceService | null = null;

export function setVoiceService(vs: VoiceService): void {
  voiceServiceInstance = vs;
}

function getVoiceService(): VoiceService | null {
  return voiceServiceInstance;
}

let gatewayServices: GatewayServices = {};

export function setGatewayServices(services: GatewayServices): void {
  gatewayServices = services;
}

function getGatewayServices(): GatewayServices {
  return gatewayServices;
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
      attachMessageHandler(ws, {
        agent: context.agent,
        orchestrator: context.orchestrator,
        getVoiceService,
        getGatewayServices,
      });
    },
  });
}
