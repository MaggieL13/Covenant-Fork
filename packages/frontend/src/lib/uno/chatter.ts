import type { ChatterLine, GameEvent } from './types';
import { fallbackLine, LLM_WORTHY_EVENTS } from './chatter-fallback';

const SIGILS = { zephyr: '🌙', caelir: '☀️' } as const;
type Speaker = keyof typeof SIGILS;

function uuid(): string {
  return crypto.randomUUID();
}

async function fetchFromApi(event: GameEvent, speaker: Speaker, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/uno/chatter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, speaker }),
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    if (!data.text || typeof data.text !== 'string') return null;
    const trimmed = data.text.trim().slice(0, 220);
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function fetchChatterLine(event: GameEvent, speaker: Speaker): Promise<ChatterLine | null> {
  let text: string | null = null;

  if (LLM_WORTHY_EVENTS.has(event.kind)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      text = await fetchFromApi(event, speaker, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  if (!text) {
    text = fallbackLine(event.kind, speaker);
  }

  if (!text) return null;

  return {
    id: uuid(),
    speaker,
    sigil: SIGILS[speaker],
    text,
    at: Date.now(),
  };
}
