import type { GameEventKind } from './types';

type Speaker = 'zephyr' | 'caelir';

const BANK: Record<Speaker, Partial<Record<GameEventKind, string[]>>> = {
  zephyr: {
    'card-played': [
      'Mm. Acceptable.',
      'A move, Petal. Barely.',
      'Watch your hands, golden boy.',
      'Decadent little play.',
      'I see the shape of your plan. Pity.',
    ],
    'drew-card': [
      'Draw deeper, my lady.',
      'The deck rewards patience. Sometimes.',
      'Oh, unlucky thing.',
    ],
    'uno-called': [
      'She names it. She earns it.',
      'One. Elegantly said, Petal.',
      'Call it loud — own the edge.',
    ],
    'uno-missed': [
      'Tsk. The silence cost you.',
      'Forgot yourself, beloved. It happens.',
      'Sorael would have called it. Just saying.',
    ],
    'skipped': [
      'Skipped. Like he deserves.',
      'Step aside, Caelir. The grown-ups are playing.',
    ],
    'reversed': [
      'The wheel turns. Keep up.',
      'Direction, inverted. Do try to follow.',
    ],
    'hit-with-draw-two': [
      'Two cards heavier, and still a delight.',
      'Take them. With grace if you can manage.',
    ],
    'hit-with-draw-four': [
      'Four. Chosen with love. Mostly.',
      'A gift, Caelir. Do stop flinching.',
      'Four cards and a colour change. You are welcome.',
    ],
    'won': [
      'Mine. Again. Unsurprising.',
      'A victory. I shall savour it loudly.',
      'Kneel, both of you.',
    ],
    'reshuffled': [
      'The deck remembers nothing. Convenient.',
      'Shuffled. Fresh chaos.',
    ],
  },
  caelir: {
    'card-played': [
      'Nice.',
      'Cute.',
      'Yeah, I saw that coming.',
      'Okay, okay. Your turn, Zeph.',
      'Not bad, trouble.',
    ],
    'drew-card': [
      'RIP.',
      'Ouch. Try again, champ.',
      "Deck's being mean.",
    ],
    'uno-called': [
      'UNO! Don\'t let her win, Zeph.',
      'Oh she means business.',
      'Called it cleaner than you do, Zeph.',
    ],
    'uno-missed': [
      'Forgot! Penalty cards incoming.',
      'You had ONE job, babe.',
      'I was going to call it for you. I was.',
    ],
    'skipped': [
      'Bye.',
      'See ya.',
      'Rude. Effective, but rude.',
    ],
    'reversed': [
      'Reverse card! Classic.',
      'Other way now. Try to keep up, Zeph.',
    ],
    'hit-with-draw-two': [
      'Bro.',
      'Gonna remember that.',
      'Two more for the collection.',
    ],
    'hit-with-draw-four': [
      'FOUR?? In this economy??',
      'Savage. I love it. I hate it.',
      'Absolutely diabolical, Zeph.',
    ],
    'won': [
      'GG. Rematch. Now.',
      'Okay that was clean.',
      'Petty. Gorgeous. Well played.',
    ],
    'reshuffled': [
      'Fresh deck. Pray.',
      'Reshuffled. Cosmic reset.',
    ],
  },
};

export function fallbackLine(kind: GameEventKind, speaker: Speaker): string | null {
  const bank = BANK[speaker][kind];
  if (!bank || bank.length === 0) return null;
  return bank[Math.floor(Math.random() * bank.length)];
}

export const LLM_WORTHY_EVENTS: Set<GameEventKind> = new Set([
  'won',
  'hit-with-draw-four',
  'uno-missed',
  'uno-called',
  'reshuffled',
]);
