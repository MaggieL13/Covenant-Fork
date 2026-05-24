/**
 * Built-in Covenant tools for the Codex tool-calling loop (PR E3b).
 *
 * Each tool is exported individually for direct import in tests, and
 * `registerBuiltinTools(registry)` registers the entire set for
 * production bootstrap. Call `registerBuiltinTools` from the backend
 * startup path (see PR E3b/6 — manifest flip + bootstrap).
 */

import type { ToolRegistry } from '../registry.js';
import { readFileTool } from './read_file.js';
import { listFilesTool } from './list_files.js';
import { searchTextTool } from './search_text.js';
import { listStickersTool } from './list_stickers.js';

export { readFileTool } from './read_file.js';
export { listFilesTool } from './list_files.js';
export { searchTextTool } from './search_text.js';
export { listStickersTool } from './list_stickers.js';

/**
 * Register the full E3b built-in tool set on a `ToolRegistry`.
 * Idempotent only at the registry level — calling twice on the same
 * registry throws the registry's "already registered" error.
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  registry.register(readFileTool);
  registry.register(listFilesTool);
  registry.register(searchTextTool);
  registry.register(listStickersTool);
}
