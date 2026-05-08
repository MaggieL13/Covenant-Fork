<script lang="ts">
  import { renderMarkdown } from '$lib/utils/markdown';

  let { contentType, content, metadata = null, alignRight = false } = $props<{
    contentType: string;
    content: string;
    metadata?: Record<string, unknown> | null;
    alignRight?: boolean;
  }>();

  let showLightbox = $state(false);

  let audioEl: HTMLAudioElement | null = $state(null);
  let audioPlaying = $state(false);
  let audioDuration = $state(0);
  let audioCurrentTime = $state(0);

  const stickerName = $derived(typeof metadata?.['stickerName'] === 'string' ? metadata['stickerName'] : null);
  const packName = $derived(typeof metadata?.['packName'] === 'string' ? metadata['packName'] : null);
  const transcript = $derived(typeof metadata?.['transcript'] === 'string' ? metadata['transcript'] : null);
  const filename = $derived(typeof metadata?.['filename'] === 'string' ? metadata['filename'] : 'File');
  const size = $derived(typeof metadata?.['size'] === 'number' ? metadata['size'] : null);

  // File preview state — click on a previewable file card opens a
  // modal with PDF iframe or fetched-text content. Pattern lifted
  // from Sydney's `3f43901` in thornvale-resonant; adapted to our
  // `content` prop (vs her `src`) and existing CSS variable names.
  // Closes chip #16.
  const PREVIEWABLE_EXTS = ['pdf', 'txt', 'md', 'json', 'csv', 'log'] as const;
  const PREVIEW_MAX_BYTES = 1 * 1024 * 1024; // 1MB cap on text fetch
  let showFilePreview = $state(false);
  let previewText = $state<string | null>(null);
  let previewError = $state<string | null>(null);
  let previewLoading = $state(false);

  const fileExt = $derived(filename.toLowerCase().split('.').pop() || '');
  const isPreviewable = $derived(
    contentType === 'file' && (PREVIEWABLE_EXTS as readonly string[]).includes(fileExt),
  );

  async function openFilePreview() {
    showFilePreview = true;
    if (fileExt === 'pdf') return; // iframe handles fetch itself
    if (previewText !== null) return; // cached for re-open within session
    previewLoading = true;
    previewError = null;
    try {
      // Two-layer cap so a multi-megabyte log file never gets fully
      // materialized in browser memory just to be sliced and discarded:
      //
      // 1. HTTP Range header asks the server for only the first 1MB.
      //    Express's res.sendFile() honors Range natively (returns 206
      //    Partial Content for the byte range, or 200 with full body if
      //    the route happens to not support Range — we don't get stuck
      //    either way).
      // 2. Streaming reader caps client-side at 1MB regardless of how
      //    much the server actually sent. If a server didn't honor Range
      //    and returned a huge body, we cancel the read after 1MB and
      //    let the rest of the bytes go to the network garbage collector
      //    instead of decoding them into a JS string.
      const res = await fetch(content, {
        credentials: 'include',
        headers: { Range: `bytes=0-${PREVIEW_MAX_BYTES - 1}` },
      });
      // 206 Partial Content (Range honored) and 200 OK both fine; only
      // bail on real failures.
      if (!res.ok && res.status !== 206) {
        previewError = `Couldn't load preview (${res.status})`;
        return;
      }
      if (!res.body) {
        previewError = 'Preview unavailable (no response body)';
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const chunks: string[] = [];
      let collected = 0;
      let truncated = false;
      let reachedEnd = false;
      while (collected < PREVIEW_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          reachedEnd = true;
          break;
        }
        if (collected + value.length > PREVIEW_MAX_BYTES) {
          const remaining = PREVIEW_MAX_BYTES - collected;
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: false }));
          truncated = true;
          await reader.cancel();
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
        collected += value.length;
      }
      // Exact-boundary edge case: if a chunk landed precisely on
      // PREVIEW_MAX_BYTES, the loop exited via the while condition
      // (collected === MAX) without hitting the truncation branch and
      // without observing a `done` read. We don't yet know whether
      // more data is waiting — could be a file that's *exactly* 1MB
      // (fully previewed, no truncation note needed) or a much bigger
      // file whose chunks just happened to align with our cap.
      //
      // One extra read distinguishes the two:
      // - `done: true` → file was exactly at cap, complete preview
      // - `done: false` → there's more data; mark truncated and cancel
      //   so a non-Range-respecting server doesn't keep streaming in
      //   the background.
      if (!reachedEnd && collected >= PREVIEW_MAX_BYTES) {
        const peek = await reader.read();
        if (peek.done) {
          reachedEnd = true;
        } else {
          truncated = true;
          await reader.cancel();
        }
      }
      // Flush the decoder's internal buffer (handles partial multibyte
      // sequences from the last chunk).
      chunks.push(decoder.decode());
      previewText = chunks.join('') + (truncated
        ? '\n\n… (preview truncated — download for full file)'
        : '');
    } catch (err) {
      previewError = err instanceof Error ? err.message : 'Failed to load preview';
    } finally {
      previewLoading = false;
    }
  }

  function closeFilePreview() {
    showFilePreview = false;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function toggleAudio() {
    if (!audioEl) return;
    if (audioPlaying) {
      audioEl.pause();
    } else {
      audioEl.play();
    }
  }

  function onAudioTimeUpdate() {
    if (audioEl) audioCurrentTime = audioEl.currentTime;
  }

  function onAudioLoaded() {
    if (audioEl && isFinite(audioEl.duration)) audioDuration = audioEl.duration;
  }

  function onAudioEnded() {
    audioPlaying = false;
    audioCurrentTime = 0;
  }

  function onAudioSeek(e: MouseEvent) {
    if (!audioEl || !audioDuration) return;
    const bar = e.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEl.currentTime = pct * audioDuration;
  }

  function formatAudioTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
</script>

{#if contentType === 'sticker'}
  <div class="sticker-message" class:user={alignRight}>
    <img src={content} alt={stickerName ? `:${packName ?? 'pack'}_${stickerName}:` : 'sticker'} class="standalone-sticker" />
  </div>
{:else if contentType === 'image'}
  <div class="media-image">
    <button class="image-button" onclick={() => showLightbox = true} aria-label="View full size">
      <img src={content} alt="" loading="lazy" />
    </button>
  </div>
  {#if showLightbox}
    <div class="lightbox" role="dialog" aria-label="Full size image">
      <button class="lightbox-close" onclick={() => showLightbox = false} aria-label="Close">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <button class="lightbox-backdrop" onclick={() => showLightbox = false} aria-label="Close lightbox"></button>
      <img src={content} alt="" />
    </div>
  {/if}
{:else if contentType === 'audio'}
  <div class="media-audio">
    <audio
      bind:this={audioEl}
      preload="metadata"
      src={content}
      ontimeupdate={onAudioTimeUpdate}
      onloadedmetadata={onAudioLoaded}
      ondurationchange={onAudioLoaded}
      onplay={() => audioPlaying = true}
      onpause={() => audioPlaying = false}
      onended={onAudioEnded}
    >
      <track kind="captions" />
    </audio>
    <div class="audio-player">
      <button class="audio-play-btn" onclick={toggleAudio} aria-label={audioPlaying ? 'Pause' : 'Play'}>
        {#if audioPlaying}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        {:else}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
        {/if}
      </button>
      <span class="audio-time">{formatAudioTime(audioCurrentTime)}</span>
      <button class="audio-bar" onclick={onAudioSeek} aria-label="Seek">
        <div class="audio-track">
          <div class="audio-progress" style:width="{audioDuration ? (audioCurrentTime / audioDuration) * 100 : 0}%"></div>
        </div>
      </button>
      <span class="audio-time">{formatAudioTime(audioDuration)}</span>
    </div>
    {#if transcript}
      <div class="audio-transcript">{transcript}</div>
    {/if}
  </div>
{:else if contentType === 'file'}
  <div class="media-file">
    <div class="file-card">
      {#if isPreviewable}
        <button class="file-card-body" onclick={openFilePreview} title="Click to preview" aria-label={`Preview ${filename}`}>
          <svg class="file-card-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
          </svg>
          <div class="file-info">
            <span class="file-name">{filename}</span>
            {#if size}
              <span class="file-size">{formatFileSize(size)}</span>
            {/if}
          </div>
        </button>
      {:else}
        <div class="file-card-body no-preview">
          <svg class="file-card-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/>
          </svg>
          <div class="file-info">
            <span class="file-name">{filename}</span>
            {#if size}
              <span class="file-size">{formatFileSize(size)}</span>
            {/if}
          </div>
        </div>
      {/if}
      <a class="file-download" href={content} download={filename} title="Download" aria-label={`Download ${filename}`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </a>
    </div>
  </div>
  {#if showFilePreview}
    <div class="lightbox" role="dialog" aria-label={`Preview of ${filename}`}>
      <button class="lightbox-close" onclick={closeFilePreview} aria-label="Close preview">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
      <button class="lightbox-backdrop" onclick={closeFilePreview} aria-label="Close preview"></button>
      <div class="preview-shell">
        <div class="preview-title">{filename}</div>
        <div class="preview-body">
          {#if fileExt === 'pdf'}
            <iframe class="preview-pdf" src={content} title={filename}></iframe>
          {:else if previewLoading}
            <div class="preview-status">Loading…</div>
          {:else if previewError}
            <div class="preview-status error">{previewError}</div>
          {:else if previewText !== null}
            {#if fileExt === 'md'}
              <div class="preview-markdown">{@html renderMarkdown(previewText)}</div>
            {:else}
              <pre class="preview-text">{previewText}</pre>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  {/if}
{/if}

<style>
  .sticker-message {
    display: flex;
    padding: 0;
  }

  .sticker-message.user {
    justify-content: flex-end;
  }

  .standalone-sticker {
    max-width: 180px;
    max-height: 180px;
    border-radius: 0.5rem;
    transition: transform 0.1s ease;
  }

  .standalone-sticker:hover {
    transform: scale(1.05);
  }

  .media-image {
    margin: 0.25rem 0;
  }

  .image-button {
    display: block;
    padding: 0;
    background: none;
    cursor: pointer;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .media-image img {
    max-width: 100%;
    max-height: 400px;
    border-radius: var(--radius-sm);
    display: block;
    object-fit: contain;
  }

  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }

  .lightbox-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
  }

  .lightbox-close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    z-index: 1001;
    padding: 0.5rem;
    color: white;
    background: var(--bg-active);
    border-radius: 50%;
    transition: background 0.2s;
  }

  .lightbox-close:hover {
    background: var(--bg-hover);
  }

  .lightbox img {
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    z-index: 1001;
    border-radius: var(--radius-sm);
  }

  .media-audio {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.25rem 0;
  }

  .media-audio audio {
    display: none;
  }

  .audio-player {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.25rem;
    min-width: 220px;
    max-width: 320px;
  }

  .audio-play-btn {
    width: 2rem;
    height: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--accent);
    color: var(--bg-primary);
    flex-shrink: 0;
    transition: all var(--transition);
    cursor: pointer;
  }

  .audio-play-btn:hover {
    background: var(--accent-hover);
  }

  .audio-time {
    font-size: 0.6875rem;
    font-family: var(--font-mono);
    color: var(--text-secondary);
    min-width: 2.25rem;
    text-align: center;
    flex-shrink: 0;
  }

  .audio-bar {
    flex: 1;
    padding: 0.5rem 0;
    cursor: pointer;
    background: none;
  }

  .audio-track {
    height: 3px;
    background: var(--border-hover);
    border-radius: 2px;
    position: relative;
    overflow: hidden;
  }

  .audio-progress {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.1s linear;
  }

  .audio-bar:hover .audio-track {
    height: 4px;
  }

  .audio-bar:hover .audio-progress {
    background: var(--accent-hover);
  }

  .audio-transcript {
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .media-file {
    margin: 0.25rem 0;
  }

  .file-card {
    display: flex;
    align-items: stretch;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }

  .file-card-body {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    transition: background 0.2s;
    min-width: 0;
  }

  .file-card-body:hover {
    background: var(--bg-hover);
  }

  /* Non-previewable file types: render as a static row, no hover/click. */
  .file-card-body.no-preview {
    cursor: default;
  }

  .file-card-body.no-preview:hover {
    background: transparent;
  }

  .file-card-icon {
    flex-shrink: 0;
    color: var(--accent);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    overflow: hidden;
    min-width: 0;
  }

  .file-name {
    font-size: 0.875rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Standalone download arrow on the right side of the file card. Always
     present, even on previewable types — gives users a one-click way to
     pull the file without opening the preview first. */
  .file-download {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    color: var(--text-muted);
    flex-shrink: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.05);
    transition: color var(--transition), background var(--transition);
  }

  .file-download:hover {
    color: var(--accent);
    background: var(--bg-hover);
  }

  /* File preview modal — reuses .lightbox shell from the image case so
     files and images feel unified. PDF uses an iframe; text/code render
     in a <pre>; markdown gets the standard renderMarkdown pipeline. */
  .preview-shell {
    position: relative;
    z-index: 1001;
    width: min(960px, 92vw);
    height: min(80vh, 720px);
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary, #1a1a1a);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.6);
  }

  .preview-title {
    padding: 0.75rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--text-secondary);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-body {
    flex: 1;
    overflow: auto;
    background: var(--bg-primary, #111);
  }

  .preview-pdf {
    width: 100%;
    height: 100%;
    border: none;
    background: white;
  }

  .preview-text {
    margin: 0;
    padding: 1rem;
    font-family: var(--font-mono, monospace);
    font-size: 0.8125rem;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .preview-markdown {
    padding: 1.25rem 1.5rem;
    font-size: 0.9375rem;
    line-height: 1.6;
    color: var(--text-primary);
  }
  .preview-markdown :global(h1),
  .preview-markdown :global(h2),
  .preview-markdown :global(h3) {
    margin-top: 1em;
    margin-bottom: 0.5em;
  }
  .preview-markdown :global(p) {
    margin: 0.6em 0;
  }
  .preview-markdown :global(code) {
    font-family: var(--font-mono, monospace);
    font-size: 0.875em;
    background: rgba(255, 255, 255, 0.06);
    padding: 0.1em 0.35em;
    border-radius: 3px;
  }
  .preview-markdown :global(pre) {
    background: rgba(0, 0, 0, 0.3);
    padding: 0.75rem 1rem;
    border-radius: var(--radius-sm);
    overflow-x: auto;
  }

  .preview-status {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
  .preview-status.error {
    color: var(--danger, #d44);
  }

  @media (max-width: 768px) {
    .preview-shell {
      width: 100vw;
      height: 100vh;
      border-radius: 0;
    }
  }

  @media (max-width: 768px) {
    .lightbox {
      padding: 0;
    }

    .lightbox-close {
      top: max(env(safe-area-inset-top, 0.5rem), 0.75rem);
      right: 0.75rem;
      padding: 0.75rem;
      background: rgba(0, 0, 0, 0.6);
      z-index: 1002;
    }

    .lightbox img {
      max-width: 100vw;
      max-height: 100vh;
      border-radius: 0;
    }
  }
</style>
