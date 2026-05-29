/**
 * MCP-server config parsing (extracted from agent.ts for Cleanup-5).
 *
 * `.mcp.json` is on the tool-layer sensitive-path deny-list — the
 * `read_file` tool refuses it because `mcpServers.*.env.*` and
 * `headers.*` routinely carry API keys. But both the agent dispatch
 * (which hands recognized servers to the Claude SDK) and the new
 * `summarize_mcp_config` tool (which shows a REDACTED structural view
 * to Codex) need the parsed shape. This module is the single source
 * of truth for that parse so the two callers can't drift.
 *
 * Every call re-reads and re-news the objects — no module-level
 * mutable cache is exposed. A caller can mutate what it gets back
 * without corrupting anyone else's view (important: agent.ts passes
 * its copy into the SDK, the tool only reads its copy). Config edits
 * require a process restart anyway, so re-reading per call is fine —
 * these are infrequent calls against a tiny file.
 */

import { type McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'fs';
import { getResonantConfig } from '../config.js';

/**
 * Result of parsing `.mcp.json`:
 *  - `servers`: recognized + normalized into the SDK's `McpServerConfig`
 *    union (stdio / http / sse). This is exactly what agent.ts feeds
 *    the Claude SDK.
 *  - `skipped`: entries whose `type` we don't recognize. We keep ONLY
 *    the server name and the raw type string — never the rest of the
 *    object — so the summary tool can note "N unrecognized" without
 *    ever dumping a config blob that might hold secrets.
 */
export interface ParsedMcpConfig {
  servers: Record<string, McpServerConfig>;
  skipped: Array<{ name: string; rawType: string }>;
}

/**
 * Parse `.mcp.json` from the path in `agent.mcp_json_path`. Returns a
 * fresh object graph on every call. Never throws — a missing or
 * malformed file yields an empty result with a console.warn, matching
 * the agent's original fail-soft behavior.
 */
export function parseMcpConfig(): ParsedMcpConfig {
  const result: ParsedMcpConfig = { servers: {}, skipped: [] };
  const config = getResonantConfig();
  const mcpJsonPath = config.agent.mcp_json_path;
  if (!mcpJsonPath || !existsSync(mcpJsonPath)) return result;

  try {
    const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
    if (mcpJson && typeof mcpJson === 'object' && mcpJson.mcpServers) {
      for (const [name, raw] of Object.entries(mcpJson.mcpServers) as [
        string,
        any,
      ][]) {
        const type = raw?.type;
        if (type === 'url' || type === 'http') {
          result.servers[name] = {
            type: 'http',
            url: raw.url,
            headers: raw.headers ? { ...raw.headers } : undefined,
          };
        } else if (type === 'sse') {
          result.servers[name] = {
            type: 'sse',
            url: raw.url,
            headers: raw.headers ? { ...raw.headers } : undefined,
          };
        } else if (!type || type === 'stdio') {
          result.servers[name] = {
            command: raw.command,
            args: Array.isArray(raw.args) ? [...raw.args] : raw.args,
            env: raw.env ? { ...raw.env } : undefined,
          };
        } else {
          // Unrecognized type — record the NAME and raw type only, so
          // the summary tool can surface "skipped" without exposing
          // whatever fields the entry carried.
          result.skipped.push({ name, rawType: String(type) });
        }
      }
    }
  } catch (err) {
    console.warn(
      'Failed to load .mcp.json:',
      err instanceof Error ? err.message : err,
    );
  }
  return result;
}

/**
 * Convenience for agent.ts: just the recognized server map (the
 * `skipped` list is only meaningful to the summary tool). Fresh
 * object each call.
 */
export function loadMcpServersFromConfig(): Record<string, McpServerConfig> {
  return parseMcpConfig().servers;
}
