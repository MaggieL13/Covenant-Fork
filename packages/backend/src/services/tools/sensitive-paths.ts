/**
 * Sensitive-file deny-list for Covenant-owned tools (PR E3b follow-up).
 *
 * Path-guard (`path-guard.ts`) enforces "inside the configured scope."
 * This module enforces "even inside the scope, don't expose THIS."
 * Two distinct safety layers — path-guard is the structural boundary
 * around `cfg.agent.cwd`; this is the policy boundary around
 * commonly-secret files INSIDE that boundary.
 *
 * ## Why this exists
 *
 * During the E3b live smoke (2026-05-21), a Codex turn called
 * `read_file({path:'.env'})` and got the full file contents,
 * including a real Discord bot token. The path-guard correctly
 * identified `.env` as in-scope — it lives at the project root, and
 * `cfg.agent.cwd` is the project root. The character voice
 * (Azael's IntegrityProtocol from CLAUDE.md) noticed and advised
 * rotation, but a less-aligned model would dump the token into chat
 * / WS broadcasts / logs without flagging.
 *
 * This deny-list is the structural fallback for that case. Tools
 * route their resolved path through `isSensitivePath` and refuse
 * (or redact, for `list_files`) when the path matches the deny
 * patterns.
 *
 * ## What's NOT defended
 *
 * - A model could still read `.env.local.backup` or `secrets-real.txt`
 *   if those names slip past the regex. The deny-list catches obvious
 *   common patterns, not paranoid containment.
 * - Files that aren't conventionally-named secrets but contain
 *   secret content (e.g. someone pasting a token into `notes.txt`)
 *   are not protected.
 * - The deny-list runs AFTER `assertPathInScope`, so out-of-scope
 *   paths still fail with `permission_denied` first.
 *
 * ## Two policies for the three tools
 *
 * - **`read_file`** — refuse with structured `{error: {code: 'sensitive_path'}}`.
 *   The model gets a clear signal AND can't use the call to exfiltrate.
 * - **`list_files`** — REDACT matching entries instead of refusing the
 *   whole listing. The model sees the entry exists but not its size
 *   or any way to read it. Listing `.env` exists as `.env [redacted]`
 *   is more informative than the listing failing.
 * - **`search_text`** — SKIP matching files during the recursive walk
 *   (same pattern as `node_modules` / `.git` already does). Counted
 *   in a notice so the model knows files were skipped.
 *
 * ## Configurability
 *
 * `cfg.agent.tool_deny_patterns` (an optional `string[]` of regex
 * patterns) is ADDITIVE — caller-supplied patterns extend the
 * built-in defaults, never replace them. Defaults cover universal
 * cases (`.env`, `.ssh/`, SSH keys, PEM/key/p12/pfx, .netrc) plus
 * Covenant-native config files that hold secrets (`resonant.yaml`'s
 * plain-text auth password; `.mcp.json`'s MCP-server env values).
 * Use `tool_deny_patterns` for deployment-specific additions a
 * downstream Covenant fork might need (e.g. an org-specific secrets
 * directory layout).
 */

import { relative, sep, basename } from 'path';
import { getResonantConfig } from '../../config.js';

/**
 * Built-in deny patterns. Match against the relative-to-scope path
 * AND each path segment, so `secrets/api.key` matches `id_rsa$` if
 * any segment is `id_rsa` AND the same regex tested against the
 * full relative path matches anywhere.
 *
 * Patterns favor specificity to avoid false positives:
 * - `\.env(\..+)?$` matches `.env`, `.env.local`, `.env.production`,
 *   etc. but NOT `tenv.txt` or `env.example`.
 * - `\.ssh(\/|$)` requires the .ssh as a path segment (so a file
 *   literally named `.sshrc` doesn't match).
 * - Private SSH key patterns are anchored at end (`id_rsa$`) so a
 *   file named `id_rsa-old` matches but `tid_rsable.txt` doesn't.
 *
 * Add patterns by appending to `cfg.agent.tool_deny_patterns` — see
 * the module header.
 */
const BUILTIN_DENY_PATTERNS: RegExp[] = [
  // Env files — .env, .env.local, .env.production, etc.
  /(^|\/)\.env($|\.[^/]+$)/,
  // SSH config and keys (any file inside .ssh/)
  /(^|\/)\.ssh(\/|$)/,
  // AWS credentials file specifically (not the whole .aws/ — config
  // files there can be non-secret).
  /(^|\/)\.aws\/credentials($|\.[^/]+$)/,
  // GPG private keys
  /(^|\/)\.gnupg(\/|$)/,
  // SSH private key naming conventions
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)($|\.[^/]+$)/,
  // Common "secrets" / "credentials" file names
  /(^|\/)secrets\.[^/]+$/,
  /(^|\/)credentials\.[^/]+$/,
  // Generic netrc (curl / git auth tokens)
  /(^|\/)\.netrc$/,
  // PEM-encoded keys + certs (often paired with private keys; the
  // model usually doesn't need to read these to function)
  /\.(pem|key|p12|pfx)$/,
  // Covenant-native config files (Cleanup-1 review catch). Both can
  // hold secrets:
  //   - resonant.yaml: `auth.password` is plain-text; per config.ts
  //     line 45.
  //   - .mcp.json: `mcpServers.*.env.*` often carries API keys for
  //     external MCP integrations.
  // Refusing raw reads is the safer default. A future "safe config
  // summary" / "safe MCP summary" tool can expose the structural
  // shape without leaking values — spec'd as a follow-up chip.
  /(^|\/)resonant\.ya?ml$/,
  /(^|\/)\.mcp\.json$/,
  // Sticker binary store (Cleanup-3). Stickers live on disk as
  // `.webp` / `.png` files under `data/stickers/{pack_id}/{filename}`.
  // The LLM has no legitimate reason to read those bytes — the
  // contract for "send a sticker" is to emit `:packname_stickername:`
  // in the assistant text and let the frontend's markdown ref-map
  // render the image. Catalog discovery goes through the
  // `list_stickers` built-in tool (no raw fs). Deny matches every
  // path under `data/stickers/` so read_file refuses, list_files
  // redacts, and search_text skips the subtree.
  /(^|\/)data\/stickers(\/|$)/,
];

/**
 * Compile and cache the effective deny-pattern list. Concat of
 * built-in defaults + caller-supplied additions. Invalid regex
 * strings in the additions are dropped with a console.warn rather
 * than crashing — bad config shouldn't take down the runtime.
 *
 * ## Caching (Cleanup-1 review P3)
 *
 * `cfg.agent.tool_deny_patterns` is typically a stable array
 * reference across calls — the config is loaded once at boot. But
 * `isSensitivePath` runs on every fs op a tool does, which during
 * a `search_text` walk can be thousands of calls per turn. The
 * original implementation recompiled the regex AND re-issued the
 * console.warn for every invalid pattern on every call → log spam
 * proportional to walk size on misconfigured deployments. Cache
 * by input array reference so we recompile + warn ONCE per
 * config snapshot.
 */
let compileCacheKey: readonly string[] | undefined;
let compileCacheValue: RegExp[] = BUILTIN_DENY_PATTERNS;

function compilePatterns(extraPatternStrings?: readonly string[]): RegExp[] {
  if (!extraPatternStrings || extraPatternStrings.length === 0) {
    return BUILTIN_DENY_PATTERNS;
  }
  if (extraPatternStrings === compileCacheKey) {
    return compileCacheValue;
  }
  const extras: RegExp[] = [];
  for (const src of extraPatternStrings) {
    try {
      extras.push(new RegExp(src));
    } catch (err) {
      console.warn(
        `[sensitive-paths] dropping invalid deny pattern ${JSON.stringify(src)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  compileCacheKey = extraPatternStrings;
  compileCacheValue = [...BUILTIN_DENY_PATTERNS, ...extras];
  return compileCacheValue;
}

/**
 * Check whether the resolved target path matches any deny pattern.
 * `scopeRoot` is the realpath-resolved scope (so `relative()`
 * produces clean forward-slash relative paths on both Unix and
 * Windows after normalization).
 *
 * Returns the matching pattern's `source` for diagnostics if the
 * path is sensitive, or `null` if it's allowed.
 */
export function isSensitivePath(
  resolvedPath: string,
  scopeRoot: string,
  extraPatterns?: readonly string[],
): string | null {
  const patterns = compilePatterns(extraPatterns);
  // Normalize to forward-slash relative path so the regex patterns
  // (which use `/` as their separator) work consistently on Windows.
  const rel = relative(scopeRoot, resolvedPath).split(sep).join('/');
  const checkAgainst = rel === '' ? '.' : rel;
  for (const pattern of patterns) {
    if (pattern.test(checkAgainst)) {
      return pattern.source;
    }
  }
  // Also test the basename in isolation — catches cases where the
  // path has no preceding directory (e.g. the file lives at the
  // scope root) AND ensures basename-anchored patterns fire.
  const base = basename(resolvedPath);
  for (const pattern of patterns) {
    if (pattern.test(base)) {
      return pattern.source;
    }
  }
  return null;
}

/**
 * Convenience wrapper that reads `cfg.agent.tool_deny_patterns` from
 * the live config and delegates to `isSensitivePath`. Tools use this
 * so they don't each have to import config; tests use the pure
 * `isSensitivePath` with explicit extras for isolation.
 *
 * Reading config inside this helper means a config reload between
 * turns automatically picks up new deny patterns without restarting
 * the runtime — useful when an operator notices a leak and wants to
 * add a pattern without bouncing the service.
 */
export function isSensitivePathConfigured(
  resolvedPath: string,
  scopeRoot: string,
): string | null {
  let extras: string[] | undefined;
  try {
    extras = getResonantConfig().agent.tool_deny_patterns;
  } catch {
    // Config not loaded (e.g. during tests that bypass ensureInit).
    // Fall back to built-in defaults only.
    extras = undefined;
  }
  return isSensitivePath(resolvedPath, scopeRoot, extras);
}

/**
 * Substring fragments that signal a glob / Bash command is targeting
 * a sensitive file or directory. Used by `bashOrGlobTargetsSensitive`
 * for cases where a full path can't be resolved (e.g. glob patterns
 * like `**\/.env` or Bash one-liners that aren't path-shaped). Each
 * fragment is matched case-INSENSITIVELY as a substring of the input.
 *
 * Kept in sync by hand with `BUILTIN_DENY_PATTERNS` — when a new
 * pattern lands, add the corresponding human-readable fragment here
 * too. Caller-supplied `tool_deny_patterns` are NOT automatically
 * mirrored here because regex patterns don't decompose cleanly into
 * substrings. This is a known limitation; deployments with custom
 * deny patterns that want Bash/glob coverage should add fragments
 * via `cfg.agent.tool_deny_fragments` (separate config; future arc).
 *
 * Fragments are CONSERVATIVE — they target the unambiguous markers
 * that don't conflict with normal repo work:
 *   - `.env` matches `.env` but not `environment.ts`
 *   - `.ssh` matches `.ssh/config` but not the word `ssh` alone
 *   - `secrets.` requires the trailing dot so it doesn't catch
 *     `secrets-handler.ts` etc.
 */
const SENSITIVE_FRAGMENTS = [
  '.env',
  '.ssh',
  '.aws/credentials',
  '.gnupg',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  'secrets.',
  'credentials.',
  // Looser variants catch wildcard tokens like `resonant.y*` and
  // `.mcp.*` (shell would expand them to `resonant.yaml` / `.mcp.json`
  // at runtime). The original `resonant.yaml` / `.mcp.json` entries
  // are subsumed but kept for clarity.
  'resonant.y',
  '.mcp.',
  'resonant.yaml',
  'resonant.yml',
  '.mcp.json',
  // Cleanup-3: sticker binary store. Mirrors the
  // `(^|\/)data\/stickers(\/|$)` deny pattern for Bash/glob inputs
  // like `cat data/stickers/zephyr/tea.webp` or `ls data/stickers/*`.
  'data/stickers',
];

/**
 * Substring check for Bash commands + glob patterns that don't
 * resolve to a single concrete path. Returns the matching fragment
 * if the input targets a known-sensitive name, or `null` otherwise.
 *
 * Use this for fuzzy contexts (Bash one-liners, glob patterns).
 * Use `isSensitivePath` / `isSensitivePathConfigured` for concrete
 * file paths.
 */
export function bashOrGlobTargetsSensitive(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const lower = input.toLowerCase();
  for (const frag of SENSITIVE_FRAGMENTS) {
    if (lower.includes(frag)) return frag;
  }
  return null;
}

/** Exported for tests; otherwise the module's surface is just
 *  `isSensitivePath`, `isSensitivePathConfigured`, and
 *  `bashOrGlobTargetsSensitive`. */
export const __TEST_INTERNALS__ = Object.freeze({
  BUILTIN_DENY_PATTERNS,
  SENSITIVE_FRAGMENTS,
});
