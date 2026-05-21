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
