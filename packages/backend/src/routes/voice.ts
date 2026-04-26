import { Router } from 'express';
import type { VoiceService } from '../services/voice.js';

const router = Router();

router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({
        error:
          'Voice unavailable — TTS not configured (set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env). ' +
          'If you wanted to leave the user a message, send it as a normal chat reply instead. ' +
          'Do not fall back to creating a canvas or writing a file for what was meant to be a voice note.',
      });
      return;
    }

    const cleanText = text
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
      .replace(/`[^`]+`/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#+\s*/gm, '')
      .replace(/^[-*]\s+/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

    if (!cleanText) {
      res.status(400).json({ error: 'No speakable text after stripping markup' });
      return;
    }

    const truncated = cleanText.length > 5000 ? cleanText.slice(0, 5000) : cleanText;
    const audioBuffer = await voiceService.generateTTS(truncated);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length.toString());
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});

export default router;
