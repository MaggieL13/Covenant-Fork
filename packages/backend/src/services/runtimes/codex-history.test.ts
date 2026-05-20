import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '@resonant/shared';

// ─────────────────────────────────────────────────────────────────────────
// Mocks — same shape as codex-image-extractor.test.ts. The extractor
// reads fs.statSync + fs.readFileSync against paths returned by
// getFile; we wire fixtures the test controls.
// ─────────────────────────────────────────────────────────────────────────

interface FsFixture {
  files: Map<string, { size: number; bytes: Buffer }>;
}
const fsFixture: FsFixture = { files: new Map() };

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statSync: (p: string) => {
      const entry = fsFixture.files.get(p);
      if (!entry) {
        const err = new Error(`ENOENT: no such file ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return { size: entry.size } as ReturnType<typeof actual.statSync>;
    },
    readFileSync: ((p: string) => {
      const entry = fsFixture.files.get(p);
      if (!entry) {
        const err = new Error(`ENOENT: no such file ${p}`);
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        throw err;
      }
      return entry.bytes;
    }) as typeof actual.readFileSync,
  };
});

interface FileFixtureEntry {
  path: string;
  mimeType: string;
  filename: string;
}
const getFileFixture = new Map<string, FileFixtureEntry | null>();
vi.mock('../files.js', () => ({
  getFile: (fileId: string) => getFileFixture.get(fileId) ?? null,
}));

// Import AFTER mocks.
const { buildCodexNormalizedMessages } = await import('./codex-history.js');
const { toPiMessages } = await import('./codex.js');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function makeMessage(partial: Partial<Message> & { id: string }): Message {
  return {
    id: partial.id,
    thread_id: partial.thread_id ?? 'thread-1',
    sequence: partial.sequence ?? 0,
    role: partial.role ?? 'user',
    content: partial.content ?? '',
    content_type: partial.content_type ?? 'text',
    platform: partial.platform ?? 'web',
    metadata: partial.metadata ?? null,
    reply_to_id: partial.reply_to_id ?? null,
    reply_to_preview: partial.reply_to_preview ?? null,
    edited_at: partial.edited_at ?? null,
    deleted_at: partial.deleted_at ?? null,
    original_content: partial.original_content ?? null,
    created_at: partial.created_at ?? '2026-05-20T00:00:00.000Z',
    delivered_at: partial.delivered_at ?? null,
  } as Message;
}

function registerImageFile(
  fileId: string,
  opts: { binarySize?: number; mimeType?: string; path?: string } = {},
): void {
  const path = opts.path ?? `/data/files/${fileId}.png`;
  const mimeType = opts.mimeType ?? 'image/png';
  const binarySize = opts.binarySize ?? 1024;
  getFileFixture.set(fileId, { path, mimeType, filename: `${fileId}.png` });
  fsFixture.files.set(path, {
    size: binarySize,
    bytes: Buffer.alloc(binarySize, 0xab),
  });
}

beforeEach(() => {
  fsFixture.files.clear();
  getFileFixture.clear();
});

// ─────────────────────────────────────────────────────────────────────────
// toPiMessages shape tests — PR E3a's pi-ai contract
// ─────────────────────────────────────────────────────────────────────────

describe('toPiMessages — vision shape', () => {
  it('emits plain-string content for a text-only user message', () => {
    const out = toPiMessages([
      { role: 'user', content: 'hello', createdAt: '2026-05-20T00:00:00.000Z' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect((out[0] as { content: unknown }).content).toBe('hello');
  });

  it('emits pi-ai mixed-content with text first when images are present', () => {
    const out = toPiMessages([
      {
        role: 'user',
        content: 'what is in this picture?',
        createdAt: '2026-05-20T00:00:00.000Z',
        images: [{ base64: 'AAAA', mimeType: 'image/png' }],
      },
    ]);
    expect(out).toHaveLength(1);
    const content = (out[0] as { content: unknown[] }).content as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    expect(content).toHaveLength(2);
    // Text leads — the model sees the caption before the image.
    expect(content[0]).toEqual({ type: 'text', text: 'what is in this picture?' });
    // pi-ai's ImageContent shape — base64 in `data`, MIME separately.
    // Specifically NOT the raw OpenAI `{type:'input_image', image_url}`
    // shape (pi-ai converts internally; we work at the pi-ai layer).
    expect(content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  });

  it('preserves multi-image declared order after the caption', () => {
    const out = toPiMessages([
      {
        role: 'user',
        content: 'compare these two',
        createdAt: '2026-05-20T00:00:00.000Z',
        images: [
          { base64: 'CAT', mimeType: 'image/png' },
          { base64: 'DOG', mimeType: 'image/jpeg' },
        ],
      },
    ]);
    const content = (out[0] as { content: unknown[] }).content as Array<{
      type: string;
      data?: string;
      mimeType?: string;
    }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'image', 'image']);
    expect(content[1]).toMatchObject({ data: 'CAT', mimeType: 'image/png' });
    expect(content[2]).toMatchObject({ data: 'DOG', mimeType: 'image/jpeg' });
  });

  it('ignores `images` on assistant messages (replay history)', () => {
    const out = toPiMessages([
      {
        role: 'assistant',
        content: 'I see a cat.',
        createdAt: '2026-05-20T00:00:00.000Z',
        images: [{ base64: 'NOPE', mimeType: 'image/png' }],
      },
    ]);
    const content = (out[0] as { content: unknown[] }).content;
    // Assistant content stays text-only — pi-ai's replay history shape
    // doesn't carry images on assistant turns.
    expect(content).toEqual([{ type: 'text', text: 'I see a cat.' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCodexNormalizedMessages — single attachment / Telegram shape
// ─────────────────────────────────────────────────────────────────────────

describe('buildCodexNormalizedMessages — Telegram (single attachment)', () => {
  it('attaches the image to the DB message when content matches verbatim', () => {
    registerImageFile('tg-img', { binarySize: 256, mimeType: 'image/jpeg' });

    const content =
      '[Photo from Maggie] check this out\nImage saved at: data/files/tg-img.jpg — use Read tool to see it.';
    const dbMessages: Message[] = [
      makeMessage({
        id: 'tg-msg',
        content_type: 'image',
        content,
        metadata: { fileId: 'tg-img', photoFileId: 'tg-img', mimeType: 'image/jpeg' },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: content,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    expect(result.appendedSynthetic).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].images).toHaveLength(1);
    expect(result.messages[0].images![0].mimeType).toBe('image/jpeg');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCodexNormalizedMessages — batched upload (load-bearing)
// ─────────────────────────────────────────────────────────────────────────

describe('buildCodexNormalizedMessages — batched upload (web)', () => {
  /**
   * Simulates the real ws/handlers/messages.ts batched-upload flow:
   *   1. Parent text message stores the user's raw caption as `content`
   *      and the attachments array in metadata.
   *   2. One child message per attachment with content=url and
   *      metadata.fileId.
   *   3. The handler builds a separate `agentPrompt` string with
   *      synthesized multi-image narration + file paths, and passes
   *      it to agentService.processMessage as `content`.
   *
   * The integration must end with the LAST normalized message
   * carrying BOTH the synthesized text AND the image bytes —
   * otherwise pi-ai would see the description but no image bytes.
   * This is the Codex PR E3a/2 review test.
   */
  it('bridges parent-claimed images onto the appended synthetic prompt', () => {
    registerImageFile('img-cat', { binarySize: 512, mimeType: 'image/png' });
    registerImageFile('img-dog', { binarySize: 768, mimeType: 'image/jpeg' });

    const rawCaption = 'what are these?';
    const synthesizedAgentPrompt =
      `Maggie sent 2 images:\n` +
      `1. cat.png - /data/files/img-cat.png\n` +
      `2. dog.jpg - /data/files/img-dog.jpg\n` +
      `\nTheir message: ${rawCaption}`;

    const dbMessages: Message[] = [
      // Parent: raw caption + attachments metadata.
      makeMessage({
        id: 'parent',
        created_at: '2026-05-20T00:00:00.000Z',
        content_type: 'text',
        content: rawCaption,
        metadata: {
          attachments: [
            { fileId: 'img-cat', filename: 'cat.png', mimeType: 'image/png', contentType: 'image' },
            { fileId: 'img-dog', filename: 'dog.jpg', mimeType: 'image/jpeg', contentType: 'image' },
          ],
        },
      }),
      // Child file messages — one per attachment, content=url.
      makeMessage({
        id: 'child-cat',
        created_at: '2026-05-20T00:00:00.000Z',
        content_type: 'image',
        content: '/api/files/img-cat',
        metadata: { fileId: 'img-cat', filename: 'cat.png', mimeType: 'image/png' },
      }),
      makeMessage({
        id: 'child-dog',
        created_at: '2026-05-20T00:00:00.000Z',
        content_type: 'image',
        content: '/api/files/img-dog',
        metadata: { fileId: 'img-dog', filename: 'dog.jpg', mimeType: 'image/jpeg' },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: synthesizedAgentPrompt,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    // The synthetic-prompt path fired (raw caption on parent doesn't
    // match the synthesized agentPrompt).
    expect(result.appendedSynthetic).toBe(true);

    // The LAST normalized message is the synthetic.
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe(synthesizedAgentPrompt);

    // **Load-bearing assertion**: the synthetic carries the image
    // bytes. Without the bridge it would have content + no images.
    expect(last.images).toBeDefined();
    expect(last.images).toHaveLength(2);
    // Order preserved from parent's declared attachments.
    expect(last.images![0].mimeType).toBe('image/png');
    expect(last.images![1].mimeType).toBe('image/jpeg');

    // Parent and child entries no longer hold images (the bridge
    // detached them).
    const parentNm = result.messages.find((m) => m.content === rawCaption);
    expect(parentNm).toBeDefined();
    expect(parentNm!.images).toBeUndefined();
  });

  it('end-to-end: toPiMessages(buildCodexNormalizedMessages(...)) last user message has BOTH synthesized text AND image bytes', () => {
    // This is the PR E3a spec's "End-to-end batched upload" test —
    // pin the full pipeline from DB-message-shape to pi-ai-wire-shape.
    registerImageFile('e2e-img', { binarySize: 400, mimeType: 'image/png' });

    const rawCaption = 'describe please';
    const synthesizedAgentPrompt =
      `Maggie sent an image (kitten.png). You can view it at: /data/files/e2e-img.png\n\nTheir message: ${rawCaption}`;

    const dbMessages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        content: rawCaption,
        metadata: {
          attachments: [
            { fileId: 'e2e-img', filename: 'kitten.png', mimeType: 'image/png', contentType: 'image' },
          ],
        },
      }),
      makeMessage({
        id: 'child',
        content_type: 'image',
        content: '/api/files/e2e-img',
        metadata: { fileId: 'e2e-img', filename: 'kitten.png', mimeType: 'image/png' },
      }),
    ];

    const built = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: synthesizedAgentPrompt,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });
    const piMessages = toPiMessages(built.messages);

    const lastPi = piMessages[piMessages.length - 1];
    expect(lastPi.role).toBe('user');
    const content = (lastPi as { content: unknown }).content as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;

    // Mixed-content array, NOT a plain string — proves the image
    // attached and toPiMessages built the vision shape.
    expect(Array.isArray(content)).toBe(true);
    // Text comes first.
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe(synthesizedAgentPrompt);
    // Image bytes follow as pi-ai ImageContent (NOT OpenAI input_image).
    expect(content[1].type).toBe('image');
    expect(content[1].mimeType).toBe('image/png');
    expect(typeof content[1].data).toBe('string');
    expect(content[1].data!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCodexNormalizedMessages — fallback annotation
// ─────────────────────────────────────────────────────────────────────────

describe('buildCodexNormalizedMessages — fallback annotation', () => {
  it('appends fallback line to the synthetic when an over-cap image was dropped', () => {
    // 6MB binary file → exceeds 5MB per-image cap → fallback notice.
    registerImageFile('too-big', { binarySize: 6 * 1024 * 1024, mimeType: 'image/png' });

    const rawCaption = 'check this';
    const synthesized =
      `Maggie sent an image (huge.png). You can view it at: /data/files/too-big.png\n\nTheir message: ${rawCaption}`;

    const dbMessages: Message[] = [
      makeMessage({
        id: 'parent',
        content_type: 'text',
        content: rawCaption,
        metadata: {
          attachments: [
            { fileId: 'too-big', filename: 'huge.png', mimeType: 'image/png', contentType: 'image' },
          ],
        },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: synthesized,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    const last = result.messages[result.messages.length - 1];
    expect(last.images).toBeUndefined();
    expect(last.content).toContain(synthesized);
    expect(last.content).toContain('[image not attached');
    expect(last.content).toContain('huge.png');
    expect(last.content).toContain('per-image cap');
    expect(result.fallbackNotices).toHaveLength(1);
  });

  it('annotates the existing last message in place when no synthetic is appended', () => {
    // Telegram-shape: content matches verbatim. Over-cap image →
    // fallback line appends to the SAME DB-replayed user message
    // (no synthetic to attach it to).
    registerImageFile('tg-too-big', { binarySize: 6 * 1024 * 1024, mimeType: 'image/jpeg' });

    const content =
      `[Photo from Maggie] big one\nImage saved at: data/files/tg-too-big.jpg`;

    const dbMessages: Message[] = [
      makeMessage({
        id: 'tg',
        content_type: 'image',
        content,
        metadata: { fileId: 'tg-too-big', filename: 'huge.jpg', mimeType: 'image/jpeg', photoFileId: 'tg-too-big' },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: content,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    expect(result.appendedSynthetic).toBe(false);
    expect(result.messages).toHaveLength(1);
    const only = result.messages[0];
    expect(only.images).toBeUndefined();
    expect(only.content).toContain(content);
    expect(only.content).toContain('[image not attached');
    expect(only.content).toContain('huge.jpg');
  });

  it('does NOT annotate historical fallbacks — only current-turn ones', () => {
    // Historical over-cap image (parent-old) AND current-turn
    // over-cap image (parent-new). Only the current-turn fallback
    // should land in the synthetic's text; historical drops are low
    // signal once the conversation has moved past them.
    registerImageFile('old-big', { binarySize: 6 * 1024 * 1024 });
    registerImageFile('new-big', { binarySize: 6 * 1024 * 1024 });

    const newCaption = 'now look at this';
    const newSynthesized =
      `Maggie sent an image (new.png). You can view it at: /data/files/new-big.png\n\nTheir message: ${newCaption}`;

    const dbMessages: Message[] = [
      makeMessage({
        id: 'parent-old',
        created_at: '2026-05-19T00:00:00.000Z',
        content_type: 'text',
        content: 'check the first one',
        metadata: {
          attachments: [
            { fileId: 'old-big', filename: 'old.png', mimeType: 'image/png', contentType: 'image' },
          ],
        },
      }),
      makeMessage({
        id: 'assistant-reply',
        created_at: '2026-05-19T00:00:30.000Z',
        role: 'companion',
        content: 'I cannot see images that large, sorry.',
      }),
      makeMessage({
        id: 'parent-new',
        created_at: '2026-05-20T00:00:00.000Z',
        content_type: 'text',
        content: newCaption,
        metadata: {
          attachments: [
            { fileId: 'new-big', filename: 'new.png', mimeType: 'image/png', contentType: 'image' },
          ],
        },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: newSynthesized,
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    const last = result.messages[result.messages.length - 1];
    // Both fallback notices surface in fallbackNotices for diagnostics.
    expect(result.fallbackNotices).toHaveLength(2);
    // But only the current-turn one is woven into message text.
    expect(last.content).toContain('new.png');
    expect(last.content).not.toContain('old.png');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCodexNormalizedMessages — defensive synthetic without images
// ─────────────────────────────────────────────────────────────────────────

describe('buildCodexNormalizedMessages — synthetic without images (pre-E3a behavior preserved)', () => {
  it('appends the synthetic when no DB user-role tail exists', () => {
    // Autonomous / programmatic invocation: no user message in DB.
    const dbMessages: Message[] = [
      makeMessage({
        id: 'companion-1',
        role: 'companion',
        content: 'good morning',
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: 'pulse check',
      nowIso: '2026-05-20T08:00:00.000Z',
      isAutonomous: true,
    });

    expect(result.appendedSynthetic).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      role: 'user',
      content: 'pulse check',
      createdAt: '2026-05-20T08:00:00.000Z',
    });
    expect(result.messages[1].images).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildCodexNormalizedMessages — autonomous-mode bridge suppression
//
// Codex review of PR E3a/3 caught a real correctness bug: the original
// bridge moved images from the contiguous user-role tail onto ANY
// appended synthetic. That's correct for interactive batched uploads
// (the tail IS the in-flight turn). But if an autonomous Codex wake
// fires while the tail is an unanswered user-image message — Maggie
// sent a photo, went to sleep, autonomous pulse fires — the bridge
// would yank that image onto the pulse prompt. The wake text never
// references the image; attaching it would be a misleading hallucination
// trigger. Below tests pin the suppression.
// ─────────────────────────────────────────────────────────────────────────

describe('buildCodexNormalizedMessages — autonomous bridge suppression', () => {
  it('does NOT move tail user images onto an autonomous synthetic prompt', () => {
    // Tail: unanswered user image message (Maggie sent a photo,
    // went to sleep). Then autonomous wake fires with a pulse prompt
    // that has nothing to do with the photo.
    registerImageFile('unanswered-img', { binarySize: 1024, mimeType: 'image/png' });

    const dbMessages: Message[] = [
      makeMessage({
        id: 'user-photo',
        created_at: '2026-05-19T23:00:00.000Z',
        content_type: 'image',
        content: '[Photo from Maggie] late night\nImage saved at: data/files/unanswered-img.png',
        metadata: { fileId: 'unanswered-img', photoFileId: 'unanswered-img', mimeType: 'image/png' },
      }),
    ];

    const autonomousPrompt =
      "Maggie's probably waking up soon. Anything you'd like to say to her?";

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: autonomousPrompt,
      nowIso: '2026-05-20T07:00:00.000Z',
      isAutonomous: true,
    });

    // Synthetic was appended (pulse prompt doesn't match the DB tail).
    expect(result.appendedSynthetic).toBe(true);
    const synthetic = result.messages[result.messages.length - 1];
    expect(synthetic.content).toBe(autonomousPrompt);

    // **Load-bearing assertion**: the photo did NOT migrate onto the
    // autonomous synthetic. With `isAutonomous: false` the bridge
    // would have grabbed it; with `true` it stays on the DB-owner.
    expect(synthetic.images).toBeUndefined();

    // The original photo message still carries its image so Codex
    // sees it in proper chronological place if it scans history.
    const photoNm = result.messages.find((m) => m.createdAt === '2026-05-19T23:00:00.000Z');
    expect(photoNm).toBeDefined();
    expect(photoNm!.images).toHaveLength(1);
  });

  it('does NOT annotate autonomous synthetic with fallback notices from tail over-cap images', () => {
    // Tail: over-cap user image. Interactive mode would annotate the
    // synthetic with `[image not attached — ...]`. Autonomous mode
    // must not — the wake prompt isn't ABOUT the image.
    registerImageFile('too-big', { binarySize: 6 * 1024 * 1024, mimeType: 'image/png' });

    const dbMessages: Message[] = [
      makeMessage({
        id: 'user-big-photo',
        created_at: '2026-05-19T23:00:00.000Z',
        content_type: 'image',
        content: '[Photo from Maggie] huge file',
        metadata: { fileId: 'too-big', filename: 'huge.png', mimeType: 'image/png' },
      }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: 'pulse — say hi',
      nowIso: '2026-05-20T07:00:00.000Z',
      isAutonomous: true,
    });

    const synthetic = result.messages[result.messages.length - 1];
    expect(synthetic.content).toBe('pulse — say hi');
    expect(synthetic.content).not.toContain('[image not attached');

    // The fallback notice is still surfaced via the result for
    // diagnostics — the caller (agent.ts) logs it. We just don't
    // weave it into autonomous synthetic text.
    expect(result.fallbackNotices).toHaveLength(1);
    expect(result.fallbackNotices[0].fileId).toBe('too-big');
  });

  it('interactive mode still bridges in the same scenario (regression guard)', () => {
    // Symmetric to the autonomous test above: same DB shape, but
    // isAutonomous: false. The bridge should fire — confirms the
    // suppression is conditional, not a blanket disable.
    registerImageFile('unanswered-img', { binarySize: 1024, mimeType: 'image/png' });

    const dbMessages: Message[] = [
      makeMessage({
        id: 'user-photo',
        created_at: '2026-05-19T23:00:00.000Z',
        content_type: 'image',
        content: '[Photo from Maggie] check this',
        metadata: { fileId: 'unanswered-img', photoFileId: 'unanswered-img', mimeType: 'image/png' },
      }),
    ];

    // Caller-synthesized prompt (e.g. a prosody-injected version) —
    // doesn't match DB content verbatim, so synthetic appends.
    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: '[Voice tone - calm: 0.8]\n[Photo from Maggie] check this',
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    expect(result.appendedSynthetic).toBe(true);
    const synthetic = result.messages[result.messages.length - 1];
    // Interactive: bridge fires, image rides onto the synthetic.
    expect(synthetic.images).toHaveLength(1);
  });

  it('does NOT append synthetic when last user content matches verbatim', () => {
    const dbMessages: Message[] = [
      makeMessage({ id: 'm', content: 'hello' }),
    ];

    const result = buildCodexNormalizedMessages({
      dbMessages,
      currentContent: 'hello',
      nowIso: '2026-05-20T00:01:00.000Z',
      isAutonomous: false,
    });

    expect(result.appendedSynthetic).toBe(false);
    expect(result.messages).toHaveLength(1);
  });
});
