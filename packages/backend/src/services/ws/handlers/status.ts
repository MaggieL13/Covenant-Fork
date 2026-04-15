import type { ServerMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import { AgentService } from '../../agent.js';
import { Orchestrator } from '../../orchestrator.js';
import type { DiscordService } from '../../discord/index.js';
import type { TelegramService } from '../../telegram/index.js';

export interface GatewayServicesLike {
  discord?: DiscordService | null;
  telegram?: TelegramService | null;
}

export async function handleRequestStatus(
  ws: ExtendedWebSocket,
  agent: AgentService,
  gatewayServices: GatewayServicesLike,
  orchestrator?: Orchestrator
): Promise<void> {
  const mem = process.memoryUsage();
  const orchestratorTasks = orchestrator ? await orchestrator.getStatus() : [];
  const status: import('@resonant/shared').SystemStatus = {
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
    userConnected: registry.isUserConnected(),
    minutesSinceActivity: registry.minutesSinceLastUserActivity(),
    presence: agent.getPresenceStatus(),
    agentProcessing: agent.isProcessing(),
    orchestratorTasks,
    mcpServers: agent.getMcpStatus(),
    queryQueue: { processing: agent.isProcessing(), depth: agent.getQueueDepth() },
  };

  if (gatewayServices.discord) {
    const ds = gatewayServices.discord.getStats();
    status.discord = {
      connected: ds.connected,
      guilds: ds.guilds,
      messagesProcessed: ds.messagesProcessed,
      errors: ds.errors,
      deferredPending: ds.deferredPending,
      username: ds.username,
    };
  }
  if (gatewayServices.telegram) {
    const ts = gatewayServices.telegram.getStats();
    status.telegram = {
      connected: ts.connected,
      messagesProcessed: ts.messagesProcessed,
      errors: ts.errors,
      restarts: ts.restarts,
    };
  }

  const msg: ServerMessage = { type: 'system_status', status };
  ws.send(JSON.stringify(msg));
}
