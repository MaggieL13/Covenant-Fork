import type { ClientMessage } from '@resonant/shared';
import { AgentService } from '../../agent.js';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import { sendError } from '../shared.js';

export async function handleMcpReconnect(
  msg: Extract<ClientMessage, { type: 'mcp_reconnect' }>,
  ws: ExtendedWebSocket,
  agent: AgentService
): Promise<void> {
  const result = await agent.reconnectMcpServer(msg.serverName);
  if (result.success) {
    registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
  } else {
    sendError(ws, 'mcp_error', result.error || 'Reconnect failed');
  }
}

export async function handleMcpToggle(
  msg: Extract<ClientMessage, { type: 'mcp_toggle' }>,
  ws: ExtendedWebSocket,
  agent: AgentService
): Promise<void> {
  const result = await agent.toggleMcpServer(msg.serverName, msg.enabled);
  if (result.success) {
    registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
  } else {
    sendError(ws, 'mcp_error', result.error || 'Toggle failed');
  }
}
