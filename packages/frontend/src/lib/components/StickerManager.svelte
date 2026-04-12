<script lang="ts">
  import type { StickerPack, Sticker } from '@resonant/shared';
  import { apiFetch } from '$lib/utils/api';
  import { showToast } from '$lib/stores/toast.svelte';
  import { refresh as refreshStickerStore } from '$lib/stores/stickers.svelte';

  let packs = $state<StickerPack[]>([]);
  let stickers = $state<Record<string, Sticker[]>>({});
  let loading = $state(true);
  let expandedPack = $state<string | null>(null);

  // New pack form
  let showNewPack = $state(false);
  let newPackName = $state('');
  let newPackDesc = $state('');

  // Upload state
  let uploading = $state(false);

  async function loadPacks() {
    loading = true;
    try {
      const res = await apiFetch('/api/sticker-packs');
      if (res.ok) {
        const data = await res.json();
        packs = data.packs || [];
      }
    } catch (err) {
      console.error('Failed to load sticker packs:', err);
    } finally {
      loading = false;
    }
  }

  async function loadStickersForPack(packId: string) {
    try {
      const res = await apiFetch(`/api/stickers?packId=${packId}`);
      if (res.ok) {
        const data = await res.json();
        stickers = { ...stickers, [packId]: data.stickers || [] };
      }
    } catch (err) {
      console.error('Failed to load stickers:', err);
    }
  }

  async function createPack() {
    const name = newPackName.trim();
    if (!name) return;
    try {
      const res = await apiFetch('/api/sticker-packs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: newPackDesc.trim() }),
      });
      if (res.ok) {
        showToast('Pack created', 'success');
        newPackName = '';
        newPackDesc = '';
        showNewPack = false;
        await loadPacks();
        refreshStickerStore();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to create pack', 'error');
      }
    } catch { showToast('Failed to create pack', 'error'); }
  }

  async function deletePack(packId: string, packName: string) {
    if (!confirm(`Delete pack "${packName}" and all its stickers?`)) return;
    try {
      const res = await apiFetch(`/api/sticker-packs/${packId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Pack deleted', 'success');
        await loadPacks();
        refreshStickerStore();
      } else {
        showToast('Failed to delete pack', 'error');
      }
    } catch { showToast('Failed to delete pack', 'error'); }
  }

  async function uploadSticker(packId: string, file: File, name: string) {
    uploading = true;
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('packId', packId);
      formData.append('name', name);
      const res = await apiFetch('/api/stickers', { method: 'POST', body: formData });
      if (res.ok) {
        showToast('Sticker uploaded', 'success');
        await loadStickersForPack(packId);
        refreshStickerStore();
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to upload', 'error');
      }
    } catch { showToast('Upload failed', 'error'); }
    finally { uploading = false; }
  }

  async function deleteSticker(stickerId: string, packId: string) {
    try {
      const res = await apiFetch(`/api/stickers/${stickerId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('Sticker deleted', 'success');
        await loadStickersForPack(packId);
        refreshStickerStore();
      } else {
        showToast('Failed to delete sticker', 'error');
      }
    } catch { showToast('Failed to delete sticker', 'error'); }
  }

  // Resize image to max 256px and compress as WebP (keeps stickers small and fast)
  async function optimizeImage(file: File): Promise<File> {
    const MAX_SIZE = 256;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        // Scale down to fit within MAX_SIZE, keeping aspect ratio
        if (width > MAX_SIZE || height > MAX_SIZE) {
          const scale = MAX_SIZE / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Failed to compress')); return; }
          resolve(new File([blob], file.name.replace(/\.\w+$/, '.webp'), { type: 'image/webp' }));
        }, 'image/webp', 0.85);
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  }

  // Upload queue — prompt user for each sticker name before uploading
  let pendingFiles = $state<Array<{ file: File; packId: string }>>([]);
  let pendingStickerName = $state('');

  async function handleFileInput(packId: string, e: Event) {
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (!files) return;
    const queue: Array<{ file: File; packId: string }> = [];
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        showToast('Only image files allowed', 'error');
        continue;
      }
      queue.push({ file, packId });
    }
    input.value = '';
    if (queue.length > 0) {
      pendingFiles = queue;
      // Pre-fill with cleaned filename as suggestion
      const first = queue[0].file.name.replace(/\.\w+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      pendingStickerName = first === 'image' || first.length < 2 ? '' : first;
    }
  }

  async function confirmPendingUpload() {
    const name = pendingStickerName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!name || pendingFiles.length === 0) return;
    const { file, packId } = pendingFiles[0];
    try {
      const optimized = await optimizeImage(file);
      await uploadSticker(packId, optimized, name);
    } catch {
      showToast(`Failed to process ${file.name}`, 'error');
    }
    // Move to next file or clear
    pendingFiles = pendingFiles.slice(1);
    if (pendingFiles.length > 0) {
      const next = pendingFiles[0].file.name.replace(/\.\w+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
      pendingStickerName = next === 'image' || next.length < 2 ? '' : next;
    } else {
      pendingStickerName = '';
    }
  }

  function cancelPendingUpload() {
    pendingFiles = [];
    pendingStickerName = '';
  }

  async function toggleUserOnly(packId: string, current: boolean) {
    try {
      const res = await apiFetch(`/api/sticker-packs/${packId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userOnly: !current }),
      });
      if (res.ok) {
        packs = packs.map(p => p.id === packId ? { ...p, user_only: !current } : p);
        refreshStickerStore();
        showToast(!current ? 'Pack set to user-only' : 'Pack visible to companion', 'success');
      }
    } catch { showToast('Failed to update pack', 'error'); }
  }

  function togglePack(packId: string) {
    if (expandedPack === packId) {
      expandedPack = null;
    } else {
      expandedPack = packId;
      if (!stickers[packId]) loadStickersForPack(packId);
    }
  }

  import { onMount } from 'svelte';
  onMount(loadPacks);
</script>

<div class="sm">
  <!-- Create pack -->
  {#if !showNewPack}
    <button class="sm-add-btn" onclick={() => showNewPack = true}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      New Sticker Pack
    </button>
  {:else}
    <div class="sm-form">
      <!-- svelte-ignore a11y_autofocus -->
      <input type="text" class="sm-input" bind:value={newPackName} placeholder="Pack name (e.g. caelir)" autofocus />
      <input type="text" class="sm-input" bind:value={newPackDesc} placeholder="Description (optional)" />
      <div class="sm-form-actions">
        <button class="sm-btn sm-btn-primary" onclick={createPack} disabled={!newPackName.trim()}>Create</button>
        <button class="sm-btn sm-btn-ghost" onclick={() => showNewPack = false}>Cancel</button>
      </div>
    </div>
  {/if}

  <!-- Pack list -->
  {#if loading}
    <p class="sm-loading">Loading packs...</p>
  {:else if packs.length === 0}
    <div class="sm-empty">
      <p>No sticker packs yet</p>
      <p class="sm-empty-sub">Create a pack and upload PNG or WebP images (max 512KB)</p>
    </div>
  {:else}
    {#each packs as pack (pack.id)}
      <div class="sm-pack">
        <div class="sm-pack-header">
          <button class="sm-pack-toggle" onclick={() => togglePack(pack.id)}>
            <div class="sm-pack-info">
              <span class="sm-pack-name">{pack.name}</span>
              {#if pack.description}
                <span class="sm-pack-desc">{pack.description}</span>
              {/if}
            </div>
            <svg class="sm-chevron" class:open={expandedPack === pack.id} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <button
            class="sm-btn-icon"
            class:sm-user-only-active={pack.user_only}
            onclick={(e) => { e.stopPropagation(); toggleUserOnly(pack.id, pack.user_only); }}
            title={pack.user_only ? 'User-only (companion cannot use)' : 'Shared (companion can use)'}
          >
            {#if pack.user_only}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
              </svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 019.9-1"/>
              </svg>
            {/if}
          </button>
          <button class="sm-btn-icon sm-btn-danger" onclick={() => deletePack(pack.id, pack.name)} title="Delete pack">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
            </svg>
          </button>
        </div>

        {#if expandedPack === pack.id}
          <div class="sm-pack-body">
            <!-- Upload button -->
            <label class="sm-upload-btn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              {uploading ? 'Uploading...' : 'Upload Stickers'}
              <input type="file" accept="image/*" multiple onchange={(e) => handleFileInput(pack.id, e)} hidden />
            </label>

            <!-- Naming dialog for pending upload -->
            {#if pendingFiles.length > 0 && pendingFiles[0].packId === pack.id}
              <div class="sm-name-dialog">
                <img src={URL.createObjectURL(pendingFiles[0].file)} alt="preview" class="sm-name-preview" />
                <div class="sm-name-form">
                  <span class="sm-name-label">Name this sticker ({pendingFiles.length} remaining)</span>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    type="text"
                    class="sm-input"
                    bind:value={pendingStickerName}
                    placeholder="e.g. popcorn, heart, murder..."
                    autofocus
                    onkeydown={(e) => { if (e.key === 'Enter') confirmPendingUpload(); if (e.key === 'Escape') cancelPendingUpload(); }}
                  />
                  <div class="sm-name-actions">
                    <button class="sm-btn sm-btn-primary" onclick={confirmPendingUpload} disabled={!pendingStickerName.trim()}>
                      {uploading ? 'Uploading...' : 'Upload'}
                    </button>
                    <button class="sm-btn sm-btn-ghost" onclick={cancelPendingUpload}>Cancel</button>
                  </div>
                </div>
              </div>
            {/if}

            <!-- Sticker grid -->
            {#if stickers[pack.id]?.length}
              <div class="sm-sticker-grid">
                {#each stickers[pack.id] as sticker (sticker.id)}
                  <div class="sm-sticker-card">
                    <img src={sticker.url} alt={sticker.name} />
                    <div class="sm-sticker-info">
                      <span class="sm-sticker-name">:{pack.name}_{sticker.name}:</span>
                      <button class="sm-btn-icon sm-btn-danger sm-sticker-delete" onclick={() => deleteSticker(sticker.id, pack.id)} title="Delete">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="sm-empty-pack">No stickers in this pack yet</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .sm { display: flex; flex-direction: column; gap: 0.5rem; }

  .sm-add-btn {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem; font-weight: 500;
    color: var(--accent);
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all var(--transition);
  }
  .sm-add-btn:hover { background: var(--bg-hover); border-color: var(--accent); }

  .sm-form {
    display: flex; flex-direction: column; gap: 0.375rem;
    padding: 0.625rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }

  .sm-input {
    background: var(--bg-primary); border: 1px solid var(--border); border-radius: 0.375rem;
    color: var(--text-primary); padding: 0.375rem 0.5rem; font-size: 0.8rem; outline: none;
  }
  .sm-input:focus { border-color: var(--accent); }

  .sm-form-actions { display: flex; gap: 0.375rem; justify-content: flex-end; }

  .sm-btn { padding: 0.3rem 0.75rem; font-size: 0.75rem; border-radius: 0.375rem; font-weight: 500; cursor: pointer; }
  .sm-btn-primary { background: var(--accent); color: var(--bg-primary); }
  .sm-btn-primary:hover { opacity: 0.85; }
  .sm-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .sm-btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  .sm-btn-ghost:hover { color: var(--text-primary); }

  .sm-btn-icon { padding: 0.2rem; border-radius: 0.25rem; color: var(--text-muted); cursor: pointer; }
  .sm-btn-icon:hover { color: var(--text-primary); }
  .sm-btn-danger:hover { color: #e55; }

  .sm-loading, .sm-empty { text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1rem; }
  .sm-empty-sub { font-size: 0.7rem; opacity: 0.6; margin-top: 0.25rem; }

  .sm-pack { border: 1px solid var(--border); border-radius: 0.5rem; overflow: hidden; }

  .sm-pack-header {
    display: flex; align-items: center;
    padding: 0 0.625rem 0 0;
    background: var(--bg-surface);
  }

  .sm-pack-toggle {
    display: flex; align-items: center; justify-content: space-between;
    flex: 1; padding: 0.5rem 0.625rem;
    cursor: pointer; text-align: left;
    transition: background var(--transition);
  }
  .sm-pack-toggle:hover { background: var(--bg-hover); }

  .sm-pack-info { display: flex; flex-direction: column; gap: 0.1rem; text-align: left; }
  .sm-pack-name { font-size: 0.8rem; font-weight: 500; color: var(--text-primary); text-transform: capitalize; }
  .sm-pack-desc { font-size: 0.675rem; color: var(--text-muted); }

  .sm-user-only-active { color: var(--accent) !important; }

  .sm-chevron { transition: transform 0.2s ease; color: var(--text-muted); }
  .sm-chevron.open { transform: rotate(180deg); }

  .sm-pack-body { padding: 0.5rem 0.625rem; border-top: 1px solid var(--border); }

  .sm-upload-btn {
    display: flex; align-items: center; gap: 0.4rem;
    padding: 0.4rem 0.6rem; margin-bottom: 0.5rem;
    font-size: 0.75rem; font-weight: 500;
    color: var(--accent);
    background: rgba(155, 114, 207, 0.08);
    border: 1px dashed rgba(155, 114, 207, 0.3);
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all var(--transition);
  }
  .sm-upload-btn:hover { background: rgba(155, 114, 207, 0.15); border-color: var(--accent); }

  .sm-sticker-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.375rem;
  }

  .sm-sticker-card {
    display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
    padding: 0.375rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    position: relative;
  }

  .sm-sticker-card img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 0.25rem; }

  .sm-sticker-info { display: flex; align-items: center; gap: 0.2rem; width: 100%; }

  .sm-sticker-name {
    font-size: 0.55rem; color: var(--text-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
  }

  .sm-sticker-delete { flex-shrink: 0; }

  .sm-name-dialog {
    display: flex; gap: 0.5rem; align-items: flex-start;
    padding: 0.5rem; margin-bottom: 0.5rem;
    background: var(--bg-primary); border: 1px solid var(--accent);
    border-radius: 0.5rem;
  }
  .sm-name-preview { width: 64px; height: 64px; object-fit: contain; border-radius: 0.375rem; flex-shrink: 0; }
  .sm-name-form { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; }
  .sm-name-label { font-size: 0.675rem; color: var(--text-muted); }
  .sm-name-actions { display: flex; gap: 0.25rem; }

  .sm-empty-pack { text-align: center; color: var(--text-muted); font-size: 0.75rem; padding: 0.5rem; }
</style>
