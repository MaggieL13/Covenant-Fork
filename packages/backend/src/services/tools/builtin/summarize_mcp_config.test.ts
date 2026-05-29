import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Mutable config holder so the mock can return a runtime-computed
// .mcp.json path (vi.mock factories are hoisted above local consts).
const holder = vi.hoisted(() => ({ cfg: null as any }));
vi.mock('../../../config.js', () => ({
  getResonantConfig: () => holder.cfg,
  PROJECT_ROOT: '/tmp/test',
}));

import {
  summarizeMcpConfigTool,
  buildMcpConfigSummary,
  sanitizeMcpUrl,
} from './summarize_mcp_config.js';

let tmpDir: string;
let mcpPath: string;

// Distinctive leak markers planted in every secret-bearing field. The
// core assertion across the suite: NONE of these may appear in output.
const ENV_LEAK = 'sk-envleak-1111';
const URL_LEAK = 'urlleak-2222';
const HDR_LEAK = 'hdrleak-3333';
const ARG_LEAK = 'argleak-4444';
const UNKNOWN_LEAK = 'shouldnt-appear-9999';
const PASS_LEAK = 'hunter2-passleak';

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cov-mcp-summary-'));
  mcpPath = join(tmpDir, '.mcp.json');
  await writeFile(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        'covenant-cc': {
          command: 'node',
          args: ['server.js', `--api-key=${ARG_LEAK}`],
          env: { API_KEY: ENV_LEAK, BASE_URL: 'https://internal' },
        },
        mind: {
          type: 'http',
          url: `https://user:pass@mind.example.com/mcp?token=${URL_LEAK}#frag`,
          headers: { Authorization: `Bearer ${HDR_LEAK}` },
        },
        'sse-thing': { type: 'sse', url: 'https://sse.example.com/stream' },
        legacy: { type: 'weird-future-type', secretBlob: UNKNOWN_LEAK },
      },
    }),
  );
  holder.cfg = {
    identity: {
      companion_name: 'Azael',
      user_name: 'Maggie',
      timezone: 'America/Asuncion',
    },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    auth: { password: PASS_LEAK },
    agent: {
      cwd: '/home/maggie/cov',
      mcp_json_path: mcpPath,
      model: 'claude-sonnet-4-6',
      model_autonomous: 'claude-opus',
      model_pulse: 'claude-haiku',
      model_memory: 'claude-haiku',
      thinking_effort: 'high',
    },
    voice: { enabled: true, elevenlabs_voice_id: 'voice-abc' },
    orchestrator: { enabled: true },
    discord: { enabled: false },
    telegram: { enabled: false },
    hooks: { context_injection: false },
  };
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('summarize_mcp_config — Cleanup-5 redacted config view', () => {
  it('NO planted secret marker ever appears in the output', () => {
    const out = buildMcpConfigSummary();
    for (const leak of [
      ENV_LEAK,
      URL_LEAK,
      HDR_LEAK,
      ARG_LEAK,
      UNKNOWN_LEAK,
      PASS_LEAK,
    ]) {
      expect(out).not.toContain(leak);
    }
  });

  it('lists configured servers with transport + command', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('covenant-cc [stdio] command=node');
    expect(out).toContain('mind [http]');
    expect(out).toContain('sse-thing [sse]');
  });

  it('stdio: shows env KEY names but redacts values', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('API_KEY');
    expect(out).toContain('BASE_URL');
    expect(out).toContain('(values redacted)');
    expect(out).not.toContain(ENV_LEAK);
  });

  it('stdio: shows arg COUNT only, never arg values', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('args=[2]');
    expect(out).not.toContain(ARG_LEAK);
    expect(out).not.toContain('--api-key');
    expect(out).not.toContain('server.js');
  });

  it('http: sanitizes URL — keeps host+path, drops credentials/query/fragment', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('https://mind.example.com/mcp');
    expect(out).not.toContain(URL_LEAK);
    expect(out).not.toContain('user:pass');
    expect(out).not.toContain('pass@');
    expect(out).not.toContain('#frag');
  });

  it('http: shows header KEY names but redacts values', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('Authorization');
    expect(out).not.toContain(HDR_LEAK);
  });

  it('unrecognized server type: name + type noted, config body never dumped', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('1 unrecognized');
    expect(out).toContain('legacy [weird-future-type]');
    expect(out).not.toContain(UNKNOWN_LEAK);
    expect(out).not.toContain('secretBlob');
  });

  it('config: surfaces allowlisted non-secret fields', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('agent.cwd');
    expect(out).toContain('/home/maggie/cov');
    expect(out).toContain('agent.model');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('identity.companion_name');
    expect(out).toContain('Azael');
    expect(out).toContain('voice.elevenlabs_voice_id');
  });

  it('config: auth.password acknowledged as [redacted], value never shown', () => {
    const out = buildMcpConfigSummary();
    expect(out).toContain('auth.password');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain(PASS_LEAK);
  });

  it('declares zero arguments', () => {
    const params = summarizeMcpConfigTool.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(params.properties)).toEqual([]);
    expect(params.required ?? []).toEqual([]);
  });

  it('execute() returns the same summary text', async () => {
    const out = await summarizeMcpConfigTool.execute({}, { scopeRoot: '/tmp' });
    expect(out).toContain('MCP servers');
    expect(out).toContain('resonant.yaml');
  });
});

describe('sanitizeMcpUrl', () => {
  it('drops userinfo, query, and fragment; keeps protocol/host/path', () => {
    expect(sanitizeMcpUrl('https://user:pass@example.com/mcp?token=abc#f')).toBe(
      'https://example.com/mcp',
    );
  });

  it('preserves port in host', () => {
    expect(sanitizeMcpUrl('http://localhost:8080/sse')).toBe(
      'http://localhost:8080/sse',
    );
  });

  it('returns a marker for unparseable input', () => {
    expect(sanitizeMcpUrl('not a url')).toBe('[unparseable url redacted]');
  });

  it('returns [no url] for missing/empty', () => {
    expect(sanitizeMcpUrl(undefined)).toBe('[no url]');
    expect(sanitizeMcpUrl('')).toBe('[no url]');
  });
});
