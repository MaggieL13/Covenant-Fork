<script lang="ts">
  import { formatSize } from '$lib/utils/format';

  let {
    fileId,
    filename,
    size,
    mimeType = '',
    contentType,
    onclick,
  } = $props<{
    fileId: string;
    filename: string;
    size: number;
    mimeType?: string;
    contentType: 'image' | 'audio' | 'file';
    onclick?: () => void;
  }>();

  const url = $derived(`/api/files/${fileId}`);

  // Render strategy:
  // - image → inline thumbnail via <img src>; browser handles caching
  // - text-ish (md / txt / json / yaml / etc., under PREVIEW_MAX_BYTES)
  //   → small content snippet read from /api/files/<id>; browser
  //   caches the fetch so re-renders are cheap
  // - audio → tile with audio glyph and friendly extension badge
  // - other file → tile with document glyph and extension badge
  const isImage = $derived(contentType === 'image');

  // Heuristic for "we can show actual file contents in the tile."
  // Conservative: prefer mimeType when present, fall back to extension
  // sniff so files saved with generic mimes still preview when their
  // extension says they're text.
  const PREVIEW_MAX_BYTES = 50_000;
  const TEXT_EXT_RE = /\.(md|markdown|txt|json|yaml|yml|log|csv|xml|html|htm|svg|ts|tsx|js|jsx|css|sql|sh|toml|ini)$/i;
  const isTextPreviewable = $derived(
    contentType === 'file' &&
      size > 0 &&
      size <= PREVIEW_MAX_BYTES &&
      (mimeType.startsWith('text/') ||
        mimeType.includes('json') ||
        mimeType.includes('yaml') ||
        mimeType.includes('xml') ||
        TEXT_EXT_RE.test(filename)),
  );

  let previewText = $state<string | null>(null);
  let previewLoading = $state(false);

  $effect(() => {
    if (!isTextPreviewable) {
      previewText = null;
      return;
    }
    let cancelled = false;
    previewLoading = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('preview fetch failed'))))
      .then((text) => {
        if (!cancelled) previewText = text.slice(0, 800);
      })
      .catch(() => {
        if (!cancelled) previewText = null;
      })
      .finally(() => {
        if (!cancelled) previewLoading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Pretty short type label derived from filename / mime — used as the
  // badge on non-image tiles.
  function extensionBadge(): string {
    const dot = filename.lastIndexOf('.');
    if (dot >= 0 && dot < filename.length - 1) {
      const ext = filename.slice(dot + 1).toUpperCase();
      if (ext.length <= 5) return ext;
    }
    if (mimeType.includes('pdf')) return 'PDF';
    if (mimeType.includes('json')) return 'JSON';
    if (mimeType.includes('markdown')) return 'MD';
    if (mimeType.includes('audio/')) return 'AUDIO';
    return 'FILE';
  }
</script>

<button
  class="thumb"
  class:thumb-image={isImage}
  onclick={onclick}
  aria-label={`Open ${filename}`}
  type="button"
>
  {#if isImage}
    <img class="thumb-img" src={url} alt={filename} loading="lazy" />
  {:else if previewText !== null}
    <span class="thumb-tile thumb-text-preview" data-content-type={contentType}>
      <pre class="thumb-text-snippet">{previewText}</pre>
      <span class="thumb-text-fade" aria-hidden="true"></span>
      <span class="thumb-badge">{extensionBadge()}</span>
    </span>
  {:else}
    <span class="thumb-tile" data-content-type={contentType}>
      <span class="thumb-glyph" aria-hidden="true">
        {#if contentType === 'audio'}
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
        {:else}
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="8" y1="13" x2="16" y2="13"/>
            <line x1="8" y1="17" x2="13" y2="17"/>
          </svg>
        {/if}
      </span>
      <span class="thumb-badge">{extensionBadge()}</span>
    </span>
  {/if}
  <span class="thumb-meta">
    <span class="thumb-name">{filename}</span>
    <span class="thumb-size">{formatSize(size)}</span>
  </span>
</button>

<style>
  .thumb {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.625rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s, border-color 0.15s, transform 0.15s;
    overflow: hidden;
  }

  .thumb:hover {
    border-color: var(--border);
    background: var(--bg-hover);
  }

  .thumb:focus-visible {
    outline: 2px solid var(--accent, #6366f1);
    outline-offset: 2px;
  }

  /* Image variant: full-bleed thumbnail */
  .thumb-img {
    display: block;
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    border-radius: 0.5rem;
    background: var(--bg-secondary);
  }

  /* Non-image variant: tile with glyph and badge */
  .thumb-tile {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    transition: color 0.15s;
    overflow: hidden;
  }

  .thumb:hover .thumb-tile {
    color: var(--text-primary);
  }

  .thumb-glyph {
    display: inline-flex;
    line-height: 0;
  }

  /* Text-preview variant: shows actual file contents inside the tile,
     with a soft fade at the bottom so the badge doesn't sit on top
     of mid-line text. */
  .thumb-text-preview {
    align-items: stretch;
    justify-content: stretch;
    padding: 0.5rem 0.625rem;
  }

  .thumb-text-snippet {
    margin: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    font-family: var(--font-mono, 'JetBrains Mono', monospace);
    font-size: 0.625rem;
    line-height: 1.45;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    text-align: left;
  }

  .thumb-text-fade {
    position: absolute;
    inset: auto 0 0 0;
    height: 2.25rem;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      var(--bg-secondary) 70%
    );
    pointer-events: none;
  }

  .thumb-badge {
    position: absolute;
    bottom: 0.5rem;
    left: 0.5rem;
    padding: 0.125rem 0.4375rem;
    font-size: 0.625rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    font-family: var(--font-mono, monospace);
    color: var(--text-primary);
    background: rgba(0, 0, 0, 0.55);
    border-radius: 0.25rem;
  }

  .thumb-meta {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0 0.25rem 0.25rem;
    min-width: 0;
  }

  .thumb-name {
    font-size: 0.8125rem;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .thumb-size {
    font-size: 0.6875rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }
</style>
