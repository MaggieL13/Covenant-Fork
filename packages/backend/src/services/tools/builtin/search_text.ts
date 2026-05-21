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
}

async function walk(
  dir: string,
  scopeRoot: string,
  filter: RegExp | null,
  pattern: RegExp,
  result: WalkResult,
): Promise<void> {
  if (result.truncated) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subdir — skip silently
  }

  for (const entry of entries) {
    if (result.truncated) return;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), scopeRoot, filter, pattern, result);
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

    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      continue;
    }

    if (content.includes('\x00')) {
      result.skippedBinary.push(relPath);
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
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
  };
  await walk(resolvedRoot, resolvedRoot, filter, regex, result);

  const header =
    result.matches.length === 0
      ? `(no matches for /${rawArgs.pattern}/ under ${searchRoot}${rawArgs.glob ? ` (filter: ${rawArgs.glob})` : ''})`
      : `(${result.matches.length}${result.truncated ? '+' : ''} matches for /${rawArgs.pattern}/ under ${searchRoot}${rawArgs.glob ? ` (filter: ${rawArgs.glob})` : ''})`;

  const lines = result.matches.map(
    (m) => `${m.file}:${m.lineNo}: ${m.line}`,
  );

  const notes: string[] = [];
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
