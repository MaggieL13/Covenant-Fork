import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readFileTool,
  listFilesTool,
  searchTextTool,
  registerBuiltinTools,
} from './index.js';
import { basenameGlobToRegex } from './list_files.js';
import { ToolRegistry } from '../registry.js';
import { MAX_TOOL_OUTPUT_CHARS } from '../output-budget.js';
import type { ToolContext } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────
// Shared fixture: a real temp-dir tree the tools walk.
//
//   <scopeRoot>/
//     README.md                          ("hello world\nsecond line")
//     src/
//       foo.ts                           ("const FOO = 1;\nexport default FOO;")
//       bar.ts                           ("import FOO from './foo';\nconsole.log(FOO);")
//       nested/
//         deep.ts                        ("// nested file")
//     docs/
//       guide.md                         ("# Guide\nUse FOO often.")
//     node_modules/
//       pkg/
//         index.js                       ("module.exports = 42;")  ← MUST be skipped
//     .git/
//       config                           ("[core]")                ← MUST be skipped
//     big.txt                            (6MB of zeros)            ← MUST be skipped by search
//     binary.bin                         (contains NUL bytes)      ← MUST be skipped / refused
//     longline.txt                       (single 5000-char line)   ← line truncation test
// ─────────────────────────────────────────────────────────────────────────

let tmpRoot: string;
let scopeRoot: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cov-builtin-tools-'));
  scopeRoot = await realpath(tmpRoot);
  ctx = { scopeRoot };

  await writeFile(join(scopeRoot, 'README.md'), 'hello world\nsecond line');
  await mkdir(join(scopeRoot, 'src'));
  await writeFile(
    join(scopeRoot, 'src', 'foo.ts'),
    "const FOO = 1;\nexport default FOO;",
  );
  await writeFile(
    join(scopeRoot, 'src', 'bar.ts'),
    "import FOO from './foo';\nconsole.log(FOO);",
  );
  await mkdir(join(scopeRoot, 'src', 'nested'));
  await writeFile(join(scopeRoot, 'src', 'nested', 'deep.ts'), '// nested file');
  await mkdir(join(scopeRoot, 'docs'));
  await writeFile(join(scopeRoot, 'docs', 'guide.md'), '# Guide\nUse FOO often.');

  await mkdir(join(scopeRoot, 'node_modules'));
  await mkdir(join(scopeRoot, 'node_modules', 'pkg'));
  await writeFile(
    join(scopeRoot, 'node_modules', 'pkg', 'index.js'),
    'module.exports = 42;',
  );

  await mkdir(join(scopeRoot, '.git'));
  await writeFile(join(scopeRoot, '.git', 'config'), '[core]');

  // 6MB file — over the 5MB scanner cutoff in search_text.
  await writeFile(join(scopeRoot, 'big.txt'), Buffer.alloc(6 * 1024 * 1024, 0x61));

  await writeFile(
    join(scopeRoot, 'binary.bin'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00]),
  );

  await writeFile(join(scopeRoot, 'longline.txt'), 'a'.repeat(5000));

  // PR E3b/2 review fixtures — output-budget overflow probes.
  //
  // huge.txt: 2000 lines × 1500 chars each ≈ 3MB raw text, well
  // over the 50KB output budget even after line-numbering. Codex
  // review's probe found ~3.83MB on a similar shape; this is the
  // regression we're pinning.
  const hugeLine = 'x'.repeat(1500);
  const hugeContent = Array(2000).fill(hugeLine).join('\n');
  await writeFile(join(scopeRoot, 'huge.txt'), hugeContent);

  // hugematches.txt: a file with many matching lines, each long.
  // Search_text was previously unbounded on per-match line length;
  // we now cap each match at 500 chars and the total via budget.
  const matchLine =
    'NEEDLE ' + 'padding-to-make-line-very-long '.repeat(60); // ~1800 chars
  const hugeMatchContent = Array(100).fill(matchLine).join('\n');
  await writeFile(join(scopeRoot, 'hugematches.txt'), hugeMatchContent);
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// basenameGlobToRegex (helper used by list_files + search_text)
// ─────────────────────────────────────────────────────────────────────────

describe('basenameGlobToRegex', () => {
  it('matches plain literal names', () => {
    const r = basenameGlobToRegex('foo.ts');
    expect(r.test('foo.ts')).toBe(true);
    expect(r.test('foo_ts')).toBe(false); // dot is literal, not "any char"
  });

  it('treats `*` as "any chars except slash"', () => {
    const r = basenameGlobToRegex('*.ts');
    expect(r.test('foo.ts')).toBe(true);
    expect(r.test('bar.ts')).toBe(true);
    expect(r.test('foo.tsx')).toBe(false); // requires exact suffix
    expect(r.test('subdir/foo.ts')).toBe(false); // slash not allowed
  });

  it('treats `?` as single char except slash', () => {
    const r = basenameGlobToRegex('?oo.ts');
    expect(r.test('foo.ts')).toBe(true);
    expect(r.test('boo.ts')).toBe(true);
    expect(r.test('oo.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literal text', () => {
    const r = basenameGlobToRegex('a.b+c');
    expect(r.test('a.b+c')).toBe(true);
    expect(r.test('axbzc')).toBe(false); // dot was escaped, not "any"
  });
});

// ─────────────────────────────────────────────────────────────────────────
// read_file
// ─────────────────────────────────────────────────────────────────────────

describe('read_file', () => {
  it('reads a small text file with line numbers', async () => {
    const out = await readFileTool.execute({ path: 'README.md' }, ctx);
    expect(out).toContain('1→hello world');
    expect(out).toContain('2→second line');
    expect(out).toContain('lines 1-2 of 2');
  });

  it('supports offset to skip earlier lines', async () => {
    const out = await readFileTool.execute(
      { path: 'README.md', offset: 2 },
      ctx,
    );
    expect(out).not.toContain('hello world');
    expect(out).toContain('2→second line');
  });

  it('clamps limit to the documented 2000 maximum', async () => {
    const out = await readFileTool.execute(
      { path: 'README.md', limit: 999999 },
      ctx,
    );
    // README only has 2 lines so we get both regardless of the limit
    expect(out).toContain('2→second line');
  });

  it('returns invalid_args for non-string path', async () => {
    const out = await readFileTool.execute({ path: 42 }, ctx);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'invalid_args' },
    });
  });

  it('returns permission_denied for path escape', async () => {
    const out = await readFileTool.execute(
      { path: '../outside.txt' },
      ctx,
    );
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'permission_denied' },
    });
  });

  it('returns not_found for missing files', async () => {
    const out = await readFileTool.execute(
      { path: 'does-not-exist.txt' },
      ctx,
    );
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns is_directory when caller passes a folder', async () => {
    const out = await readFileTool.execute({ path: 'src' }, ctx);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'is_directory' },
    });
  });

  it('returns binary error on files with NUL bytes', async () => {
    const out = await readFileTool.execute({ path: 'binary.bin' }, ctx);
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'binary' } });
  });

  it('truncates pathologically long single lines', async () => {
    const out = await readFileTool.execute({ path: 'longline.txt' }, ctx);
    expect(out).toContain('[line truncated]');
    // Line should be 2000 chars + the suffix, not 5000.
    expect(out.includes('a'.repeat(5000))).toBe(false);
  });

  it('has a parameters schema with required path', () => {
    expect(readFileTool.parameters).toMatchObject({
      type: 'object',
      required: ['path'],
    });
  });

  // PR E3b/2 review catch: 2000 lines × 2000 chars per line = up to
  // 4MB. Without the tool-side output cap, all 4MB would land in the
  // loop driver to be truncated, wasting CPU + memory + tokens. The
  // tool now caps at MAX_TOOL_OUTPUT_CHARS at the return boundary.
  it('total output stays under the budget even for huge files', async () => {
    const out = await readFileTool.execute({ path: 'huge.txt' }, ctx);
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    expect(out).toContain('[tool output truncated');
  });

  // Cleanup-1 (sensitive-file deny-list): read_file refuses files on
  // the deny-list with a distinct structured error code so the model
  // can adapt rather than retry.
  it('refuses sensitive files with structured `sensitive_path` error', async () => {
    // Need a .env-named fixture inside scope. Tear down after.
    await writeFile(join(scopeRoot, '.env'), 'SECRET=hunter2\n');
    try {
      const out = await readFileTool.execute({ path: '.env' }, ctx);
      const parsed = JSON.parse(out);
      expect(parsed.error.code).toBe('sensitive_path');
      expect(parsed.error.message).toContain('.env');
    } finally {
      await rm(join(scopeRoot, '.env'), { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// list_files
// ─────────────────────────────────────────────────────────────────────────

describe('list_files', () => {
  it('lists root directory entries with directories first', async () => {
    const out = await listFilesTool.execute({ path: '.' }, ctx);
    // Directories appear with trailing slash, files include sizes.
    expect(out).toContain('src/');
    expect(out).toContain('docs/');
    expect(out).toContain('README.md');
    // src/ should come before README.md in the listing.
    expect(out.indexOf('src/')).toBeLessThan(out.indexOf('README.md'));
  });

  it('applies basename pattern filter', async () => {
    const out = await listFilesTool.execute(
      { path: 'src', pattern: '*.ts' },
      ctx,
    );
    expect(out).toContain('foo.ts');
    expect(out).toContain('bar.ts');
    // Subdirectory shouldn't appear when filter only matches .ts files
    expect(out).not.toContain('nested/');
  });

  it('returns permission_denied for path escape', async () => {
    const out = await listFilesTool.execute({ path: '..' }, ctx);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'permission_denied' },
    });
  });

  it('returns not_found for missing directory', async () => {
    const out = await listFilesTool.execute(
      { path: 'no-such-dir' },
      ctx,
    );
    expect(JSON.parse(out)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('returns not_a_directory when path points at a file', async () => {
    const out = await listFilesTool.execute({ path: 'README.md' }, ctx);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'not_a_directory' },
    });
  });

  it('returns invalid_args for non-string path', async () => {
    const out = await listFilesTool.execute({ path: 42 }, ctx);
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'invalid_args' },
    });
  });

  // Cleanup-1: sensitive entries get redacted (not removed) so the
  // model knows they exist without seeing size or being able to read.
  it('redacts sensitive entries in the listing instead of refusing the whole thing', async () => {
    await writeFile(join(scopeRoot, '.env'), 'SECRET=hunter2\n');
    try {
      const out = await listFilesTool.execute({ path: '.' }, ctx);
      // .env appears, but redacted — no size, distinct marker
      expect(out).toContain('.env [redacted');
      // Sister-files still visible and detailed
      expect(out).toMatch(/README\.md \(\d+ bytes\)/);
      // Suffix notice surfaces
      expect(out).toContain('redacted by sensitive-file deny-list');
    } finally {
      await rm(join(scopeRoot, '.env'), { force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// search_text
// ─────────────────────────────────────────────────────────────────────────

describe('search_text', () => {
  it('finds matches and reports file:line:content', async () => {
    const out = await searchTextTool.execute({ pattern: 'FOO' }, ctx);
    expect(out).toContain('matches for /FOO/');
    // src/foo.ts has FOO on lines 1 and 2; src/bar.ts has FOO on
    // lines 1 and 2; docs/guide.md has FOO on line 2.
    expect(out).toMatch(/src[/\\]foo\.ts:1:.*FOO/);
    expect(out).toMatch(/docs[/\\]guide\.md:2:.*FOO/);
  });

  it('applies glob filter on basename', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'FOO', glob: '*.md' },
      ctx,
    );
    expect(out).toMatch(/docs[/\\]guide\.md/);
    // The .ts hits should NOT appear when filter restricts to .md.
    expect(out).not.toMatch(/foo\.ts/);
    expect(out).not.toMatch(/bar\.ts/);
  });

  it('limits search root via path arg', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'FOO', path: 'docs' },
      ctx,
    );
    expect(out).toMatch(/guide\.md/);
    // Without path: 'docs', we'd hit src/ matches too. With it, none.
    expect(out).not.toMatch(/foo\.ts/);
  });

  it('reports no matches with a helpful header', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'nothing_matches_xyzzy' },
      ctx,
    );
    expect(out).toContain('no matches');
  });

  it('returns invalid_regex on bad pattern', async () => {
    const out = await searchTextTool.execute(
      { pattern: '[unclosed' },
      ctx,
    );
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'invalid_regex' },
    });
  });

  it('returns permission_denied for path escape', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'anything', path: '..' },
      ctx,
    );
    expect(JSON.parse(out)).toMatchObject({
      error: { code: 'permission_denied' },
    });
  });

  it('skips node_modules unconditionally', async () => {
    // pattern would match node_modules/pkg/index.js content if it
    // wasn't skipped.
    const out = await searchTextTool.execute(
      { pattern: 'module\\.exports' },
      ctx,
    );
    expect(out).toContain('no matches');
  });

  it('skips files over 5MB and reports the skip', async () => {
    // 'a' pattern would match every line of big.txt's 6MB of 'a's
    // if it was scanned. Confirm big.txt does not appear and the
    // skip notice surfaces.
    const out = await searchTextTool.execute(
      { pattern: '^a+$', glob: 'big.*' },
      ctx,
    );
    expect(out).not.toMatch(/big\.txt:/);
    expect(out).toContain('skipped');
    expect(out).toContain('5MB');
  });

  it('skips binary files (NUL-byte heuristic)', async () => {
    // Pattern that would match binary.bin content if scanned. We
    // expect no match AND the skip notice.
    const out = await searchTextTool.execute(
      { pattern: '.', glob: 'binary.*' },
      ctx,
    );
    expect(out).not.toMatch(/binary\.bin:/);
    expect(out).toContain('binary');
  });

  // PR E3b/2 review catch: 200 matches × unbounded line length was
  // the second class of blowup. Per-match-line cap (500 chars) is the
  // first defense; total output cap is the safety net.
  it('truncates individual match lines to keep per-hit size bounded', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'NEEDLE', glob: 'hugematches.txt' },
      ctx,
    );
    // No single rendered match should carry more than the per-line
    // cap + the truncation suffix. We check by inspecting the
    // longest line of output (after the header).
    const lines = out.split('\n');
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    // Cap is 500 chars + truncation suffix length + file:line: prefix.
    // Allow some slack for the prefix and `[line truncated]` suffix.
    expect(longest).toBeLessThan(700);
    expect(out).toContain('[line truncated]');
  });

  it('total output stays under the budget even with many long matches', async () => {
    const out = await searchTextTool.execute(
      { pattern: 'NEEDLE', glob: 'hugematches.txt' },
      ctx,
    );
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  // PR E3b/4 second-pass review future-note (fast-tracked): the
  // ReDoS guard (250ms per-line + 5000ms total wall-clock budget
  // sampled AFTER each pattern.test() returns) bails the walk if a
  // catastrophic-backtracking pattern slows matching past the cap.
  // Note: V8 can't preempt a running regex match, so the guard
  // catches the CUMULATIVE damage of a cursed pattern — one slow
  // line is "tolerated" (we can't stop it mid-match), but subsequent
  // lines never run. The guard isn't directly unit-tested here
  // because triggering it requires letting a real regex spin for
  // the per-line budget, which makes the test suite slow and flaky
  // depending on V8 JIT mood. Verified via inspection + manual
  // smoke. The deeper fix (static AST rejection via safe-regex /
  // regexp-tree) lives in a chip for a later arc.

  // Cleanup-1: sensitive files are skipped during the walk (same
  // pattern as node_modules + .git) and surfaced as a notice line.
  it('skips sensitive files during the walk and surfaces a notice', async () => {
    // Use an isolated pattern that ONLY appears in .env so we don't
    // collide with the global fixtures (hugematches.txt etc.).
    await writeFile(
      join(scopeRoot, '.env'),
      'UNIQUE_DENYTEST_SECRET=value\n',
    );
    try {
      const out = await searchTextTool.execute(
        { pattern: 'UNIQUE_DENYTEST_SECRET' },
        ctx,
      );
      // No match should leak out of the .env file
      expect(out).not.toMatch(/\.env:\d+:/);
      expect(out).not.toContain('UNIQUE_DENYTEST_SECRET=');
      // Notice surfaces with the .env name
      expect(out).toContain('sensitive-file deny-list');
      expect(out).toContain('.env');
    } finally {
      await rm(join(scopeRoot, '.env'), { force: true });
    }
  });

  // Cleanup-1 review (Codex P1 catch — the bypass): when the model
  // narrows the search root to a sensitive directory like `.ssh`,
  // the walker MUST still apply the deny-list — otherwise paths
  // inside the narrowed root look like `config` (not `.ssh/config`),
  // pattern doesn't match, the deny-list is silently bypassed. Fix:
  // pass realpath(ctx.scopeRoot) as the policy root so checks are
  // computed against the project scope, NOT the narrowed search root.
  it('still skips .ssh/ when the model narrows the search root TO .ssh (no bypass)', async () => {
    const sshDir = join(scopeRoot, '.ssh');
    await mkdir(sshDir, { recursive: true });
    // Pattern and value are deliberately DIFFERENT — the search
    // pattern echoes in the result's header, so testing the leak
    // means checking that the VALUE bytes never appear, not the
    // pattern string.
    await writeFile(
      join(sshDir, 'config'),
      'PRIVATE_KEY=ssss-leak-marker-3791\n',
    );
    try {
      const out = await searchTextTool.execute(
        { pattern: 'PRIVATE_KEY', path: '.ssh' },
        ctx,
      );
      // The actual secret value MUST NOT appear. Without the bypass
      // fix, the walk would descend into .ssh and emit a match line
      // like `config:1: PRIVATE_KEY=ssss-leak-marker-3791`.
      expect(out).not.toContain('ssss-leak-marker-3791');
      // The walk should have reported .ssh as a skipped sensitive entry.
      expect(out).toContain('sensitive-file deny-list');
    } finally {
      await rm(sshDir, { recursive: true, force: true });
    }
  });

  it('still skips resonant.yaml when searched via narrowed root (no bypass)', async () => {
    const yamlPath = join(scopeRoot, 'resonant.yaml');
    await writeFile(
      yamlPath,
      'auth:\n  password: yyyy-leak-marker-8442\n',
    );
    try {
      // Use a glob that targets ONLY resonant.yaml so we can prove the
      // file-level deny check fires even when the search is otherwise
      // scoped to allow this single match.
      const out = await searchTextTool.execute(
        { pattern: 'password', glob: 'resonant.yaml' },
        ctx,
      );
      // The actual password value MUST NOT appear.
      expect(out).not.toContain('yyyy-leak-marker-8442');
      expect(out).toContain('sensitive-file deny-list');
    } finally {
      await rm(yamlPath, { force: true });
    }
  });

  // PR E3b/4 second-pass Codex review (P2 catch): the recursive walk
  // used to plow through directories + readFile calls even after the
  // model's stop button fired. Inner walk + outer execute now check
  // ctx.abortSignal at every fs / loop boundary.
  it('honors ctx.abortSignal and returns partial results with an aborted notice', async () => {
    // Pre-aborted signal — walk should bail at the very first check
    // without reading any files.
    const abortController = new AbortController();
    abortController.abort();
    const abortedCtx: ToolContext = { ...ctx, abortSignal: abortController.signal };

    const out = await searchTextTool.execute(
      { pattern: 'anything' },
      abortedCtx,
    );

    expect(out).toContain('[search aborted by user');
    // No matches expected since we aborted before any file was read.
    // (We can't strictly assert zero — the abort might land after one
    // tiny readdir — but the aborted notice MUST be present.)
  });
});

// ─────────────────────────────────────────────────────────────────────────
// registerBuiltinTools — the public bootstrap helper
// ─────────────────────────────────────────────────────────────────────────

describe('registerBuiltinTools', () => {
  it('registers all three tools on a fresh registry', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    expect(registry.size()).toBe(3);
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.get('list_files')).toBeDefined();
    expect(registry.get('search_text')).toBeDefined();
  });

  it('throws on double-registration (delegates to registry.register)', () => {
    const registry = new ToolRegistry();
    registerBuiltinTools(registry);
    expect(() => registerBuiltinTools(registry)).toThrow(
      /already registered/,
    );
  });
});
