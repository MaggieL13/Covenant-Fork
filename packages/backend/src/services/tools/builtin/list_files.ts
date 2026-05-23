/**
 * `list_files` — enumerate the contents of a directory inside the
 * tool scope (PR E3b).
 *
 * Returns a textual listing one entry per line, marking directories
 * with a trailing `/` and including file size for regular files.
 * Hidden entries (dot-prefixed) included by default — models usually
 * want to see `.env.example` / `.gitignore` / config dotfiles when
 * exploring a repo.
 *
 * ## Pattern matching
 *
 * `pattern` is an optional simple glob matched against the entry's
 * basename only (no path components). Supports:
 *   - `*` matches any run of characters except `/`
 *   - `?` matches exactly one character except `/`
 *   - All other regex metacharacters are escaped to their literal form
 *
 * Examples: `*.ts` matches `server.ts` but not `nested/server.ts`;
 * `*.test.*` matches `foo.test.ts` and `bar.test.js`.
 *
 * Path-component matching (`**`, multi-segment globs) is intentionally
 * out of scope for E3b — search_text handles recursive file discovery
 * via its own directory walk. If the model wants entries inside
 * subdirectories, it should call list_files on each subdirectory.
 *
 * ## Limits
 *
 * - Max 500 entries returned. If the directory has more, truncates
 *   with a notice on the last line.
 */

import { readdir, stat } from 'fs/promises';
import {
  assertPathInScope,
  CovenantToolPermissionError,
} from '../path-guard.js';
import { applyOutputBudget } from '../output-budget.js';
import type { CovenantTool, ToolContext } from '../registry.js';

const MAX_ENTRIES = 500;

interface ListFilesArgs {
  path: string;
  pattern?: string;
}

function isListFilesArgs(args: unknown): args is ListFilesArgs {
  if (typeof args !== 'object' || args === null) return false;
  const obj = args as Record<string, unknown>;
  if (typeof obj.path !== 'string') return false;
  if (obj.pattern !== undefined && typeof obj.pattern !== 'string') return false;
  return true;
}

function structuredError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

/**
 * Convert a simple `*` / `?` glob to an anchored regex matching a
 * single basename (no `/` allowed in matches). Escapes regex
 * metacharacters in the input to their literal form so a pattern
 * like `file.txt` matches the literal dot, not "any character."
 *
 * Exported for the test suite.
 */
export function basenameGlobToRegex(glob: string): RegExp {
  let regex = '^';
  for (const ch of glob) {
    if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += '\\' + ch;
    } else {
      regex += ch;
    }
  }
  regex += '$';
  return new RegExp(regex);
}

async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
  if (!isListFilesArgs(rawArgs)) {
    return structuredError(
      'invalid_args',
      'list_files requires { path: string, pattern?: string }',
    );
  }

  let resolvedPath: string;
  try {
    resolvedPath = await assertPathInScope(rawArgs.path, ctx.scopeRoot);
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
        `Directory not found: ${rawArgs.path}`,
      );
    }
    throw err;
  }

  const stats = await stat(resolvedPath);
  if (!stats.isDirectory()) {
    return structuredError(
      'not_a_directory',
      `Path is not a directory: ${rawArgs.path}. Use read_file for files.`,
    );
  }

  const entries = await readdir(resolvedPath, { withFileTypes: true });

  const filter = rawArgs.pattern
    ? basenameGlobToRegex(rawArgs.pattern)
    : null;

  // Stable sort: directories first (slash makes them visually cluster
  // when models scan output), then alphabetical within each group.
  const filtered = entries
    .filter((e) => (filter ? filter.test(e.name) : true))
    .sort((a, b) => {
      const aDir = a.isDirectory();
      const bDir = b.isDirectory();
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const truncated = filtered.length > MAX_ENTRIES;
  const shown = truncated ? filtered.slice(0, MAX_ENTRIES) : filtered;

  // Build the listing. Files get a size column; directories don't
  // (size of a directory entry isn't meaningful here). Symlinks
  // surface as `name -> target` style so the model knows to expect
  // a redirect on a subsequent read.
  const lines: string[] = [];
  for (const entry of shown) {
    if (entry.isDirectory()) {
      lines.push(`${entry.name}/`);
      continue;
    }
    if (entry.isFile()) {
      try {
        const entryStats = await stat(`${resolvedPath}/${entry.name}`);
        lines.push(`${entry.name} (${entryStats.size} bytes)`);
      } catch {
        lines.push(`${entry.name} (size unknown)`);
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      lines.push(`${entry.name} (symlink)`);
      continue;
    }
    lines.push(`${entry.name} (other)`);
  }

  const header =
    filtered.length === 0
      ? `(no entries in ${rawArgs.path}${rawArgs.pattern ? ` matching ${rawArgs.pattern}` : ''})`
      : `(${shown.length}${truncated ? ` of ${filtered.length}` : ''} entries in ${rawArgs.path}${rawArgs.pattern ? ` matching ${rawArgs.pattern}` : ''})`;

  const suffix = truncated
    ? `\n[... ${filtered.length - MAX_ENTRIES} more entries omitted; use pattern to narrow ...]`
    : '';

  // PR E3b/2 review — defense-in-depth output cap. The 500-entry
  // limit usually fits well under 50KB, but pathological filename
  // lengths could push it over.
  return applyOutputBudget(`${header}\n${lines.join('\n')}${suffix}`);
}

export const listFilesTool: CovenantTool = {
  name: 'list_files',
  description:
    'List entries in a directory inside the project. Directories appear first with a trailing `/`; files include size in bytes. Use the optional `pattern` glob (e.g. "*.ts") to filter by basename — supports `*` and `?` wildcards, no `**` recursion. For recursive content search use search_text.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path relative to the project root (e.g. "packages/backend/src"). Use "." for the project root itself.',
      },
      pattern: {
        type: 'string',
        description:
          'Optional glob filter matched against entry basenames. Supports `*` (any chars except `/`) and `?` (single char except `/`). Other regex metacharacters are treated as literals.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute,
};
