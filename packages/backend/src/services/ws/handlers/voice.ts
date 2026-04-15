import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@resonant/shared';
import type { ExtendedWebSocket } from '../../registry.js';
import type { VoiceService } from '../../voice.js';
import { sendError } from '../shared.js';

const MAX_AUDIO_BUFFER_SIZE = 25 * 1024 * 1024; // 25MB total accumulated audio

export type GetVoiceService = () => VoiceService | null;

export function handleVoiceStart(
  ws: ExtendedWebSocket,
  _msg: Extract<ClientMessage, { type: 'voice_start' }>
): void {
  // ORDER: clear any previous buffer before marking the socket as recording so
  // new chunks cannot mix with stale audio from an interrupted recording.
  ws.audioChunks = [];
  ws.isRecording = true;
}

export function handleVoiceAudio(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_audio' }>
): void {
  if (!ws.isRecording) return;
  const chunk = Buffer.from(msg.data, 'base64');

  const currentSize = ws.audioChunks.reduce((sum, c) => sum + c.length, 0);
  if (currentSize + chunk.length > MAX_AUDIO_BUFFER_SIZE) {
    sendError(ws, 'audio_too_large', `Audio recording exceeds ${MAX_AUDIO_BUFFER_SIZE / (1024 * 1024)}MB limit`);
    ws.isRecording = false;
    ws.audioChunks = [];
    return;
  }

  ws.audioChunks.push(chunk);
}

export async function handleVoiceStop(
  ws: ExtendedWebSocket,
  getVoiceService: GetVoiceService
): Promise<void> {
  ws.isRecording = false;

  if (ws.audioChunks.length === 0) {
    const statusMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'No audio data received',
    };
    ws.send(JSON.stringify(statusMsg));
    return;
  }

  const processingMsg: ServerMessage = {
    type: 'transcription_status',
    status: 'processing',
  };
  ws.send(JSON.stringify(processingMsg));

  // ORDER: concatenate and then clear the live socket buffer immediately so the
  // connection can start collecting the next recording while transcription runs.
  const audioBuffer = Buffer.concat(ws.audioChunks);
  ws.audioChunks = [];

  const voiceService = getVoiceService();
  if (!voiceService?.canTranscribe) {
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'Transcription not configured — set GROQ_API_KEY in .env',
    };
    ws.send(JSON.stringify(errorMsg));
    return;
  }

  try {
    // ORDER: abort the prior prosody job before installing a new controller so
    // the socket only tracks one live enrichment request at a time.
    if (ws.prosodyAbort) ws.prosodyAbort.abort();
    const prosodyAbort = new AbortController();
    ws.prosodyAbort = prosodyAbort;

    const [transcript, prosody] = await Promise.all([
      voiceService.transcribe(audioBuffer, ws.audioMimeType),
      voiceService.canAnalyzeProsody
        ? voiceService.analyzeProsody(audioBuffer, ws.audioMimeType, prosodyAbort.signal).catch(err => {
            if (err?.name === 'AbortError') return null;
            console.warn('[Voice] Prosody analysis failed (continuing):', err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    ws.prosodyAbort = null;

    if (!transcript.trim()) {
      const emptyMsg: ServerMessage = {
        type: 'transcription_status',
        status: 'error',
        error: 'No speech detected',
      };
      ws.send(JSON.stringify(emptyMsg));
      return;
    }

    if (prosody) {
      console.log(`[Voice] Prosody detected: ${JSON.stringify(prosody)}`);
    }

    const completeMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'complete',
      text: transcript,
      ...(prosody && { prosody }),
    };
    ws.send(JSON.stringify(completeMsg));
  } catch (error) {
    console.error('[Voice] Transcription error:', error);
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: error instanceof Error ? error.message : 'Transcription failed',
    };
    ws.send(JSON.stringify(errorMsg));
  }
}

export function handleVoiceMode(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_mode' }>
): void {
  ws.voiceModeEnabled = msg.enabled;
  console.log(`[Voice] Voice mode ${msg.enabled ? 'enabled' : 'disabled'} for connection`);

  const ackMsg: ServerMessage = {
    type: 'voice_mode_ack',
    enabled: msg.enabled,
  };
  ws.send(JSON.stringify(ackMsg));
}

export async function generateAndStreamTTS(
  text: string,
  messageId: string,
  connections: ExtendedWebSocket[],
  getVoiceService: GetVoiceService
): Promise<void> {
  const voiceService = getVoiceService();
  if (!voiceService) return;

  // ORDER: clients rely on start -> audio -> end framing for TTS playback.
  const startMsg = JSON.stringify({ type: 'tts_start', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(startMsg);
  }

  try {
    const audioBuffer = await voiceService.generateTTS(text);
    const base64 = audioBuffer.toString('base64');

    const audioMsg = JSON.stringify({
      type: 'tts_audio',
      messageId,
      data: base64,
      final: true,
    } satisfies ServerMessage);

    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(audioMsg);
    }
  } catch (error) {
    console.error('[Voice] TTS generation error:', error);
  }

  const endMsg = JSON.stringify({ type: 'tts_end', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(endMsg);
  }
}
