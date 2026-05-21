import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { assertPathInScope, CovenantToolPermissionError } from './path-guard.js';

// ─────────────────────────────────────────────────────────────────────────
// Test scaffolding
//
// We build a real temp-directory tree because the whole point of
// path-guard is `fs.realpath` symlink resolution — mocking the fs
// would just paper over the security contract we're trying to verify.
// Tree shape:
//
//   <tmpRoot>/
//     scope/
//       child.txt
//       inside-dir/
//         nested.txt
//       link-to-outside  -> ../outside/secret.txt    (symlink ESCAPES scope)
//       link-to-inside   -> ./inside-dir/nested.txt  (symlink STAYS in scope)
//     outside/
//       secret.txt
//     scope-evil/                                    (prefix-collision sibling)
//       trespass.txt
// ─────────────────────────────────────────────────────────────────────────

let tmpRoot: string;
let scopeRoot: string;
let outsideRoot: string;
let scopeEvilRoot: string;
let resolvedScopeRoot: string;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cov-pathguard-'));
  scopeRoot = join(tmpRoot, 'scope');
  outsideRoot = join(tmpRoot, 'outside');
  scopeEvilRoot = join(tmpRoot, 'scope-evil');

  await mkdir(scopeRoot);
  await mkdir(outsideRoot);
  await mkdir(scopeEvilRoot);
  await mkdir(join(scopeRoot, 'inside-dir'));

  await writeFile(join(scopeRoot, 'child.txt'), 'in-scope');
  await writeFile(join(scopeRoot, 'inside-dir', 'nested.txt'), 'in-scope-nested');
  await writeFile(join(outsideRoot, 'secret.txt'), 'SHOULD-NOT-LEAK');
  await writeFile(join(scopeEvilRoot, 'trespass.txt'), 'sibling-prefix-collision');

  // Symlinks. Some test environments (Windows CI without dev-mode)
  // disallow non-admin symlinks; skip those tests if creation fails.
  try {
    await symlink(
      join(outsideRoot, 'secret.txt'),
      join(scopeRoot, 'link-to-outside'),
    );
    await symlink(
      join(scopeRoot, 'inside-dir', 'nested.txt'),
      join(scopeRoot, 'link-to-inside'),
    );
  } catch {
    // best-effort; the symlink-specific tests check existence
  }

  resolvedScopeRoot = await realpath(scopeRoot);
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Happy paths
// ─────────────────────────────────────────────────────────────────────────

describe('assertPathInScope — in-scope targets', () => {
  it('accepts the scope root itself', async () => {
    const out = await assertPathInScope('.', scopeRoot);
    expect(out).toBe(resolvedScopeRoot);
  });

  it('accepts a direct child file (relative path)', async () => {
    const out = await assertPathInScope('child.txt', scopeRoot);
    expect(out).toBe(join(resolvedScopeRoot, 'child.txt'));
  });

  it('accepts a nested child file (relative path)', async () => {
    const out = await assertPathInScope('inside-dir/nested.txt', scopeRoot);
    expect(out).toBe(join(resolvedScopeRoot, 'inside-dir', 'nested.txt'));
  });

  it('accepts an absolute path that lives inside scope', async () => {
    const target = join(scopeRoot, 'child.txt');
    const out = await assertPathInScope(target, scopeRoot);
    expect(out).toBe(join(resolvedScopeRoot, 'child.txt'));
  });

  it('returns the canonical realpath, not the input string', async () => {
    // Pass the same path with redundant `./` segments — realpath
    // should normalize them out.
    const out = await assertPathInScope('./inside-dir/../child.txt', scopeRoot);
    expect(out).toBe(join(resolvedScopeRoot, 'child.txt'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Escapes — the security contract
// ─────────────────────────────────────────────────────────────────────────

describe('assertPathInScope — escape rejection', () => {
  it('rejects `..` traversal to a sibling directory', async () => {
    await expect(
      assertPathInScope('../outside/secret.txt', scopeRoot),
    ).rejects.toBeInstanceOf(CovenantToolPermissionError);
  });

  it('rejects an absolute path outside scope', async () => {
    await expect(
      assertPathInScope(join(outsideRoot, 'secret.txt'), scopeRoot),
    ).rejects.toBeInstanceOf(CovenantToolPermissionError);
  });

  it('rejects a sibling with a prefix-overlapping name (scope vs scope-evil)', async () => {
    // This catches the naive `startsWith(resolvedScope)` bug. Without
    // the trailing-separator check, `/tmp/.../scope-evil/...` falsely
    // matches `/tmp/.../scope...` as in-scope.
    await expect(
      assertPathInScope(
        join(scopeEvilRoot, 'trespass.txt'),
        scopeRoot,
      ),
    ).rejects.toBeInstanceOf(CovenantToolPermissionError);
  });

  it('rejects a symlink that points outside scope (realpath unwinds)', async () => {
    const linkPath = join(scopeRoot, 'link-to-outside');
    let symlinkAvailable = true;
    try {
      await realpath(linkPath);
    } catch {
      symlinkAvailable = false;
    }
    if (!symlinkAvailable) {
      // Windows non-admin run skipped — this is the security contract
      // we most want to verify, but only when the platform actually
      // allowed creating the link.
      return;
    }
    await expect(
      assertPathInScope(linkPath, scopeRoot),
    ).rejects.toBeInstanceOf(CovenantToolPermissionError);
  });

  it('error message names the offending input path', async () => {
    try {
      await assertPathInScope('../outside/secret.txt', scopeRoot);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CovenantToolPermissionError);
      expect((err as Error).message).toContain('../outside/secret.txt');
      expect((err as Error).message).toContain('escapes the tool scope');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// In-scope symlink (positive control)
// ─────────────────────────────────────────────────────────────────────────

describe('assertPathInScope — in-scope symlinks', () => {
  it('accepts a symlink whose target stays inside scope', async () => {
    const linkPath = join(scopeRoot, 'link-to-inside');
    let symlinkAvailable = true;
    try {
      await realpath(linkPath);
    } catch {
      symlinkAvailable = false;
    }
    if (!symlinkAvailable) return;

    const out = await assertPathInScope(linkPath, scopeRoot);
    expect(out).toBe(join(resolvedScopeRoot, 'inside-dir', 'nested.txt'));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Propagation behaviors
// ─────────────────────────────────────────────────────────────────────────

describe('assertPathInScope — error propagation', () => {
  it('propagates ENOENT for non-existent targets (NOT wrapped as permission error)', async () => {
    // Tools depend on this: they want to catch ENOENT specifically
    // and surface "file not found" to the model as a structured
    // tool result, not a permission error.
    await expect(
      assertPathInScope('does-not-exist.txt', scopeRoot),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
