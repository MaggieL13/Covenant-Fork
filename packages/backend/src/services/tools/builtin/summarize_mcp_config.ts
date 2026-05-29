/**
 * `summarize_mcp_config` — redacted structural view of MCP servers +
 * `resonant.yaml` for tool-using models (Cleanup-5).
 *
 * ## Why this exists
 *
 * Cleanup-1 put `.mcp.json` and `resonant.yaml` on the tool-layer
 * sensitive-path deny-list — `read_file` refuses them because
 * `mcpServers.*.env.*` / `headers.*` carry API keys and
 * `auth.password` is plain-text. That's the right default. But a
 * model exploring the project legitimately needs to know WHICH MCP
 * servers exist, how they launch, what they expose, and the
 * non-secret agent config (cwd, model tiers, identity). This tool
 * gives that structural picture without ever surfacing a secret.
 *
 * ## Redaction model — fail closed, not "regex vibes"
 *
 * - **MCP env + header VALUES**: never shown. Only key NAMES + counts.
 *   These are categorically secret-bearing, so there's no heuristic to
 *   get wrong.
 * - **MCP arg VALUES**: never shown — count only. Args routinely carry
 *   `--api-key=…`, bearer tokens, or one-off paths; the model only
 *   needs "stdio, launched by node, 2 args".
 * - **MCP URLs**: sanitized to `protocol//host/pathname`. Userinfo
 *   (`user:pass@`), query string, and fragment are dropped — any of
 *   them can smuggle a token (`?token=…`).
 * - **resonant.yaml**: an explicit ALLOWLIST of known-non-secret fields
 *   is surfaced; `auth.password` is shown as `[redacted]`; everything
 *   else is omitted. Allowlist > denylist for a fixed schema: a future
 *   field stays hidden until a human vets and adds it (fail closed),
 *   rather than leaking because a regex didn't happen to match.
 * - **Unrecognized MCP server types**: name + type noted, config never
 *   dumped (parseMcpConfig already strips everything but the name).
 *
 * ## Data source
 *
 * `parseMcpConfig()` (services/mcp-config.ts) and `getResonantConfig()`
 * — both in-memory / fresh-parsed, NEVER via the `read_file` tool, so
 * the deny-list never fires on this tool's own reads. parseMcpConfig
 * returns fresh objects, so this tool can't mutate shared agent state.
 */

import { parseMcpConfig } from '../../mcp-config.js';
import { getResonantConfig } from '../../../config.js';
import { applyOutputBudget } from '../output-budget.js';
import type { CovenantTool } from '../registry.js';

/**
 * Reduce a URL to `protocol//host/pathname`, dropping userinfo, query,
 * and fragment — each of which can carry a credential or token. Returns
 * a redaction marker for anything unparseable rather than echoing the
 * raw (possibly secret-bearing) string.
 *
 * Exported for direct testing.
 */
export function sanitizeMcpUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '[no url]';
  try {
    const u = new URL(raw);
    // u.host = hostname[:port], no userinfo. pathname has no query/hash.
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[unparseable url redacted]';
  }
}

function describeEnvOrHeaderKeys(
  obj: Record<string, unknown> | undefined,
  label: string,
): string {
  const keys = obj ? Object.keys(obj) : [];
  if (keys.length === 0) return `${label}: none`;
  return `${label}: ${keys.join(', ')} (values redacted)`;
}

/**
 * Build the full redacted summary text. Pure (reads in-memory config),
 * exported so tests can assert on it without the tool wrapper.
 */
export function buildMcpConfigSummary(): string {
  const { servers, skipped } = parseMcpConfig();
  const lines: string[] = [];

  const serverNames = Object.keys(servers);
  lines.push(
    `MCP servers (${serverNames.length} configured` +
      (skipped.length ? `, ${skipped.length} unrecognized` : '') +
      `):`,
  );
  if (serverNames.length === 0 && skipped.length === 0) {
    lines.push('  (none configured)');
  }
  for (const name of serverNames) {
    const cfg = servers[name] as Record<string, unknown>;
    if ('command' in cfg) {
      // stdio transport
      const argc = Array.isArray(cfg.args) ? (cfg.args as unknown[]).length : 0;
      const envDesc = describeEnvOrHeaderKeys(
        cfg.env as Record<string, unknown> | undefined,
        'env keys',
      );
      lines.push(
        `  - ${name} [stdio] command=${String(cfg.command)} args=[${argc}] ${envDesc}`,
      );
    } else {
      // http / sse transport
      const type = String(cfg.type ?? 'unknown');
      const url = sanitizeMcpUrl(cfg.url);
      const headerDesc = describeEnvOrHeaderKeys(
        cfg.headers as Record<string, unknown> | undefined,
        'headers',
      );
      lines.push(`  - ${name} [${type}] url=${url} ${headerDesc}`);
    }
  }
  for (const s of skipped) {
    // Name + type only — never the config body.
    lines.push(`  - ${s.name} [${s.rawType}] (unrecognized type — not summarized)`);
  }

  // ---- resonant.yaml: explicit allowlist, fail closed ----------------
  const cfg = getResonantConfig();
  const pad = (s: string) => s.padEnd(26, ' ');
  const cfgLines: string[] = [];
  const push = (key: string, value: unknown) =>
    cfgLines.push(`  ${pad(key)} = ${value ?? '(unset)'}`);

  push('identity.companion_name', cfg.identity?.companion_name);
  push('identity.user_name', cfg.identity?.user_name);
  push('identity.timezone', cfg.identity?.timezone);
  push('agent.cwd', cfg.agent?.cwd);
  push('agent.model', cfg.agent?.model);
  push('agent.model_autonomous', cfg.agent?.model_autonomous);
  push('agent.model_pulse', cfg.agent?.model_pulse);
  push('agent.model_memory', cfg.agent?.model_memory);
  push('agent.thinking_effort', cfg.agent?.thinking_effort);
  push('server.host', cfg.server?.host);
  push('server.port', cfg.server?.port);
  push('voice.enabled', cfg.voice?.enabled);
  push('voice.elevenlabs_voice_id', cfg.voice?.elevenlabs_voice_id);
  push('orchestrator.enabled', cfg.orchestrator?.enabled);
  push('discord.enabled', cfg.discord?.enabled);
  push('telegram.enabled', cfg.telegram?.enabled);
  // Known secret — acknowledged but never shown.
  cfgLines.push(`  ${pad('auth.password')} = [redacted]`);

  lines.push('');
  lines.push('resonant.yaml (non-secret fields; secrets redacted):');
  lines.push(...cfgLines);

  return lines.join('\n');
}

async function execute(_args: unknown): Promise<string> {
  return applyOutputBudget(buildMcpConfigSummary());
}

export const summarizeMcpConfigTool: CovenantTool = {
  name: 'summarize_mcp_config',
  description:
    "Show a redacted structural summary of the configured MCP servers (names, transport, launch command, arg COUNT, env/header key names — never values or URLs' credentials) and the non-secret resonant.yaml config (agent cwd, model tiers, identity, toggles). Secrets (env/header values, arg values, URL credentials/tokens, auth.password) are never shown. Use this instead of trying to read .mcp.json or resonant.yaml, which the file tools refuse.",
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  execute,
};
