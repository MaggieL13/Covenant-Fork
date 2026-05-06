import type { SystemStatus, OrchestratorTaskStatus, TriggerStatus } from '@resonant/shared';
import { apiFetch } from '$lib/utils/api';

// State
let systemStatus = $state<SystemStatus | null>(null);
let config = $state<Record<string, string>>({});
let failsafe = $state<{ enabled: boolean; gentle: number; concerned: number; emergency: number }>({
  enabled: true, gentle: 120, concerned: 720, emergency: 1440,
});
// Pulse defaults mirror the Orchestrator class fields
// (pulseEnabled = false, pulseFrequency = 15) so the panel reflects
// reality if the initial /pulse fetch fails. Model defaults to the
// resonant.yaml DEFAULTS value (claude-haiku-4-5) so the dropdown has
// something sensible to render before the first fetch lands.
let pulse = $state<{ enabled: boolean; frequency: number; model: string }>({
  enabled: false, frequency: 15, model: 'claude-haiku-4-5',
});
// Runtime health — populated lazily on Settings → System mount via
// loadRuntimeHealth(). Null until first fetch.
interface RuntimeHealth {
  activeRuntimeVersion: string | null;
  installedRuntimeVersion: string | null;
  systemCcVersion: string | null;
  minRequired: { version: string; reason: string } | null;
  restartRequired: boolean;
}
let runtimeHealth = $state<RuntimeHealth | null>(null);

let triggers = $state<TriggerStatus[]>([]);
let orchestratorTasks = $state<OrchestratorTaskStatus[]>([]);
let companionName = $state('Companion');
let userName = $state('User');
let commandCenterEnabled = $state(true);
let loading = $state(false);

// Load settings + orchestrator status + failsafe via REST
export async function loadSettings(): Promise<void> {
  loading = true;
  try {
    const [configRes, orchRes, failsafeRes, pulseRes, triggersRes, prefsRes, identityRes] = await Promise.all([
      apiFetch('/api/settings'),
      apiFetch('/api/orchestrator/status'),
      apiFetch('/api/orchestrator/failsafe'),
      apiFetch('/api/orchestrator/pulse'),
      apiFetch('/api/orchestrator/triggers'),
      apiFetch('/api/preferences'),
      apiFetch('/api/identity'),
    ]);

    let prefs: Record<string, any> | null = null;
    if (prefsRes.ok) {
      prefs = await prefsRes.json();
      if (prefs?.identity?.companion_name) companionName = prefs.identity.companion_name;
      if (prefs?.identity?.user_name) userName = prefs.identity.user_name;
    }

    if (configRes.ok) {
      const data = await configRes.json();
      config = data.config || {};
      // If DB config doesn't have agent.model, seed from preferences (YAML/env/default)
      // so the ModelSelector header pill shows the real active model
      if (!config['agent.model'] && prefs?.agent?.model) {
        config = { ...config, 'agent.model': prefs.agent.model };
      }
    }

    if (orchRes.ok) {
      const data = await orchRes.json();
      orchestratorTasks = data.tasks || [];
      if (systemStatus) {
        systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
      }
    }

    if (failsafeRes.ok) {
      const data = await failsafeRes.json();
      failsafe = data;
    }

    if (pulseRes.ok) {
      const data = await pulseRes.json();
      pulse = {
        enabled: data.enabled,
        frequency: data.frequency,
        model: data.model || 'claude-haiku-4-5',
      };
    }

    if (triggersRes.ok) {
      const data = await triggersRes.json();
      triggers = data.triggers || [];
    }

    if (identityRes.ok) {
      const data = await identityRes.json();
      commandCenterEnabled = data.command_center_enabled ?? true;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  } finally {
    loading = false;
  }
}

// Update a single config value
export async function updateSetting(key: string, value: string): Promise<boolean> {
  try {
    const res = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    if (res.ok) {
      config = { ...config, [key]: value };
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Toggle orchestrator task
export async function toggleTask(wakeType: string, enabled: boolean): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tasks) {
        orchestratorTasks = data.tasks;
        if (systemStatus) {
          systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
        }
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Reschedule orchestrator task
export async function rescheduleTask(wakeType: string, cronExpr: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/tasks/${wakeType}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronExpr }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.tasks) {
        orchestratorTasks = data.tasks;
        if (systemStatus) {
          systemStatus = { ...systemStatus, orchestratorTasks: data.tasks };
        }
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Update failsafe thresholds
export async function updateFailsafe(update: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): Promise<boolean> {
  try {
    const res = await apiFetch('/api/orchestrator/failsafe', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (res.ok) {
      const data = await res.json();
      failsafe = { enabled: data.enabled, gentle: data.gentle, concerned: data.concerned, emergency: data.emergency };
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Update pulse config
export async function updatePulse(update: { enabled?: boolean; frequency?: number; model?: string }): Promise<boolean> {
  try {
    const res = await apiFetch('/api/orchestrator/pulse', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (res.ok) {
      const data = await res.json();
      pulse = {
        enabled: data.enabled,
        frequency: data.frequency,
        model: data.model || 'claude-haiku-4-5',
      };
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Runtime health — fetch the current snapshot from /api/runtime/health.
// Lazy: called from the Settings → System tab on mount, refresh button,
// and after a successful SDK update so the installed version reflects
// the new on-disk value.
export async function loadRuntimeHealth(): Promise<void> {
  try {
    const res = await apiFetch('/api/runtime/health');
    if (res.ok) {
      runtimeHealth = await res.json();
    }
  } catch (err) {
    console.error('Failed to load runtime health:', err);
  }
}

// Trigger an SDK update. Destructive — modifies package-lock.json and
// requires a backend restart for the new bundled runtime to load.
// Returns the parsed response (success + new versions) or an error
// object with stderr/stdout tails on failure.
export interface SdkUpdateResult {
  success: boolean;
  newInstalledVersion?: string | null;
  activeVersion?: string | null;
  restartRequired?: boolean;
  message?: string;
  error?: string;
  stderrTail?: string;
  stdoutTail?: string;
}

export async function updateSdk(): Promise<SdkUpdateResult> {
  try {
    const res = await apiFetch('/api/runtime/update-sdk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await res.json();
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Called from websocket store when system_status message arrives
// mcpServers param allows partial update from mcp_status_updated events
export function setSystemStatus(status: SystemStatus | null, mcpServers?: import('@resonant/shared').McpServerInfo[]): void {
  if (status) {
    systemStatus = status;
  }
  if (mcpServers && systemStatus) {
    systemStatus = { ...systemStatus, mcpServers };
  }
}

// Cancel a trigger
export async function cancelTriggerById(id: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/orchestrator/triggers/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      triggers = triggers.filter(t => t.id !== id);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Getters
export function getSystemStatus() { return systemStatus; }
export function getConfig() { return config; }
export function getFailsafe() { return failsafe; }
export function getPulse() { return pulse; }
export function getRuntimeHealth() { return runtimeHealth; }
export function getTriggers() { return triggers; }
export function getOrchestratorTasks() { return orchestratorTasks; }
export function getCompanionName() { return companionName; }
export function getUserName() { return userName; }
export function isCommandCenterEnabled(): boolean { return commandCenterEnabled; }
export function isLoading() { return loading; }
