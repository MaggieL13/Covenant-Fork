import crypto from 'crypto';
import type { ClientMessage, Thread } from '@resonant/shared';
import { registry, type ExtendedWebSocket } from '../../registry.js';
import {
  getDb,
  createMessage,
  createThread,
  getThread,
  getTodayThread,
  updateThreadActivity,
} from '../../db.js';
import { AgentService } from '../../agent.js';
import { getFile } from '../../files.js';
import { getResonantConfig } from '../../../config.js';
import { localDateStr } from '../../time.js';
import { sendError } from '../shared.js';
import { generateAndStreamTTS, type GetVoiceService } from './voice.js';

export async function handleMessageSend(
  msg: Extract<ClientMessage, { type: 'message' }>,
  ws: ExtendedWebSocket,
  agentService: AgentService,
  getVoiceService: GetVoiceService
): Promise<void> {
  const now = new Date().toISOString();
  const config = getResonantConfig();

  let thread: Thread | null = null;
  if (msg.threadId) {
    thread = getThread(msg.threadId);
  } else {
    thread = getTodayThread();
    if (!thread) {
      // Sovereignty: Node ICU can lag IANA for some zones; route date
      // naming through time.ts so the daily thread label matches the
      // agent-context Time/Date strings.
      const dayName = localDateStr(config.identity.timezone);
      thread = createThread({
        id: crypto.randomUUID(),
        name: dayName,
        type: 'daily',
        createdAt: now,
        sessionType: 'v2',
      });
    }
  }

  if (!thread) {
    sendError(ws, 'thread_not_found', 'Thread not found');
    return;
  }

  const userMessage = createMessage({
    id: crypto.randomUUID(),
    threadId: thread.id,
    role: 'user',
    content: msg.content,
    contentType: msg.contentType || 'text',
    metadata: msg.metadata,
    replyToId: msg.replyToId,
    createdAt: now,
  });

  getDb().prepare('UPDATE messages SET delivered_at = ?, read_at = ? WHERE id = ?').run(now, now, userMessage.id);
  userMessage.delivered_at = now;
  userMessage.read_at = now;

  updateThreadActivity(thread.id, now, false);
  registry.broadcast({ type: 'message', message: userMessage });

  let agentPrompt = msg.content;

  const batchAttachments = (msg.metadata as any)?.attachments as Array<{
    fileId: string; filename: string; mimeType: string; size: number;
    url: string; contentType: string;
  }> | undefined;

  if (batchAttachments && batchAttachments.length > 0) {
    for (const att of batchAttachments) {
      const fileMsg = createMessage({
        id: crypto.randomUUID(),
        threadId: thread.id,
        role: 'user',
        content: att.url,
        contentType: att.contentType as 'image' | 'audio' | 'file',
        metadata: { fileId: att.fileId, filename: att.filename, size: att.size, mimeType: att.mimeType },
        createdAt: now,
      });
      registry.broadcast({ type: 'message', message: fileMsg });
    }

    const images = batchAttachments.filter(a => a.contentType === 'image');
    const others = batchAttachments.filter(a => a.contentType !== 'image');
    const promptParts: string[] = [];

    if (images.length === 1) {
      const info = getFile(images[0].fileId);
      promptParts.push(`${config.identity.user_name} sent an image (${images[0].filename}).${info ? ` You can view it at: ${info.path}` : ''}`);
    } else if (images.length > 1) {
      const lines = images.map((a, i) => {
        const info = getFile(a.fileId);
        return `${i + 1}. ${a.filename}${info ? ` - ${info.path}` : ''}`;
      });
      promptParts.push(`${config.identity.user_name} sent ${images.length} images:\n${lines.join('\n')}`);
    }

    for (const a of others) {
      const info = getFile(a.fileId);
      const sizeStr = a.size ? ` (${Math.round(a.size / 1024)}KB)` : '';
      promptParts.push(`${config.identity.user_name} sent a ${a.contentType}: ${a.filename}${sizeStr}${info ? ` - ${info.path}` : ''}`);
    }

    if (msg.content?.trim()) {
      promptParts.push(`\nTheir message: ${msg.content.trim()}`);
    }

    agentPrompt = promptParts.join('\n');
  } else {
    const ct = msg.contentType || 'text';
    if (ct !== 'text' && msg.metadata) {
      const meta = msg.metadata as Record<string, unknown>;
      const fileId = meta.fileId as string | undefined;
      const filename = meta.filename as string | undefined;
      const size = meta.size as number | undefined;

      let diskPath = '';
      if (fileId) {
        const fileInfo = getFile(fileId);
        if (fileInfo) diskPath = fileInfo.path;
      }

      if (ct === 'image') {
        agentPrompt = `${config.identity.user_name} sent an image${filename ? ` (${filename})` : ''}.${diskPath ? ` You can view it at: ${diskPath}` : ''}`;
      } else if (ct === 'audio') {
        agentPrompt = `${config.identity.user_name} sent an audio message${filename ? ` (${filename})` : ''}.${diskPath ? ` File path: ${diskPath}` : ''}`;
      } else if (ct === 'file') {
        agentPrompt = `${config.identity.user_name} sent a file: ${filename || 'unknown'}${size ? ` (${Math.round(size / 1024)}KB)` : ''}.${diskPath ? ` File path: ${diskPath}` : ''}`;
      }
    }
  }

  if (msg.metadata && typeof msg.metadata === 'object') {
    const prosody = (msg.metadata as Record<string, unknown>).prosody as Record<string, number> | undefined;
    if (prosody && Object.keys(prosody).length > 0) {
      const toneEntries = Object.entries(prosody)
        .map(([emotion, score]) => `${emotion}: ${score}`)
        .join(', ');
      agentPrompt = `[Voice tone - ${toneEntries}]\n${agentPrompt}`;
    }
  }

  try {
    const agentResponse = await agentService.processMessage(thread.id, agentPrompt, { name: thread.name, type: thread.type });
    updateThreadActivity(thread.id, new Date().toISOString(), true);

    const voiceService = getVoiceService();
    const hasVoice = voiceService?.canTTS;
    const responseLen = agentResponse?.length ?? 0;
    console.log(`[Voice] Auto-TTS check: hasVoice=${hasVoice}, responseLen=${responseLen}`);

    if (hasVoice && agentResponse) {
      const voiceConnections = registry.getConnectionsForUser('user')
        .filter(c => (c as ExtendedWebSocket).voiceModeEnabled);

      console.log(`[Voice] Voice mode connections: ${voiceConnections.length}`);

      if (voiceConnections.length > 0) {
        const ttsText = typeof agentResponse === 'string' ? agentResponse : String(agentResponse);
        if (ttsText.trim()) {
          console.log(`[Voice] Generating TTS for ${ttsText.length} chars`);
          const messageId = crypto.randomUUID();
          generateAndStreamTTS(ttsText, messageId, voiceConnections as ExtendedWebSocket[], getVoiceService).catch(err => {
            console.error('[Voice] Auto-TTS error:', err);
          });
        }
      }
    }
  } catch (error) {
    console.error('Agent processing error:', error);
    sendError(ws, 'agent_error', `${config.identity.companion_name} encountered an error processing your message`);
  }
}
