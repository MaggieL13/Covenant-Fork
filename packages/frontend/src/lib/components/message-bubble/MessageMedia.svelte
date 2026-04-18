<script lang="ts">
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
    <a href={content} download={filename} class="file-link">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/>
      </svg>
      <div class="file-info">
        <span class="file-name">{filename}</span>
        {#if size}
          <span class="file-size">{formatFileSize(size)}</span>
        {/if}
      </div>
    </a>
  </div>
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

  .file-link {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--bg-tertiary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    text-decoration: none;
    transition: background 0.2s;
  }

  .file-link:hover {
    background: var(--bg-hover);
  }

  .file-link svg {
    flex-shrink: 0;
    color: var(--accent);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    overflow: hidden;
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
