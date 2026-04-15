import type { ClientMessage } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import { AgentService } from '../../agent.js';
import { Orchestrator } from '../../orchestrator.js';
import { listThreads } from '../../db.js';
import { handleCommand } from '../../commands.js';
import { threadsToSummaries } from '../shared.js';

export async function handleWsCommand(
  msg: Extract<ClientMessage, { type: 'command' }>,
  ws: ExtendedWebSocket,
  agent: AgentService,
  orchestrator?: Orchestrator
): Promise<void> {
  const cmdResult = await handleCommand(
    msg.name,
    msg.args,
    msg.threadId,
    { agent, orchestrator, registry },
  );
  ws.send(JSON.stringify(cmdResult));

  if (msg.name === 'new' || msg.name === 'rename') {
    const updatedThreads = listThreads({ includeArchived: false });
    registry.broadcast({ type: 'thread_list', threads: threadsToSummaries(updatedThreads) });
  }
}
