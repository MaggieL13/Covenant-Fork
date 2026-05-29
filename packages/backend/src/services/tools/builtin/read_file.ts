/**
 * `read_file` — read a text file from inside the tool scope (PR E3b).
 *
 * Mirrors the shape of Claude SDK's Read tool so models trained on
 * Anthropic-style tool use recognize it without re-learning. Returns
 * line-numbered content (cat -n style) starting at `offset` (1-indexed
 * line) for at most `limit` lines.
 *
 * ## Defaults & limits
 *
 * - Default `offset`: 1 (start of file)
 * - Default `limit`: 2000 lines (matches Claude's Read default)
 * - Hard maximum `limit`: 2000 lines (clamp; model can't request more
 *   per call. Larger reads should be split into multiple calls with
 *   walking offsets.)
 * - Hard maximum per-line length: 2000 chars (longer lines truncated
 *   with `[line truncated]` suffix — protects against pathological
 *   minified bundle files that would otherwise blow past the 50KB
 *   per-tool-result loop-driver cap on a single line)
 *
 * ## Errors the model can see
 *
 * - `permission_denied` — path escapes the configured scope
 * - `not_found` — file doesn't exist at the resolved path
 * - `is_directory` — caller passed a directory; suggest list_files
 * - `binary` — file content includes a NUL byte; refuse to dump bytes
 *   into the prompt as garbled text
 *
 * Other fs errors propagate as thrown exceptions so the loop driver
 * surfaces them as `isError: true` tool results.
 */

import { readFile, stat } from 'fs/promises';
import {
  assertPathInScope,
  CovenantToolPermissionError,
} from '../path-guard.js';
import { applyOutputBudget } from '../output-budget.js';
import { isSensitivePathConfigured } from '../sensitive-paths.js';
import type { CovenantTool, ToolContext } from '../registry.js';

const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

function isReadFileArgs(args: unknown): args is ReadFileArgs {
  if (typeof args !== 'object' || args === null) return false;
  const obj = args as Record<string, unknown>;
  if (typeof obj.path !== 'string') return false;
  if (obj.offset !== undefined && typeof obj.offset !== 'number') return false;
  if (obj.limit !== undefined && typeof obj.limit !== 'number') return false;
  return true;
}

function structuredError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } });
}

async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
  if (!isReadFileArgs(rawArgs)) {
    return structuredError(
      'invalid_args',
      'read_file requires { path: string, offset?: number, limit?: number }',
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
        `File not found: ${rawArgs.path}`,
      );
    }
    throw err;
  }

  // Sensitive-file deny-list check. Runs AFTER assertPathInScope so
  // out-of-scope paths still hit `permission_denied` first; this is
  // a SECOND policy layer inside the scope. Matched patterns refuse
  // with a distinct structured code so the model can distinguish
  // "you can't read that, it's secret" from generic permission/not-
  // found / is-directory errors and adapt accordingly (e.g. ask
  // the user instead of trying again).
  const sensitiveMatch = isSensitivePathConfigured(resolvedPath, ctx.scopeRoot);
  if (sensitiveMatch) {
    const lowerPath = rawArgs.path.toLowerCase();
    const isConfig =
      lowerPath.includes('.mcp.json') ||
      lowerPath.includes('resonant.yaml') ||
      lowerPath.includes('resonant.yml');
    const alternative = isConfig
      ? 'For MCP servers and resonant.yaml config use summarize_mcp_config (it shows the structure with secrets redacted).'
      : lowerPath.includes('stickers')
        ? 'For stickers use list_stickers.'
        : 'Ask the user directly if you need this information.';
    return structuredError(
      'sensitive_path',
      `File "${rawArgs.path}" is on the tool-layer deny-list (pattern: ${sensitiveMatch}). Certain paths — system secrets (.env / .ssh / credentials / keys), binary asset stores (e.g. sticker images), and config holding secrets (.mcp.json / resonant.yaml) — are refused regardless of model intent. ${alternative}`,
    );
  }

  const stats = await stat(resolvedPath);
  if (stats.isDirectory()) {
    return structuredError(
      'is_directory',
      `Path is a directory, not a file: ${rawArgs.path}. Use list_files to enumerate directory contents.`,
    );
  }

  const content = await readFile(resolvedPath, 'utf8');

  // NUL byte = best heuristic for "this is binary, don't try to dump
  // it into the prompt." Avoids garbled output that wastes tokens
  // and confuses the model.
  if (content.includes('\x00')) {
    return structuredError(
      'binary',
      `File appears to be binary (contains NUL bytes): ${rawArgs.path}`,
    );
  }

  // Defensive clamps on the input numbers. Negative offset / NaN /
  // Infinity all collapse to sensible defaults rather than letting
  // them blow up the line-slicing math.
  const requestedOffset = Number.isFinite(rawArgs.offset) ? rawArgs.offset! : 1;
  const offset = Math.max(1, Math.floor(requestedOffset));
  const requestedLimit = Number.isFinite(rawArgs.limit)
    ? rawArgs.limit!
    : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));

  const allLines = content.split(/\r?\n/);
  const sliceStart = offset - 1; // 1-indexed offset → 0-indexed array
  const sliceEnd = sliceStart + limit;
  const slice = allLines.slice(sliceStart, sliceEnd);

  // Line-numbered output like `   42→content`. Pad the line number
  // column to the width of the largest line number in this slice so
  // alignment stays consistent; matches the Claude SDK Read output
  // shape the model already knows.
  const maxLineNumber = sliceStart + slice.length;
  const numberWidth = String(maxLineNumber).length;
  const rendered = slice.map((line, i) => {
    const lineNo = sliceStart + i + 1;
    const truncated =
      line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH) + '[line truncated]'
        : line;
    return `${String(lineNo).padStart(numberWidth, ' ')}→${truncated}`;
  });

  const totalLines = allLines.length;
  const shownStart = slice.length > 0 ? sliceStart + 1 : 0;
  const shownEnd = sliceStart + slice.length;
  const header =
    slice.length === 0
      ? `(no lines in range; file has ${totalLines} lines total)`
      : `(showing lines ${shownStart}-${shownEnd} of ${totalLines})`;

  // PR E3b/2 review catch: cap at the tool boundary even though the
  // line-count + per-line-length limits already prevent most blowups.
  // 2000 lines × 2000 chars = ~4MB worst case (probe-confirmed by
  // Codex review); applyOutputBudget brings that down to ~50KB.
  return applyOutputBudget(`${header}\n${rendered.join('\n')}`);
}

export const readFileTool: CovenantTool = {
  name: 'read_file',
  description:
    'Read a text file from the project. Returns line-numbered content. Use `offset` and `limit` to page through large files (defaults: offset 1, limit 2000 lines). For directories use list_files instead.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path to the file relative to the project root (e.g. "packages/backend/src/server.ts").',
      },
      offset: {
        type: 'number',
        description:
          'Starting line number, 1-indexed. Default: 1. Useful for reading the next page after a previous truncated read.',
      },
      limit: {
        type: 'number',
        description: `Maximum number of lines to return. Default: ${DEFAULT_LIMIT}. Capped at ${MAX_LIMIT}.`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  execute,
};
