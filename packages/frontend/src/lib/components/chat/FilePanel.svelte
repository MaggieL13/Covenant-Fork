<script lang="ts">
  import type { Message } from '@resonant/shared';
  import FileThumbnail from '$lib/components/FileThumbnail.svelte';

  let {
    open = false,
    messages,
    onclose,
  } = $props<{
    open: boolean;
    messages: Message[];
    onclose?: () => void;
  }>();

  interface FileRow {
    messageId: string;
    fileId: string;
    filename: string;
    size: number;
    mimeType: string;
    contentType: 'image' | 'audio' | 'file';
    role: 'user' | 'companion' | 'system';
    createdAt: string;
    url: string;
  }

  // Resolve a fileId from metadata, falling back to platform-specific
  // legacy keys so historical Telegram voice/photo messages (which
  // wrote voiceFileId / photoFileId before the storage layer was
  // normalized) still surface in the Files panel.
  function extractFileId(meta: Record<string, unknown>): string | null {
    const candidates = ['fileId', 'voiceFileId', 'photoFileId'];
    for (const key of candidates) {
      const v = meta[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return null;
  }

  // Filter messages for attachment-bearing types. Thread scope is
  // implicit — this component receives only the active thread's
  // messages from the page. Newest first so recent attachments are
  // one scroll-to-top away.
  //
  // NOTE: `text` content_type is included here only when metadata
  // carries a fileId (or its platform-specific aliases). Older
  // Telegram photos pre-normalization stored as `text` with a
  // photoFileId — the fallback covers them.
  const fileRows = $derived.by<FileRow[]>(() => {
    const rows: FileRow[] = [];
    for (const m of messages as Message[]) {
      const meta = (m.metadata ?? {}) as Record<string, unknown>;
      const fileId = extractFileId(meta);
      if (!fileId) continue;

      const isAttachmentType = ['image', 'audio', 'file'].includes(m.content_type);
      const isLegacyTextWithFile =
        m.content_type === 'text' && (meta.photoFileId || meta.voiceFileId);
      if (!isAttachmentType && !isLegacyTextWithFile) continue;

      const filename = typeof meta.filename === 'string' ? meta.filename : fileId;
      const size = typeof meta.size === 'number' ? meta.size : 0;
      const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : '';

      // Legacy text-with-photo messages should render as image tiles.
      let contentType: 'image' | 'audio' | 'file' = 'file';
      if (m.content_type === 'image' || meta.photoFileId) contentType = 'image';
      else if (m.content_type === 'audio' || meta.voiceFileId) contentType = 'audio';
      else if (m.content_type === 'file') contentType = 'file';

      rows.push({
        messageId: m.id,
        fileId,
        filename,
        size,
        mimeType,
        contentType,
        role: m.role,
        createdAt: m.created_at,
        url: `/api/files/${fileId}`,
      });
    }
    return rows.reverse(); // newest first
  });

  function roleLabel(role: 'user' | 'companion' | 'system'): string {
    if (role === 'user') return 'You';
    if (role === 'companion') return 'Companion';
    return 'System';
  }

  function formatTime(iso: string): string {
    // Browser-local time; matches the Library's approach. Frontend has
    // no sovereignty layer — browsers update ICU more often than Node,
    // so toLocaleTimeString is acceptable here.
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function formatDateShort(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function handleOpen(row: FileRow): void {
    // For the MVP, open the file in a new tab via /api/files/<id>.
    // Chip #16 will replace this with a preview overlay.
    window.open(row.url, '_blank', 'noopener');
  }

  // Keyboard: Escape closes the drawer when it has focus.
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onclose?.();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <button class="file-overlay" onclick={onclose} aria-label="Close files panel"></button>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="file-sheet"
    role="dialog"
    aria-modal="true"
    aria-label="Files in this thread"
    onkeydown={handleKeydown}
    tabindex="-1"
  >
    <div class="file-sheet-card">
      <header class="file-panel-header">
        <h2 class="file-panel-title">Files</h2>
        <button class="close-btn" onclick={onclose} aria-label="Close">&times;</button>
      </header>

      {#if fileRows.length === 0}
        <div class="empty-state">
          <p class="empty-title">No files yet.</p>
          <p class="empty-hint">Attach something in chat to get started.</p>
        </div>
      {:else}
        <div class="file-grid" role="list">
          {#each fileRows as row (row.messageId)}
            <div class="file-grid-cell" role="listitem">
              <FileThumbnail
                fileId={row.fileId}
                filename={row.filename}
                size={row.size}
                mimeType={row.mimeType}
                contentType={row.contentType}
                onclick={() => handleOpen(row)}
              />
              <span class="file-grid-sub">
                {roleLabel(row.role)} · {formatDateShort(row.createdAt)} · {formatTime(row.createdAt)}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .file-overlay {
    position: fixed;
    inset: 0;
    z-index: 320;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(10px);
    border: none;
    cursor: pointer;
  }

  .file-sheet {
    position: fixed;
    top: 1rem;
    right: 1rem;
    bottom: 1rem;
    width: min(28rem, calc(100vw - 2rem));
    z-index: 330;
    pointer-events: none;
    outline: none;
  }

  .file-sheet-card {
    width: 100%;
    height: 100%;
    pointer-events: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-surface);
    backdrop-filter: blur(20px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    animation: fpModalRise 0.2s ease-out;
  }

  @keyframes fpModalRise {
    from { opacity: 0; transform: translateY(0.5rem) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .file-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.125rem 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .file-panel-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    font-size: 1.25rem;
    line-height: 1;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    transition: color 0.15s, background 0.15s;
  }

  .close-btn:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    text-align: center;
  }

  .empty-title {
    margin: 0 0 0.375rem;
    font-size: 0.9375rem;
    color: var(--text-primary);
  }

  .empty-hint {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--text-secondary);
  }

  .file-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.875rem;
    padding: 0.875rem;
    overflow-y: auto;
    flex: 1;
  }

  .file-grid-cell {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .file-grid-sub {
    font-size: 0.6875rem;
    color: var(--text-muted);
    padding: 0 0.25rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 768px) {
    .file-sheet {
      inset: 0;
      width: 100%;
    }

    .file-sheet-card {
      border-radius: 0;
      border: none;
    }
  }
</style>
