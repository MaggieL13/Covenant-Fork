/**
 * `search_text` — grep-style regex search across files inside the
 * tool scope (PR E3b).
 *
 * Walks the directory tree under `path` (default: scope root),
 * applies an optional basename `glob` filter, and returns matching
 * lines in `file:lineNo:line` format. Useful for "where is X
 * defined?" / "find all callers of Y" / "find string Z in the
 * codebase."
 *
 * ## Limits
 *
 * - Pattern compiled with case-sensitive matching by default; passing
 *   a regex literal with `(?i)` would enable case-insensitive at the
 *   regex level (JavaScript regex doesn't support inline flags, so
 *   the model would need to use `[Aa][Bb]` style if it wants case
 *   insensitivity — alternative is exposing a `caseSensitive: boolean`
 *   arg, which we may add later if smoke shows the need).
 * - Max 200 matches returned. Truncates with notice.
 * - Files larger than 5MB skipped (avoid blowing out memory on
 *   minified bundles). Reported as `[skipped: too large]` entries.
 * - Binary files skipped (NUL byte heuristic). Reported as
 *   `[skipped: binary]` entries.
 * - Recursive walk skips `node_modules` and `.git` unconditionally —
 *   the cost-to-signal ratio of searching either is terrible.
 *
 * ## Errors the model can see
 *
 * - `permission_denied` — root path escapes the scope
 * - `not_found` — root path doesn't exist
 * - `invalid_regex` — pattern doesn't compile
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, relative } from 'path';
import {
  assertPathInScope,
  CovenantToolPermissionError,
} from '../path-guard.js';
import { applyOutputBudget } from '../output-budget.js';
import { basenameGlobToRegex } from './list_files.js';
import type { CovenantTool, ToolContext } from '../registry.js';

const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);
// Per-match line truncation. The file-size skip protects against
// minified-bundle whole-file blowups, but a single huge LINE inside
// an otherwise-normal-sized file (e.g. a one-line JSON config that's
// also 200KB) would still produce a 200KB match. Cap each rendered
// line so individual matches stay readable AND the total output
// budget isn't blown by a handful of huge hits. (E3b/2 review catch.)
const MAX_MATCH_LINE_CHARS = 500;
// ReDoS guard (E3b second-pass review future-note, fast-tracked).
// V8 can't preempt a running regex match — `pattern.test(line)` is
// synchronous from our side, so a catastrophic-backtracking pattern
// like `(a+)+b` against a long string of `a` will spin the event
// loop until V8 returns. We can't kill it mid-match without a
// worker-thread setup; what we CAN do is sample wall-clock time
// AFTER each `.test()` returns and bail the rest of the walk if
// any single match took too long or the cumulative budget tripped.
// At worst, ONE pathological line spins for ~MAX_REGEX_MS_PER_LINE
// before we abort; with a sane pattern, the per-line check costs
// a single Date.now() per line which is microseconds. The deeper
// fix (static AST rejection via safe-regex / regexp-tree) lives in
// a chip for a later arc.
const MAX_REGEX_MS_PER_LINE = 250;
const MAX_TOTAL_REGEX_MS = 5_000;

interface SearchTextArgs {
  pattern: string;
  path?: string;
  glob?: string;
}

function isSearchTextArgs(args: unknown): args is SearchTextArgs {
  if (typeof args !== 'object' || args === null) return false;
  const obj = args as Record<string, unknown>;
  if (typeof obj.pattern !== 'string') return false;
  if (obj.path !== undefined && typeof obj.path !== 'string') return false;
  if (obj.glob !== undefined && typeof obj.glob !== 'string') return false;
  return true;
}

function structuredError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

interface Match {
  file: string;
  lineNo: number;
  line: string;
}

interface WalkResult {
  matches: Match[];
  skippedTooLarge: string[];
  skippedBinary: string[];
  truncated: boolean;
  /** True when the recursive walk bailed early because the runtime's
   *  abort signal fired (user hit the stop button mid-search). The
   *  partial results above are still meaningful; the tool surfaces a
   *  notice line so the model knows the listing isn't exhaustive. */
  aborted: boolean;
  /** True when a single regex match took longer than
   *  MAX_REGEX_MS_PER_LINE or the cumulative match time exceeded
   *  MAX_TOTAL_REGEX_MS. Indicates probable catastrophic backtracking
   *  on the pattern; the model should retry with a simpler regex. */
  regexTimedOut: boolean;
  /** Cumulative milliseconds spent inside `pattern.test()` across
   *  the entire walk. Used to enforce MAX_TOTAL_REGEX_MS. */
  totalRegexMs: number;
}

async function walk(
  dir: string,
  scopeRoot: string,
  filter: RegExp | null,
  pattern: RegExp,
  result: WalkResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (result.truncated || result.aborted) return;
  // PR E3b/4 second-pass Codex review (P2 catch): on Windows a
  // search across the whole repo can spend seconds on readdir +
  // readFile before the model's stop button reaches us. Check the
  // abort signal at every loop / fs boundary so the walk bails
  // promptly with partial results intact.
  if (signal?.aborted) {
    result.aborted = true;
    return;
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdir — skip silently
  }
  if (signal?.aborted) {
    result.aborted = true;
    return;
  }

  for (const entry of entries) {
    if (result.truncated || result.aborted) return;
    if (signal?.aborted) {
      result.aborted = true;
      return;
    }
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), scopeRoot, filter, pattern, result, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    if (filter && !filter.test(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(scopeRoot, fullPath);

    let fileStats;
    try {
      fileStats = await stat(fullPath);
    } catch {
      continue;
    }
    if (fileStats.size > MAX_FILE_BYTES) {
      result.skippedTooLarge.push(relPath);
      continue;
    }
    if (signal?.aborted) {
      result.aborted = true;
      return;
    }

    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }
    if (signal?.aborted) {
      result.aborted = true;
      return;
    }

    if (content.includes('\x00')) {
      result.skippedBinary.push(relPath);
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Inner-loop abort check — long files with thousands of lines
      // could otherwise grind for hundreds of ms after stop is pressed.
      if (signal?.aborted) {
        result.aborted = true;
        return;
      }
      // ReDoS guard: sample wall time around the regex match so a
      // catastrophic-backtracking pattern halts the walk after one
      // pathological line instead of running the whole tree.
      const matchStart = Date.now();
      // Reset lastIndex on stateful regexes (RegExp with /g flag
      // remembers position across .test() calls) so two consecutive
      // lines don't get spuriously different results.
      if (pattern.global) pattern.lastIndex = 0;
      const matched = pattern.test(lines[i]);
      const matchMs = Date.now() - matchStart;
      result.totalRegexMs += matchMs;
      if (matchMs > MAX_REGEX_MS_PER_LINE || result.totalRegexMs > MAX_TOTAL_REGEX_MS) {
        result.regexTimedOut = true;
        return;
      }
      if (matched) {
        // Per-match-line cap — see comment on MAX_MATCH_LINE_CHARS.
        const line =
          lines[i].length > MAX_MATCH_LINE_CHARS
            ? lines[i].slice(0, MAX_MATCH_LINE_CHARS) + '[line truncated]'
            : lines[i];
        result.matches.push({ file: relPath, lineNo: i + 1, line });
        if (result.matches.length >= MAX_MATCHES) {
          result.truncated = true;
          return;
        }
      }
    }
  }
}

async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
  if (!isSearchTextArgs(rawArgs)) {
    return structuredError(
      'invalid_args',
      'search_text requires { pattern: string, path?: string, glob?: string }',
    );
  }

  let regex: RegExp;
  try {
    regex = new RegExp(rawArgs.pattern);
  } catch (err) {
    return structuredError(
      'invalid_regex',
      `Pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const searchRoot = rawArgs.path ?? '.';
  let resolvedRoot: string;
  try {
    resolvedRoot = await assertPathInScope(searchRoot, ctx.scopeRoot);
  } catch (err) {
    if (err instanceof CovenantToolPermissionError) {
      return structuredError('permission_denied', err.message);
    }
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return structuredError(
        'not_found',
        `Search root not found: ${searchRoot}`,
      );
    }
    throw err;
  }

  const stats = await stat(resolvedRoot);
  if (!stats.isDirectory()) {
    return structuredError(
      'not_a_directory',
      `Search root is not a directory: ${searchRoot}. Use read_file for single files.`,
    );
  }

  const filter = rawArgs.glob ? basenameGlobToRegex(rawArgs.glob) : null;

  const result: WalkResult = {
    matches: [],
    skippedTooLarge: [],
    skippedBinary: [],
    truncated: false,
    aborted: false,
    regexTimedOut: false,
    totalRegexMs: 0,
  };
  // ctx.abortSignal is sourced from the loop driver's runtime
  // controller — same signal that aborts the pi-ai request itself.
  // Cast through `unknown` because the registry's optional union
  // type includes node:stream/web's AbortSignal too; at runtime
  // they share the structural .aborted property our walk reads.
  const signal = (ctx.abortSignal as unknown as AbortSignal | undefined);
  await walk(resolvedRoot, resolvedRoot, filter, regex, result, signal);

  const header =
    result.matches.length === 0
      ? `(no matches for /${rawArgs.pattern}/ under ${searchRoot}${rawArgs.glob ? ` (filter: ${rawArgs.glob})` : ''})`
      : `(${result.matches.length}${result.truncated ? '+' : ''} matches for /${rawArgs.pattern}/ under ${searchRoot}${rawArgs.glob ? ` (filter: ${rawArgs.glob})` : ''})`;

  const lines = result.matches.map(
    (m) => `${m.file}:${m.lineNo}: ${m.line}`,
  );

  const notes: string[] = [];
  if (result.regexTimedOut) {
    // Surface FIRST so the model knows the partial results aren't
    // because the pattern didn't match — they're because the pattern
    // itself is slow. Suggest the remedy.
    notes.push(
      '[search aborted — pattern triggered slow matching (possible catastrophic backtracking). ' +
      'Try a simpler regex without nested quantifiers like `(a+)+`.]',
    );
  }
  if (result.aborted) {
    // Surface BEFORE other notes so the model sees the partial-state
    // signal first. The partial matches above are still valid hits;
    // the model can decide whether to retry with a narrower scope
    // or accept what was found.
    notes.push(
      '[search aborted by user — partial results above; not exhaustive]',
    );
  }
  if (result.truncated) {
    notes.push(
      `[stopped at ${MAX_MATCHES} matches; narrow the pattern or use glob to refine]`,
    );
  }
  if (result.skippedTooLarge.length > 0) {
    notes.push(
      `[skipped ${result.skippedTooLarge.length} files > 5MB: ${result.skippedTooLarge.slice(0, 3).join(', ')}${result.skippedTooLarge.length > 3 ? ', ...' : ''}]`,
    );
  }
  if (result.skippedBinary.length > 0) {
    notes.push(
      `[skipped ${result.skippedBinary.length} binary files]`,
    );
  }

  const suffix = notes.length > 0 ? '\n' + notes.join('\n') : '';
  // PR E3b/2 review — total-output cap as the last line of defense
  // for cases that slip past MAX_MATCHES + MAX_MATCH_LINE_CHARS
  // (e.g. 199 matches × 500 chars + headers + notes happens to be
  // close to the cap; pathological filename lengths could push it
  // over).
  return applyOutputBudget(`${header}\n${lines.join('\n')}${suffix}`);
}

export const searchTextTool: CovenantTool = {
  name: 'search_text',
  description:
    'Regex search file contents recursively under a directory. Returns matches as file:lineNo:line. Skips node_modules, .git, files >5MB, and binary files. Use the optional `glob` filter to limit which files are scanned by basename (e.g. "*.ts"). Pattern uses JavaScript regex syntax (case-sensitive; use character classes like [Aa][Bb] for insensitivity).',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'JavaScript regex pattern to search for. Case-sensitive.',
      },
      path: {
        type: 'string',
        description:
          'Directory to search under, relative to the project root. Default: project root itself.',
      },
      glob: {
        type: 'string',
        description:
          'Optional basename glob to limit which files are scanned (e.g. "*.ts", "*.test.*"). Supports `*` and `?`.',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  execute,
};
