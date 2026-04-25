/**
 * Shared formatting helpers used by both the Library page and the
 * per-thread Files panel. Keep small and pure so either surface can
 * import without any Svelte runtime dependency.
 */

/**
 * Human-readable byte size: "512 B", "3.1 KB", "1.2 MB".
 * Single-decimal where units cross kilobyte/megabyte boundaries.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
