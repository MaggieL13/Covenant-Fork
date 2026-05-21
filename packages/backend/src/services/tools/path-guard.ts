/**
 * Path-confinement validator for Covenant-owned tools (PR E3b).
 *
 * Every built-in tool (`read_file`, `list_files`, `search_text`, and
 * anything that comes after) routes its target path through
 * `assertPathInScope` before touching disk. The rule: the resolved
 * target must be inside (or equal to) the configured scope root after
 * symlink resolution. Targets that escape — via `..` traversal,
 * absolute paths outside scope, or symlinks pointing out — throw
 * `CovenantToolPermissionError` and the tool turn fails with a
 * structured error the model sees as "permission denied."
 *
 * ## Why `fs.realpath` (not `path.resolve`)
 *
 * Naive resolution via `path.resolve(scope, target)` produces a
 * normalized absolute path but does NOT follow symlinks. A user (or
 * a compromised process) who creates a symlink inside `scope` pointing
 * at `/etc/passwd` would pass `path.resolve` checks while reading
 * arbitrary host files. `fs.realpath` resolves the full symlink chain
 * before comparing prefixes, closing that hole.
 *
 * ## What this does NOT defend against
 *
 * - **Hardlinks**. A hardlink inside scope to an inode outside scope
 *   reads as in-scope under `realpath` because hardlinks are just
 *   directory entries for the same inode — there's no link target to
 *   resolve away. Defending against hardlink escape would require
 *   pre-walking inode tracking or filesystem-level isolation (chroot
 *   / namespaces / overlay mounts), all out of scope for E3b. The
 *   initial tool set is read-only over a configured directory, so the
 *   residual exposure is low even if exploited.
 * - **Race conditions**. A symlink could be created between
 *   `assertPathInScope` returning and the tool reading the file. The
 *   tools mitigate by passing the realpath-resolved string back to fs
 *   APIs (so any new symlink at the target position is ignored), but
 *   a TOCTOU window technically exists for parent-directory symlink
 *   swaps. Same low exposure profile as hardlinks for the initial
 *   read-only tool set.
 * - **Non-existent targets**. `fs.realpath` throws `ENOENT` on a
 *   missing file. The guard lets that error propagate so each tool
 *   can catch it and produce a structured "file not found" result
 *   the model can interpret. A future `write_file` tool would need
 *   a `mustExist: false` variant that resolves the parent and
 *   appends the basename instead.
 */

import { realpath } from 'fs/promises';
import { resolve, sep } from 'path';

/**
 * Thrown when a tool target resolves outside its configured scope.
 * Distinct error class so callers / future telemetry can pick it out
 * of the generic Error stream without string-matching messages.
 */
export class CovenantToolPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CovenantToolPermissionError';
  }
}

/**
 * Resolve `target` against `scopeRoot`, follow symlinks via
 * `fs.realpath`, and assert the resulting absolute path lives inside
 * (or equals) the resolved `scopeRoot`. Returns the resolved target
 * so callers can use it directly for subsequent fs operations
 * (avoids a second realpath call).
 *
 * - `target` is resolved against `scopeRoot` if relative; absolute
 *   targets are passed through (they still must resolve inside scope
 *   to pass the assertion).
 * - Returns the canonical resolved path of `target`, not the raw
 *   string the caller passed.
 * - Throws `CovenantToolPermissionError` on escape.
 * - Lets `ENOENT` / other fs errors propagate so tool-level handlers
 *   can shape them into structured tool errors.
 */
export async function assertPathInScope(
  target: string,
  scopeRoot: string,
): Promise<string> {
  // Resolve the scope first so a symlinked `scopeRoot` (e.g. a
  // user-supplied "agent.cwd" pointing at a junction) gets compared
  // against its canonical target, not the input string.
  const resolvedScope = await realpath(scopeRoot);

  // resolve() turns relative `target` into absolute against
  // resolvedScope. Absolute `target` is passed through unchanged.
  // Then realpath unwinds any symlinks along the path.
  const resolvedTarget = await realpath(resolve(resolvedScope, target));

  // Equality is allowed (the scope root itself), prefix-with-separator
  // means proper descendant. Without the separator check, a sibling
  // directory whose name shares a prefix (e.g. `/scope-evil` against
  // `/scope`) would falsely match.
  if (
    resolvedTarget !== resolvedScope &&
    !resolvedTarget.startsWith(resolvedScope + sep)
  ) {
    throw new CovenantToolPermissionError(
      `Path "${target}" escapes the tool scope`,
    );
  }

  return resolvedTarget;
}
