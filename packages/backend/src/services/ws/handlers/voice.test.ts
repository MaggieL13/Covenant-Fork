import { describe, expect, it, vi } from 'vitest';
import { handleVoiceAudio, handleVoiceStart, handleVoiceStop } from './voice.js';
import type { ExtendedWebSocket } from '../../registry.js';

function makeSocket(): ExtendedWebSocket {
  return {
    audioChunks: [],
    isRecording: false,
    audioMimeType: 'audio/webm',
    voiceModeEnabled: false,
    isAlive: true,
    userId: 'user',
    remoteIp: '127.0.0.1',
    deviceType: 'desktop',
    userAgent: 'vitest',
    tabVisible: true,
    messageCount: 0,
    messageWindowStart: 0,
    prosodyAbort: null,
    send: vi.fn(),
    readyState: 1,
  } as unknown as ExtendedWebSocket;
}

describe('voice handlers', () => {
  it('resets the audio buffer when a new recording starts', () => {
    const ws = makeSocket();
    ws.audioChunks = [Buffer.from('old')];

    handleVoiceStart(ws, { type: 'voice_start' });

    expect(ws.isRecording).toBe(true);
    expect(ws.audioChunks).toEqual([]);
  });

  it('clears buffered audio immediately after stop hands work to transcription', async () => {
    const ws = makeSocket();
    ws.isRecording = true;
    ws.audioChunks = [Buffer.from('abc')];

    const transcribe = vi.fn().mockResolvedValue('hello there');
    const voiceService = {
      canTranscribe: true,
      canAnalyzeProsody: false,
      transcribe,
    };

    const stopPromise = handleVoiceStop(ws, () => voiceService as any);
    expect(ws.audioChunks).toEqual([]);
    await stopPromise;

    expect(ws.isRecording).toBe(false);
    expect(transcribe).toHaveBeenCalledOnce();
    expect((ws.send as any).mock.calls[0][0]).toContain('"status":"processing"');
    expect((ws.send as any).mock.calls.at(-1)[0]).toContain('"status":"complete"');
  });
});
