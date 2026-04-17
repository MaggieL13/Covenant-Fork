<script lang="ts">
  import type { Message, CommandRegistryEntry, Sticker } from '@resonant/shared';
  import { getCompanionName } from '$lib/stores/settings.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import { getCommandRegistry, sendCommand, send } from '$lib/stores/websocket.svelte';
  import { getStickerPacks, getAllStickers } from '$lib/stores/stickers.svelte';
  import { apiFetch } from '$lib/utils/api';
  import ReplyBanner from './message-input/ReplyBanner.svelte';
  import AttachmentTray from './message-input/AttachmentTray.svelte';
  import CanvasRefTray from './message-input/CanvasRefTray.svelte';
  import ComposerActions from './message-input/ComposerActions.svelte';
  import ComposerTextarea from './message-input/ComposerTextarea.svelte';

  let companionName = $derived(getCompanionName());

  interface FileUploadResult {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
    contentType: 'image' | 'audio' | 'file';
    url: string;
  }

  let {
    replyTo = null,
    isStreaming = false,
    activeThreadId = null,
    onbatchsend,
    oncancelreply,
    onstop,
  } = $props<{
    replyTo?: Message | null;
    isStreaming?: boolean;
    activeThreadId?: string | null;
    onbatchsend?: (text: string, files: FileUploadResult[], prosody?: Record<string, number>) => void;
    oncancelreply?: () => void;
    onstop?: () => void;
  }>();

  let getTextarea = $state<() => HTMLTextAreaElement | null>(() => null);
  let getFileInput = $state<() => HTMLInputElement | null>(() => null);
  let content = $state('');
  let uploading = $state(false);
  let uploadError = $state<string | null>(null);
  let pendingAttachments = $state<FileUploadResult[]>([]);
  let pendingCanvasRefs = $state<Array<{ canvasId: string; title: string }>>([]);
  let pendingProsody = $state<Record<string, number> | null>(null);

  let showStickerPicker = $state(false);
  let hasStickerPacks = $derived(getStickerPacks().length > 0);
  let pendingSticker = $state<Sticker | null>(null);

  let showCommandPalette = $state(false);
  let commandFilter = $state('');
  let paletteRef = $state<CommandPalette | undefined>();
  let commandRegistry = $derived(getCommandRegistry());

  let canSend = $derived(
    content.trim().length > 0 ||
    pendingAttachments.length > 0 ||
    pendingCanvasRefs.length > 0 ||
    pendingSticker !== null
  );

  function autoResize() {
    const textarea = getTextarea();
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }

  let stickerQuery = $state('');
  let stickerColonPos = $state(-1);
  let showStickerAutocomplete = $state(false);
  let stickerSelectedIndex = $state(0);

  let stickerAutocompleteList = $derived(() => {
    if (!stickerQuery) return [];
    const q = stickerQuery.toLowerCase();
    const packs = getStickerPacks();
    const stickers = getAllStickers();
    const results: Array<{ ref: string; url: string; name: string; packName: string }> = [];

    for (const s of stickers) {
      const pack = packs.find((candidate) => candidate.id === s.pack_id);
      if (!pack) continue;
      const ref = `:${pack.name.toLowerCase()}_${s.name}:`;
      if (ref.includes(q) || s.name.toLowerCase().includes(q)) {
        results.push({ ref, url: s.url, name: s.name, packName: pack.name });
      }
    }

    return results.slice(0, 8);
  });

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    content = target.value;
    autoResize();

    if (content.startsWith('/') && !content.includes('\n')) {
      showCommandPalette = true;
      commandFilter = content.slice(1).split(' ')[0];
    } else {
      showCommandPalette = false;
      commandFilter = '';
    }

    detectStickerAutocomplete();
  }

  function detectStickerAutocomplete() {
    const textarea = getTextarea();
    if (!textarea) {
      showStickerAutocomplete = false;
      return;
    }

    const cursorPos = textarea.selectionStart;
    const textBefore = content.slice(0, cursorPos);
    const lastColon = textBefore.lastIndexOf(':');
    if (lastColon === -1) {
      showStickerAutocomplete = false;
      return;
    }

    const afterColon = textBefore.slice(lastColon + 1);
    if (afterColon.includes(':') || afterColon.includes(' ') || afterColon.includes('\n')) {
      showStickerAutocomplete = false;
      return;
    }

    if (afterColon.length < 1) {
      showStickerAutocomplete = false;
      return;
    }

    stickerQuery = afterColon;
    stickerColonPos = lastColon;
    stickerSelectedIndex = 0;
    showStickerAutocomplete = stickerAutocompleteList().length > 0;
  }

  function insertStickerRef(ref: string) {
    const textarea = getTextarea();
    const before = content.slice(0, stickerColonPos);
    const cursorPos = textarea?.selectionStart || content.length;
    const after = content.slice(cursorPos);
    content = before + ref + ' ' + after;
    showStickerAutocomplete = false;
    stickerQuery = '';
    textarea?.focus();

    requestAnimationFrame(() => {
      const activeTextarea = getTextarea();
      if (activeTextarea) {
        const newPos = before.length + ref.length + 1;
        activeTextarea.selectionStart = newPos;
        activeTextarea.selectionEnd = newPos;
      }
    });
  }

  function handleCommandSelect(command: CommandRegistryEntry) {
    showCommandPalette = false;

    if (command.clientOnly) {
      executeClientCommand(command.name);
      resetInput();
      return;
    }

    if (command.args) {
      content = `/${command.name} `;
      getTextarea()?.focus();
      return;
    }

    sendCommand(command.name, undefined, activeThreadId ?? undefined);
    resetInput();
  }

  function executeClientCommand(name: string) {
    switch (name) {
      case 'help':
        showCommandPalette = true;
        commandFilter = '';
        content = '/';
        return;
      case 'stop':
        onstop?.();
        break;
    }
  }

  function handleSend() {
    if (!canSend) return;

    const trimmed = content.trim();

    // ORDER: slash-command routing must finish before regular send logic so command text does not leak into the normal message path.
    if (trimmed.startsWith('/')) {
      const spaceIndex = trimmed.indexOf(' ');
      const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
      const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim() || undefined;

      const cmd = commandRegistry.find((candidate) => candidate.name === name);
      if (cmd) {
        if (cmd.clientOnly) {
          executeClientCommand(name);
        } else {
          sendCommand(name, args, activeThreadId ?? undefined);
        }
        resetInput();
        return;
      }
    }

    // ORDER: queued stickers send before the text/file batch so the existing sticker-first composer behavior stays intact.
    if (pendingSticker && activeThreadId) {
      send({
        type: 'message',
        threadId: activeThreadId,
        content: pendingSticker.url,
        contentType: 'sticker',
        metadata: {
          stickerId: pendingSticker.id,
          packId: pendingSticker.pack_id,
          stickerName: pendingSticker.name,
        },
      });
    }

    const files = [...pendingAttachments];
    let finalContent = trimmed;
    if (pendingCanvasRefs.length > 0) {
      const refs = pendingCanvasRefs.map((ref) => `<<canvas:${ref.canvasId}:${ref.title}>>`).join(' ');
      finalContent = finalContent ? `${finalContent}\n${refs}` : refs;
    }
    if (finalContent || files.length > 0) {
      onbatchsend?.(finalContent, files, pendingProsody ?? undefined);
    }
    // ORDER: reset only after the successful send path finishes so pending text, files, stickers, and canvas refs are still available to the active send branch.
    resetInput();
  }

  function resetInput() {
    pendingAttachments = [];
    pendingCanvasRefs = [];
    pendingSticker = null;
    content = '';
    pendingProsody = null;
    showCommandPalette = false;
    showStickerAutocomplete = false;
    stickerQuery = '';
    commandFilter = '';

    const textarea = getTextarea();
    if (textarea) textarea.style.height = 'auto';
  }

  function removeAttachment(index: number) {
    pendingAttachments = pendingAttachments.filter((_, i) => i !== index);
  }

  export function attachCanvasRef(canvasId: string, title: string) {
    if (pendingCanvasRefs.some((ref) => ref.canvasId === canvasId)) return;
    // ORDER: external canvas refs must land in state before focus returns so the composer immediately renders the new chip on the next pass.
    pendingCanvasRefs = [...pendingCanvasRefs, { canvasId, title }];
    getTextarea()?.focus();
  }

  function removeCanvasRef(index: number) {
    pendingCanvasRefs = pendingCanvasRefs.filter((_, i) => i !== index);
  }

  function handleStickerSelect(sticker: Sticker) {
    pendingSticker = sticker;
    showStickerPicker = false;
    getTextarea()?.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    // ORDER: command palette handling must win before normal Enter-send behavior so palette selection keeps consuming its own keyboard flow.
    if (showCommandPalette && paletteRef) {
      const handled = paletteRef.handleKey(event);
      if (handled) return;
    }

    // ORDER: sticker autocomplete selection/navigation must resolve before normal Enter-send behavior so choosing a sticker ref never sends the draft early.
    if (showStickerAutocomplete) {
      const list = stickerAutocompleteList();
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        stickerSelectedIndex = (stickerSelectedIndex + 1) % list.length;
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        stickerSelectedIndex = (stickerSelectedIndex - 1 + list.length) % list.length;
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && list.length > 0) {
        event.preventDefault();
        insertStickerRef(list[stickerSelectedIndex].ref);
        return;
      }
      if (event.key === 'Escape') {
        showStickerAutocomplete = false;
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }

  async function uploadFile(file: File) {
    uploading = true;
    uploadError = null;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiFetch('/api/files', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error || `Upload failed (${response.status})`);
      }

      const result: FileUploadResult = await response.json();
      pendingAttachments = [...pendingAttachments, result];
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      uploadError = message;
      setTimeout(() => {
        uploadError = null;
      }, 5000);
    } finally {
      uploading = false;
    }
  }

  function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      for (const file of files) {
        uploadFile(file);
      }
    }
    input.value = '';
  }

  function handlePaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) uploadFile(file);
        return;
      }
    }
  }

  function handleTranscript(text: string, prosody?: Record<string, number> | null) {
    content = text;
    pendingProsody = prosody ?? null;
    getTextarea()?.focus();
  }

  function handleCancelReply() {
    oncancelreply?.();
  }

  // ORDER: the parent must receive fresh getter functions after child refs bind so focus, resize, upload-click, and cursor logic keep targeting the live DOM nodes.
  function registerTextareaRefs(refs: { getTextarea: () => HTMLTextAreaElement | null }) {
    getTextarea = refs.getTextarea;
  }

  function registerFileInputRefs(refs: { getFileInput: () => HTMLInputElement | null }) {
    getFileInput = refs.getFileInput;
  }

  function openFilePicker() {
    getFileInput()?.click();
  }

  $effect(() => {
    // ORDER: pending prosody only clears once the draft is truly empty, then autoresize runs against the settled content state.
    if (content === '' && pendingProsody) {
      pendingProsody = null;
    }
    autoResize();
  });
</script>

<div class="message-input-container">
  <ReplyBanner replyTo={replyTo} companionName={companionName} oncancel={handleCancelReply} />

  {#if uploadError}
    <div class="upload-error">{uploadError}</div>
  {/if}

  <AttachmentTray
    pendingSticker={pendingSticker}
    pendingAttachments={pendingAttachments}
    onremoveattachment={removeAttachment}
    onclearsticker={() => {
      pendingSticker = null;
    }}
  />

  <CanvasRefTray pendingCanvasRefs={pendingCanvasRefs} onremove={removeCanvasRef} />

  {#if showCommandPalette}
    <CommandPalette
      bind:this={paletteRef}
      filter={commandFilter}
      commands={commandRegistry}
      onselect={handleCommandSelect}
      onclose={() => {
        showCommandPalette = false;
      }}
    />
  {/if}

  <div class="input-bar">
    <ComposerActions
      isStreaming={isStreaming}
      uploading={uploading}
      hasStickerPacks={hasStickerPacks}
      showStickerPicker={showStickerPicker}
      canSend={canSend}
      onopenfilepicker={openFilePicker}
      onstickerbuttontoggle={() => {
        showStickerPicker = !showStickerPicker;
      }}
      onstickerselect={handleStickerSelect}
      onstickerclose={() => {
        showStickerPicker = false;
      }}
      onsend={handleSend}
      onstop={onstop}
      ontranscript={handleTranscript}
      onfilechange={handleFileSelect}
      onregisterrefs={registerFileInputRefs}
    />

    <ComposerTextarea
      content={content}
      showStickerAutocomplete={showStickerAutocomplete}
      stickerAutocompleteItems={stickerAutocompleteList()}
      stickerSelectedIndex={stickerSelectedIndex}
      oninput={handleInput}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      onselectstickerref={insertStickerRef}
      onhoverstickerindex={(index) => {
        stickerSelectedIndex = index;
      }}
      onregisterrefs={registerTextareaRefs}
    />
  </div>

  <div class="composer-hint">
    <span>/ for commands</span>
    <span>Enter to send</span>
    <span>Shift+Enter for a newline</span>
  </div>
</div>

<style>
  .message-input-container {
    display: flex;
    flex-direction: column;
    background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg-primary) 72%, transparent));
    backdrop-filter: blur(16px);
    max-width: 54rem;
    margin: 0 auto;
    padding: 0 1rem 1.35rem;
    position: relative;
    width: 100%;
  }

  .upload-error {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    color: var(--error, #ef4444);
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-bottom: none;
  }

  .input-bar {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    padding: 0.65rem 0.7rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 1.5rem;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  }

  .input-bar:focus-within {
    border-color: rgba(155, 114, 207, 0.35);
    box-shadow: 0 0 0 1px rgba(155, 114, 207, 0.18), 0 16px 40px rgba(0, 0, 0, 0.18);
  }

  .composer-hint {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    justify-content: center;
    padding-top: 0.6rem;
    color: var(--text-muted);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
  }

  @media (max-width: 768px) {
    .input-bar {
      padding: 0.55rem 0.6rem;
      gap: 0.375rem;
      border-radius: 1.25rem;
    }

    .composer-hint {
      justify-content: flex-start;
      gap: 0.35rem 0.75rem;
    }
  }
</style>
