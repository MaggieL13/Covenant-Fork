import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MODEL_MIN_CC } from '@resonant/shared';
import { PROJECT_ROOT } from '../config.js';
import { resolveConfiguredAgentModel, type AgentModelTier } from './agent.js';

/**
 * Runtime health: surfaces the Claude Code version that the bundled SDK
 * actually launches, vs the system Claude Code, vs minimum-version
 * requirements declared per model. The bundled runtime is the one that
 * matters for model compatibility — `@anthropic-ai/claude-agent-sdk`
 * ships its own `cli.js` and uses it by default unless the consumer
 * sets `pathToClaudeCodeExecutable` (we don't).
 *
 * The "active vs installed" distinction is load-bearing: after `npm install`
 * rewrites node_modules, the on-disk SDK reports a new version but the
 * running backend Node process still has the old SDK loaded in memory.
 * Active is captured once at module load (frozen until restart); installed
 * is read fresh from disk each call. The panel uses the diff between
 * them to surface "restart required" warnings.
 */

// Codex v3: use PROJECT_ROOT instead of __dirname math. Cleaner, won't
// break if the source/dist layout changes.
const SDK_PACKAGE_JSON_PATH = join(
  PROJECT_ROOT,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk',
  'package.json',
);

/**
 * Pure reader — exported for testability. Tests can stub `readFileSync`
 * or pass a custom path without dynamic-import gymnastics or module-state
 * hacks. The SDK's package.json exposes `claudeCodeVersion` directly
 * (verified empirically: `0.2.98` SDK ships `2.1.98` claudeCodeVersion);
 * we read the field rather than inferring it from the SDK version.
 */
export function readClaudeCodeVersionFromSdk(
  path: string = SDK_PACKAGE_JSON_PATH,
): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8')) as {
      version?: string;
      claudeCodeVersion?: string;
    };
    return pkg.claudeCodeVersion ?? null;
  } catch {
    return null;
  }
}

// Captured once at module load — represents what the running process
// actually has in memory. Will stay frozen until backend restart.
const ACTIVE_RUNTIME = readClaudeCodeVersionFromSdk();

/** Returns the Claude Code version the running backend has loaded. */
export function getActiveRuntimeVersion(): string | null {
  return ACTIVE_RUNTIME;
}

/**
 * Returns the Claude Code version currently on disk (in node_modules).
 * After an `npm install`, this reflects the new on-disk version while
 * the active cache continues to report the version the running process
 * loaded at startup. The two diverging is what triggers the panel's
 * "Restart required" state.
 */
export function getInstalledRuntimeVersion(): string | null {
  return readClaudeCodeVersionFromSdk();
}

/**
 * Shell out to `claude --version` (or `claude.cmd --version` on Windows).
 * Strictly informational — Resonant does NOT use the system Claude Code;
 * the backend launches the SDK's bundled cli.js. Returns null when the
 * command is unavailable or the output can't be parsed.
 */
export function getSystemClaudeCodeVersion(): string | null {
  const cmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  try {
    const out = execFileSync(cmd, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Compare two MAJOR.MINOR.PATCH version strings numerically per component.
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 *
 * Critical: string comparison gets this wrong for multi-digit components.
 * "2.1.98" lexically compares GREATER than "2.1.111" because '9' > '1'
 * at position 4. This helper splits on '.' and compares numerically so
 * "2.1.98" correctly comes before "2.1.111".
 *
 * Doesn't handle pre-release tags or build metadata — Anthropic's CC
 * versioning is plain MAJOR.MINOR.PATCH, no semver suffixes.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

// MODEL_MIN_CC now lives in `packages/shared/src/model-manifest.ts`,
// derived from the same MODELS list the frontend selector renders.
// Single source of truth — adding a new model with a min-CC requirement
// is a one-line edit in shared, picked up automatically by both surfaces.
// Re-exported here so existing imports of MODEL_MIN_CC from this module
// continue to work.
export { MODEL_MIN_CC };

export interface MinRequirement {
  version: string;
  /** "<model> (<tier>)" — e.g. "claude-opus-4-7 (autonomous)". */
  reason: string;
}

/**
 * Compute the maximum Claude Code version requirement across the three
 * configured model tiers (interactive / autonomous / pulse). Returns
 * the highest requirement and which tier+model is the bottleneck, or
 * null if no configured model has a declared minimum.
 *
 * Multi-tier matters because if `agent.model_autonomous` is set to
 * Opus 4.7 but `agent.model` is on Opus 4.5, the chat surface looks
 * fine while scheduled wakes silently fail. The panel must surface
 * the highest-requirement tier so the user sees the actual blocker.
 */
export function computeMinRequirement(): MinRequirement | null {
  const tiers: AgentModelTier[] = ['interactive', 'autonomous', 'pulse'];
  let highest: MinRequirement | null = null;

  for (const tier of tiers) {
    const model = resolveConfiguredAgentModel(tier);
    const min = MODEL_MIN_CC.get(model);
    if (!min) continue;
    if (!highest || compareVersions(min, highest.version) > 0) {
      highest = { version: min, reason: `${model} (${tier})` };
    }
  }

  return highest;
}

export interface RuntimeHealth {
  activeRuntimeVersion: string | null;
  installedRuntimeVersion: string | null;
  systemCcVersion: string | null;
  minRequired: MinRequirement | null;
  restartRequired: boolean;
}

/**
 * One-shot snapshot of runtime state for the health endpoint. Computes
 * `restartRequired` from the active-vs-installed diff (panel surfaces
 * this as "restart to load the new runtime").
 */
export function getRuntimeHealth(): RuntimeHealth {
  const active = getActiveRuntimeVersion();
  const installed = getInstalledRuntimeVersion();
  const system = getSystemClaudeCodeVersion();
  const minRequired = computeMinRequirement();
  const restartRequired = !!(
    active && installed && compareVersions(installed, active) > 0
  );
  return {
    activeRuntimeVersion: active,
    installedRuntimeVersion: installed,
    systemCcVersion: system,
    minRequired,
    restartRequired,
  };
}
