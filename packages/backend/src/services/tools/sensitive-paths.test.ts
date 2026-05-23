import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { isSensitivePath, __TEST_INTERNALS__ } from './sensitive-paths.js';

// Most tests work with synthetic resolved paths against a synthetic
// scope root; we don't need a real filesystem because isSensitivePath
// is pure string-pattern work after the path is resolved.
const scope = '/scope';

function p(rel: string): string {
  return join(scope, rel);
}

describe('isSensitivePath — built-in deny patterns', () => {
  it('matches .env at any depth', () => {
    expect(isSensitivePath(p('.env'), scope)).not.toBeNull();
    expect(isSensitivePath(p('packages/backend/.env'), scope)).not.toBeNull();
  });

  it('matches .env variants (.env.local, .env.production, .env.test)', () => {
    expect(isSensitivePath(p('.env.local'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.env.production'), scope)).not.toBeNull();
    expect(isSensitivePath(p('apps/web/.env.test'), scope)).not.toBeNull();
  });

  it('does NOT match files that merely contain "env" in the name', () => {
    expect(isSensitivePath(p('env.example'), scope)).toBeNull();
    expect(isSensitivePath(p('tenv.txt'), scope)).toBeNull();
    expect(isSensitivePath(p('environment.json'), scope)).toBeNull();
  });

  it('matches anything inside .ssh/', () => {
    expect(isSensitivePath(p('.ssh'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.ssh/config'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.ssh/known_hosts'), scope)).not.toBeNull();
    expect(isSensitivePath(p('subdir/.ssh/id_rsa'), scope)).not.toBeNull();
  });

  it('does NOT match files with .ssh as part of a longer name', () => {
    expect(isSensitivePath(p('.sshrc'), scope)).toBeNull();
    expect(isSensitivePath(p('myssh-config'), scope)).toBeNull();
  });

  it('matches .aws/credentials but not .aws/config (config can be non-secret)', () => {
    expect(isSensitivePath(p('.aws/credentials'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.aws/credentials.backup'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.aws/config'), scope)).toBeNull();
  });

  it('matches SSH private key naming patterns', () => {
    expect(isSensitivePath(p('id_rsa'), scope)).not.toBeNull();
    expect(isSensitivePath(p('id_ed25519'), scope)).not.toBeNull();
    expect(isSensitivePath(p('id_ecdsa'), scope)).not.toBeNull();
    expect(isSensitivePath(p('id_dsa'), scope)).not.toBeNull();
    expect(isSensitivePath(p('id_rsa.backup'), scope)).not.toBeNull();
    expect(isSensitivePath(p('keys/id_rsa'), scope)).not.toBeNull();
  });

  it('does NOT match files merely containing id_rsa as substring', () => {
    expect(isSensitivePath(p('tid_rsable.txt'), scope)).toBeNull();
    expect(isSensitivePath(p('valid_rsa.notes'), scope)).toBeNull();
  });

  it('matches secrets.* and credentials.* common names', () => {
    expect(isSensitivePath(p('secrets.json'), scope)).not.toBeNull();
    expect(isSensitivePath(p('secrets.yaml'), scope)).not.toBeNull();
    expect(isSensitivePath(p('config/credentials.txt'), scope)).not.toBeNull();
  });

  it('matches PEM / key / p12 / pfx file extensions', () => {
    expect(isSensitivePath(p('server.pem'), scope)).not.toBeNull();
    expect(isSensitivePath(p('private.key'), scope)).not.toBeNull();
    expect(isSensitivePath(p('cert.p12'), scope)).not.toBeNull();
    expect(isSensitivePath(p('windows.pfx'), scope)).not.toBeNull();
  });

  it('matches .netrc', () => {
    expect(isSensitivePath(p('.netrc'), scope)).not.toBeNull();
  });

  it('matches .gnupg directory contents', () => {
    expect(isSensitivePath(p('.gnupg'), scope)).not.toBeNull();
    expect(isSensitivePath(p('.gnupg/secring.gpg'), scope)).not.toBeNull();
  });

  // Cleanup-1 review (Codex P1): Covenant-native config files that
  // commonly carry secrets are now default-protected. resonant.yaml
  // holds `auth.password` plain-text; .mcp.json's `mcpServers.*.env`
  // commonly carries API keys for external MCP integrations.
  it('matches resonant.yaml (Covenant config — plain-text auth password)', () => {
    expect(isSensitivePath(p('resonant.yaml'), scope)).not.toBeNull();
    expect(isSensitivePath(p('resonant.yml'), scope)).not.toBeNull();
    expect(isSensitivePath(p('config/resonant.yaml'), scope)).not.toBeNull();
  });

  it('does NOT match unrelated yaml files', () => {
    expect(isSensitivePath(p('pulse.yaml'), scope)).toBeNull();
    expect(isSensitivePath(p('packages/backend/tsconfig.yaml'), scope)).toBeNull();
  });

  it('matches .mcp.json (MCP servers config — env values often contain tokens)', () => {
    expect(isSensitivePath(p('.mcp.json'), scope)).not.toBeNull();
    expect(isSensitivePath(p('subdir/.mcp.json'), scope)).not.toBeNull();
  });

  it('does NOT match unrelated json files', () => {
    expect(isSensitivePath(p('mcp.json'), scope)).toBeNull(); // no leading dot
    expect(isSensitivePath(p('package.json'), scope)).toBeNull();
    expect(isSensitivePath(p('tsconfig.json'), scope)).toBeNull();
  });
});

describe('isSensitivePath — caller-supplied patterns', () => {
  it('extends the built-in list (additive, not replacement)', () => {
    // pick a file that is NOT in built-in defaults so we can prove
    // additivity. `private-notes.txt` is project-specific by design.
    expect(isSensitivePath(p('private-notes.txt'), scope)).toBeNull();
    // Add it via extras
    expect(
      isSensitivePath(p('private-notes.txt'), scope, ['^private-notes\\.txt$']),
    ).not.toBeNull();
    // Built-in defaults still fire alongside extras
    expect(
      isSensitivePath(p('.env'), scope, ['^private-notes\\.txt$']),
    ).not.toBeNull();
  });

  it('drops invalid regex strings with a console warn instead of crashing', () => {
    // `[` is an unclosed character class — invalid regex
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = isSensitivePath(p('safe.txt'), scope, ['[unclosed']);
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('dropping invalid deny pattern'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('isSensitivePath — return value diagnostics', () => {
  it('returns the matching pattern source string for diagnostics', () => {
    const matched = isSensitivePath(p('.env'), scope);
    expect(matched).toBeTypeOf('string');
    expect(matched).toContain('env');
  });

  it('returns null for safe paths', () => {
    expect(isSensitivePath(p('packages/backend/src/server.ts'), scope)).toBeNull();
    expect(isSensitivePath(p('README.md'), scope)).toBeNull();
    expect(isSensitivePath(p('docs/SETUP-GUIDE.md'), scope)).toBeNull();
  });
});

describe('built-in pattern list is non-empty', () => {
  it('exports the expected built-in patterns via __TEST_INTERNALS__', () => {
    expect(__TEST_INTERNALS__.BUILTIN_DENY_PATTERNS.length).toBeGreaterThan(5);
  });
});

// Tiny vi import shim — vitest's `vi` is a global in test files but
// we use it inside a `describe` callback that doesn't auto-import,
// so we explicitly import it here.
import { vi } from 'vitest';
