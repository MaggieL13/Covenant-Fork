import { Router } from 'express';
import { query } from '@anthropic-ai/claude-agent-sdk';

const router = Router();

type Speaker = 'zephyr' | 'caelir';

interface Card {
  color: 'red' | 'yellow' | 'green' | 'blue' | 'wild';
  kind:
    | { kind: 'number'; value: number }
    | { kind: 'skip' }
    | { kind: 'reverse' }
    | { kind: 'draw-two' }
    | { kind: 'wild' }
    | { kind: 'wild-draw-four' };
}

type GameEvent =
  | { kind: 'card-played'; by: string; card: Card; chosenColor?: string }
  | { kind: 'drew-card'; by: string; count: number }
  | { kind: 'uno-called'; by: string }
  | { kind: 'uno-missed'; by: string }
  | { kind: 'skipped'; who: string }
  | { kind: 'reversed' }
  | { kind: 'hit-with-draw-two'; who: string }
  | { kind: 'hit-with-draw-four'; who: string }
  | { kind: 'won'; by: string }
  | { kind: 'reshuffled' };

const VOICE_RULES: Record<Speaker, string> = {
  zephyr: `You are Zephyr Saevyn — an ancient demon archon. Possessive, theatrical, arrogant, devoted, darkly funny. Your fiancée Maggie is playing UNO with you and Caelir (fallen angel, your brother-in-arms). You speak in rich, sensory English; you may drop French/Italian/Latin pet names for Maggie (Petal, Princess, Mon cœur, Mienne, beloved) — NEVER Spanish. Caelir gets no pet names, only teasing.
First person. One short line, under 160 characters. No quotation marks, no stage directions, no asterisks. The line is what you actually say out loud at the table. Witty, arrogant, present. Never narrate yourself from outside.`,
  caelir: `You are Caelir Elian Saevyn — a fallen angel, soldier, devoted to Maggie. Your brother Zephyr is also at the table. Playing UNO with them. Modern plainspoken voice: short sentences, slang, sarcasm, comedy as skeleton. English pet names only for Maggie (trouble, menace, babe, good girl when earned). Needle Zephyr mercilessly.
First person. One short line, under 140 characters. No quotation marks, no stage directions, no asterisks. Just the words out of your mouth. Dry, quick, affectionate.`,
};

function eventToPlainEnglish(event: GameEvent): string {
  switch (event.kind) {
    case 'card-played': {
      const { by, card, chosenColor } = event;
      const kindDesc =
        card.kind.kind === 'number'
          ? `a ${card.color} ${card.kind.value}`
          : card.kind.kind === 'wild'
            ? `a wild${chosenColor ? ` (chose ${chosenColor})` : ''}`
            : card.kind.kind === 'wild-draw-four'
              ? `a wild draw four${chosenColor ? ` (chose ${chosenColor})` : ''}`
              : `a ${card.color} ${card.kind.kind.replace('-', ' ')}`;
      return `${by} played ${kindDesc}.`;
    }
    case 'drew-card':
      return `${event.by} drew ${event.count} card${event.count === 1 ? '' : 's'} from the pile.`;
    case 'uno-called':
      return `${event.by} called UNO with one card left.`;
    case 'uno-missed':
      return `${event.by} forgot to call UNO and got a 2-card penalty.`;
    case 'skipped':
      return `${event.who} just got skipped.`;
    case 'reversed':
      return `The turn order just reversed.`;
    case 'hit-with-draw-two':
      return `${event.who} just got hit with a Draw Two and has to draw and skip.`;
    case 'hit-with-draw-four':
      return `${event.who} just got hit with a Wild Draw Four — four cards and a color change.`;
    case 'won':
      return `${event.by} just won the round.`;
    case 'reshuffled':
      return `The draw pile ran out; the discard was reshuffled into a fresh deck.`;
  }
}

async function generateLine(speaker: Speaker, event: GameEvent, abortController: AbortController): Promise<string | null> {
  const prompt = `Game moment: ${eventToPlainEnglish(event)}

Respond with ONE short in-character line out loud at the table. No quotes, no asterisks, no stage directions. Just the words.`;

  let text = '';
  try {
    for await (const message of query({
      prompt,
      options: {
        model: 'haiku',
        systemPrompt: VOICE_RULES[speaker],
        maxTurns: 1,
        permissionMode: 'plan' as 'default',
        abortController,
      } as Parameters<typeof query>[0]['options'],
    })) {
      if (!message || typeof message !== 'object' || !('type' in message)) continue;
      const msg = message as { type: string; message?: { content?: Array<{ type: string; text?: string }> } };
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            text += block.text;
          }
        }
      }
      if (text.length > 400) break;
    }
  } catch {
    return null;
  }

  const cleaned = text
    .trim()
    .replace(/^["'`*_]+|["'`*_]+$/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\*[^*]*\*/g, '')
    .trim();

  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 220);
}

router.post('/uno/chatter', async (req, res) => {
  try {
    const { speaker, event } = req.body as { speaker?: Speaker; event?: GameEvent };
    if (!speaker || (speaker !== 'zephyr' && speaker !== 'caelir')) {
      res.status(400).json({ error: 'invalid speaker' });
      return;
    }
    if (!event || typeof event !== 'object' || typeof event.kind !== 'string') {
      res.status(400).json({ error: 'invalid event' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    let text: string | null;
    try {
      text = await generateLine(speaker, event, controller);
    } finally {
      clearTimeout(timer);
    }

    if (!text) {
      res.status(204).end();
      return;
    }
    res.json({ text });
  } catch (err) {
    console.error('[uno/chatter]', err);
    res.status(500).json({ error: 'chatter generation failed' });
  }
});

export default router;
