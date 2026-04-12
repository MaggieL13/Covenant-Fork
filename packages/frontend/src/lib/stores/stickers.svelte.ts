import type { Sticker, StickerPack } from '@resonant/shared';
import { apiFetch } from '$lib/utils/api';

// State
let packs = $state<StickerPack[]>([]);
let stickers = $state<Sticker[]>([]);
let loaded = $state(false);

// Lookup map: ":packname_stickername:" → url
let stickerRefMap = $state<Map<string, string>>(new Map());

// Build the ref map from packs + stickers
function rebuildRefMap() {
  const map = new Map<string, string>();
  const packNames = new Map(packs.map(p => [p.id, p.name.toLowerCase()]));
  for (const s of stickers) {
    const packName = packNames.get(s.pack_id);
    if (packName) {
      map.set(`:${packName}_${s.name}:`, s.url);
      // Also add aliases
      for (const alias of s.aliases) {
        map.set(`:${packName}_${alias}:`, s.url);
      }
    }
  }
  stickerRefMap = map;
}

export async function loadStickers(): Promise<void> {
  try {
    const [packsRes, stickersRes] = await Promise.all([
      apiFetch('/api/sticker-packs'),
      apiFetch('/api/stickers'),
    ]);
    if (packsRes.ok) {
      const data = await packsRes.json();
      packs = data.packs || [];
    }
    if (stickersRes.ok) {
      const data = await stickersRes.json();
      stickers = data.stickers || [];
    }
    rebuildRefMap();
    loaded = true;
  } catch (err) {
    console.error('Failed to load stickers:', err);
  }
}

export async function refresh(): Promise<void> {
  await loadStickers();
}

// Get sticker URL by :packname_stickername: reference
export function getStickerUrl(ref: string): string | null {
  return stickerRefMap.get(ref.toLowerCase()) || null;
}

// Get the ref map for the markdown renderer
export function getStickerRefMap(): Map<string, string> {
  return stickerRefMap;
}

// Getters
export function getStickerPacks() { return packs; }
export function getAllStickers() { return stickers; }
export function getStickersForPack(packId: string) { return stickers.filter(s => s.pack_id === packId); }
export function isLoaded() { return loaded; }
