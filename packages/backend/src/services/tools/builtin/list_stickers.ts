/**
 * `list_stickers` — catalog visibility for the Codex tool loop (Cleanup-3).
 *
 * Resonant ships with a sticker library (packs of `.webp` / `.png`
 * assets) that the companion can drop inline by emitting
 * `:packname_stickername:` in assistant text. The frontend markdown
 * pass (`utils/markdown.ts`) substitutes those refs for `<img>` tags
 * via a ref-map built from the same DB rows this tool returns.
 *
 * Before this tool existed, a model running on the Codex runtime had
 * no way to discover which refs were valid — it would either guess
 * (and hallucinate refs that render as literal text), or we'd have
 * to inline the entire catalog into the system prompt every turn.
 * Neither scales.
 *
 * ## What this is, narrowly
 *
 * "Catalog visibility" — pack names, sticker names, full ref strings,
 * aliases. The model learns WHICH stickers exist. It does NOT learn
 * what they look like. Image-pixel visibility is a separate, larger
 * problem (multi-modal vision input, ranking, suggestion); deliberately
 * out of scope here.
 *
 * ## Companion / user separation
 *
 * Packs flagged `user_only = true` are filtered out. The semantics are
 * "only Maggie sends these" — soft-rule visibility ("see but don't
 * use") doesn't survive chaos-engine LLMs, so hide them entirely.
 *
 * ## Send path
 *
 * No send tool. The model emits `:packname_stickername:` in its turn
 * text; the frontend resolves and renders inline. Programmatic
 * confirmation / native sticker bubbles (the `content_type: 'sticker'`
 * message kind) would be a separate `send_sticker` tool — future chip.
 *
 * ## Binary opacity
 *
 * `data/stickers/` is added to the sensitive-path deny list in this
 * same change. Models can't read the raw `.webp` bytes via `read_file`,
 * and `list_files` redacts entries in that subtree. The only way to
 * see the catalog is through this tool.
 */

import { getAllStickersWithPacks } from '../../db/stickers.js';
import { applyOutputBudget } from '../output-budget.js';
import type { CovenantTool } from '../registry.js';

interface CatalogEntry {
  /** Pack display name, lowercased (matches the ref-string segment). */
  pack: string;
  /** Sticker name within the pack, lowercased (matches the ref). */
  name: string;
  /** Canonical inline ref the model emits in assistant text. */
  ref: string;
  /** All alternate refs that resolve to the same image. Empty array
   *  when the sticker has no aliases. Full `:packname_alias:` form,
   *  not raw alias names — saves the model from constructing refs. */
  aliases: string[];
}

/**
 * Build the catalog payload from the DB. Pure transformation —
 * exported for direct unit testing without touching the tool surface
 * (registry, args validation, output budget).
 */
export function buildStickerCatalog(): CatalogEntry[] {
  const rows = getAllStickersWithPacks();
  const catalog: CatalogEntry[] = [];
  for (const row of rows) {
    if (row.user_only) continue;
    const packSegment = row.pack_name.toLowerCase();
    const nameSegment = row.name.toLowerCase();
    const aliasRefs = (row.aliases ?? []).map(
      (alias) => `:${packSegment}_${alias.toLowerCase()}:`,
    );
    catalog.push({
      pack: packSegment,
      name: nameSegment,
      ref: `:${packSegment}_${nameSegment}:`,
      aliases: aliasRefs,
    });
  }
  return catalog;
}

async function execute(_args: unknown): Promise<string> {
  // No args — the catalog is small enough (dozens to low hundreds of
  // entries in realistic deployments) that returning everything keeps
  // the surface trivial. If catalogs ever grow past a few KB
  // serialized, a `pack?` filter is the obvious extension; see the
  // module header for the "future chip" note.
  const stickers = buildStickerCatalog();
  // applyOutputBudget can in theory mid-truncate JSON. At realistic
  // catalog sizes the payload is well under 50KB (~80 bytes/entry),
  // so truncation never fires in practice. The standard suffix is
  // acceptable for the pathological case rather than building a
  // pagination layer that no current install needs.
  return applyOutputBudget(JSON.stringify({ stickers }));
}

export const listStickersTool: CovenantTool = {
  name: 'list_stickers',
  description:
    "List the available stickers the companion can render inline. Returns JSON `{stickers: [{pack, name, ref, aliases}]}` — emit any `ref` (e.g. `:packname_stickername:`) in assistant text and the frontend will render the image inline. Aliases are alternate refs that resolve to the same image. Excludes user-only packs.",
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute,
};
