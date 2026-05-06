import { ScheduledTask } from './scheduler.js';
import crypto from 'crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentService, resolveConfiguredAgentModel } from './agent.js';
import type { PushService } from './push.js';
import { registry } from './registry.js';
import {
  createThread,
  createMessage,
  getTodayThread,
  getThread,
  updateThreadSession,
  updateThreadActivity,
  getConfigBool,
  getConfigNumber,
  getConfig,
  setConfig,
  getConfigsByPrefix,
  deleteConfig,
  getDueTimers,
  markTimerFired,
  getActiveTriggers,
  markTriggerWaiting,
  markTriggerFired,
  markWatcherFired,
  getLastConversationalMessage,
} from './db.js';
import type { Trigger, TriggerCondition } from './db.js';
import { evaluateConditions } from './triggers.js';
import type { TriggerContext } from './triggers.js';
import { fetchLifeStatus } from './life-status.js';
import { getResonantConfig } from '../config.js';
import type { OrchestratorTaskStatus } from '@resonant/shared';
import { runDigest } from './digest.js';
import { localHour as tzLocalHour, localMinute as tzLocalMinute, localDateStr, localTimeStr, localLogStr, isCronSupported } from './time.js';

// --- Orchestrator log ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve log path: works from both src/ (tsx) and dist/ (compiled)
const LOG_DIR = join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_PATH = join(LOG_DIR, 'orchestrator.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function rotateLogIfNeeded(): void {
  try {
    if (!existsSync(LOG_PATH)) return;
    const { size } = statSync(LOG_PATH);
    if (size < LOG_MAX_BYTES) return;
    const backup = LOG_PATH + '.1';
    if (existsSync(backup)) unlinkSync(backup);
    renameSync(LOG_PATH, backup);
  } catch {
    // Non-critical — continue logging
  }
}

function olog(message: string): void {
  // Wall-clock-in-tz timestamps for the orchestrator log. The log file is
  // user-visible (read during debugging), so sovereignty applies — same
  // rule as user-facing strings elsewhere. Fall back to UTC ISO if config
  // isn't available yet (e.g. during early bootstrap before loadConfig).
  let ts: string;
  try {
    const tz = getResonantConfig().identity.timezone;
    ts = localLogStr(tz);
  } catch {
    ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  }
  const line = `${ts}  ${message}\n`;
  rotateLogIfNeeded();
  appendFileSync(LOG_PATH, line);
  console.log(`[Orchestrator] ${message}`);
}

// --- Wake prompt loading ---

const WAKE_PROMPT_PREFIX = `Follow your system prompt.`;

function getDefaultWakePrompts(userName: string): Record<string, string> {
  return {
    morning: `Good morning. Orient yourself, check in with ${userName}.`,
    midday: `Afternoon check-in. How is ${userName} doing?`,
    evening: `Evening wind-down. Reflect on the day.`,
    failsafe_gentle: `It's been a while since you heard from ${userName}. Check in.`,
    failsafe_concerned: `It's been a long time since contact with ${userName}. Reach out through available channels.`,
    failsafe_emergency: `Extended silence from ${userName}. Use all available channels to check in.`,
  };
}

/** @internal Exported for testing */
export function parseWakePromptsFile(filePath: string, userName: string): Record<string, string> {
  const defaults = getDefaultWakePrompts(userName);

  if (!existsSync(filePath)) {
    olog(`Wake prompts file not found at ${filePath} — using defaults`);
    return defaults;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const sections: Record<string, string> = {};
    let currentSection: string | null = null;
    const lines: string[] = [];

    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^##\s+(\w+)/);
      if (sectionMatch) {
        if (currentSection) {
          sections[currentSection] = lines.join('\n').trim();
        }
        currentSection = sectionMatch[1].toLowerCase();
        lines.length = 0;
      } else if (currentSection) {
        lines.push(line);
      }
    }
    if (currentSection) {
      sections[currentSection] = lines.join('\n').trim();
    }

    // Replace {user_name} placeholder in all parsed sections
    for (const key of Object.keys(sections)) {
      sections[key] = sections[key].replace(/\{user_name\}/g, userName);
    }

    // Merge: defaults first, then all parsed sections (including custom ones)
    return { ...defaults, ...sections };

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    olog(`Failed to parse wake prompts file: ${errMsg} — using defaults`);
    return defaults;
  }
}

// --- Default schedule definitions ---

export interface TaskDefinition {
  wakeType: string;
  label: string;
  cronExpr: string;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  conditional?: boolean; // If true, checks shouldSkipCheckIn before firing
  freshSession?: boolean; // If true, creates a new session
}

/** @internal Exported for testing */
export const DEFAULT_TASKS: TaskDefinition[] = [
  { wakeType: 'morning', label: '8:00 AM — Morning', cronExpr: '0 8 * * *', category: 'wake', conditional: true, freshSession: true },
  { wakeType: 'midday', label: '1:00 PM — Midday', cronExpr: '0 13 * * *', category: 'checkin', conditional: true },
  { wakeType: 'evening', label: '9:00 PM — Evening', cronExpr: '0 21 * * *', category: 'checkin' },
  { wakeType: 'handoff', label: '11:50 PM — Handoff', cronExpr: '50 23 * * *', category: 'handoff' },
];

// --- Managed task interface ---

interface ManagedTask {
  task: ScheduledTask;
  cronExpr: string;
  handler: () => void | Promise<void>;
  wakeType: string;
  label: string;
  enabled: boolean;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
}

/**
 * Convert a simple cron expression's minute+hour fields into a 12-hour
 * clock string (e.g. "0 19 * * *" -> "7:00 PM"). Returns null for any
 * expression where the minute or hour is not a fixed integer (wildcards,
 * step values, ranges), so callers can fall back to the original label.
 *
 * @internal Exported for testing
 */
export function cronToTimeLabel(cronExpr: string): string | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [minute, hour] = parts;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return null;
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (h > 23 || m > 59) return null;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

/**
 * Compose a display label from an original hardcoded label ("9:00 PM —
 * Evening") and the current effective cron. Splits the original on
 * " — " to keep the human-readable suffix ("Evening"), and derives the
 * time prefix from the current cron so reschedules don't cause drift.
 * Falls back to the original label if the cron isn't a simple
 * minute+hour fixed value.
 *
 * @internal Exported for testing
 */
export function deriveLabelFromCron(originalLabel: string, cronExpr: string): string {
  const sep = ' — ';
  const idx = originalLabel.indexOf(sep);
  const suffix = idx === -1 ? originalLabel : originalLabel.slice(idx + sep.length);
  const timePrefix = cronToTimeLabel(cronExpr);
  if (!timePrefix) return originalLabel;
  return `${timePrefix}${sep}${suffix}`;
}

/**
 * Format a "time since" span for a recency header. Scales from
 * minutes → hours → "Yesterday" → days so the companion gets a
 * readable signal regardless of gap size.
 *
 * @internal Exported for testing
 */
export function formatRecencyAgo(msSince: number): string {
  const mins = Math.floor(msSince / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Build a recency header to prepend to wake prompts so the companion
 * can choose an appropriate entrance. Returns '' when there's no prior
 * conversational activity on this thread — a brand-new thread takes
 * the canned wake prompt unchanged.
 *
 * Design note: we surface INFORMATION, not a gate. The orchestrator
 * intentionally lets the companion "read the room" (see the original
 * comment on shouldSkipCheckIn). Before this, the companion had no
 * recency data to read with, so every scheduled wake produced a full
 * "good morning, orient yourself" entrance — even 4 minutes after a
 * real exchange.
 *
 * @internal Exported for testing
 */
export function buildRecencyHeader(
  lastMessage: { role: string; created_at: string } | null,
  now: Date = new Date(),
): string {
  if (!lastMessage) return '';
  const ms = now.getTime() - new Date(lastMessage.created_at).getTime();
  if (ms < 0) return ''; // clock skew / future-dated message — don't mislead
  const ago = formatRecencyAgo(ms);
  const who = lastMessage.role === 'companion' ? 'your own message' : 'a user message';
  return (
    `[Recency: last conversational activity in this thread was ${ago} ` +
    `(${who}). Adjust your entrance accordingly — if you just finished ` +
    `talking, do not perform a fresh "good morning" opening.]\n\n`
  );
}

/** @internal Exported for testing */
export function isValidCron(expr: string): boolean {
  // Sovereignty: validate against ScheduledTask's own parser so we don't
  // accept crons croner would take but our scheduler can't.
  return isCronSupported(expr);
}

/**
 * Resolve the cron expression to use for a task, defending against
 * malformed persisted config (e.g. a six-field croner-extended value
 * left over from before the scheduler was replaced) so orchestrator
 * startup never throws on a bad row.
 *
 * Returns the expression to use plus an optional warning string the
 * caller should log if the saved cron was rejected.
 *
 * @internal Exported for testing
 */
export function resolveCronExpression(
  savedCron: string | null | undefined,
  defaultCron: string,
): { expr: string; warning: string | null } {
  if (savedCron && isValidCron(savedCron)) {
    return { expr: savedCron, warning: null };
  }
  if (savedCron) {
    return {
      expr: defaultCron,
      warning: `saved cron "${savedCron}" is invalid; falling back to default ${defaultCron}. Reschedule via the orchestrator admin to fix.`,
    };
  }
  return { expr: defaultCron, warning: null };
}

// --- Default failsafe thresholds (minutes) ---

const DEFAULT_FAILSAFE_GENTLE = 120;
const DEFAULT_FAILSAFE_CONCERNED = 720;
const DEFAULT_FAILSAFE_EMERGENCY = 1440;

// --- Pulse soft-ack policy ---
//
// Treat the model's pulse response as "stay silent" when it matches the
// PULSE_OK sentinel exactly OR appears to be empty acknowledgment chatter
// (the documented okay-pulse failure mode). Exported as a pure helper so
// the regex policy is testable in isolation without spinning up the
// orchestrator.
const PULSE_SOFT_ACK_RE = /^(okay|ok|alright|all\s+(quiet|good)|just\s+checking|here\s+if|nothing\s+(to|needs))/i;

export function isSuppressiblePulseResponse(resp: string): boolean {
  const trimmed = resp.trim();
  if (trimmed === 'PULSE_OK') return true;
  if (/^\W*PULSE_OK\W*$/.test(trimmed)) return true;
  if (trimmed.length < 200 && PULSE_SOFT_ACK_RE.test(trimmed)) return true;
  return false;
}

// --- Orchestrator ---

export class Orchestrator {
  private agent: AgentService;
  private pushService: PushService | null;
  private tasks = new Map<string, ManagedTask>();
  private failsafeInterval: ReturnType<typeof setInterval> | null = null;
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private lastFailsafeActions: Record<string, Date> = {
    gentle: new Date(0),
    concerned: new Date(0),
    emergency: new Date(0),
  };

  private readonly FAILSAFE_COOLDOWNS: Record<string, number> = {
    gentle: 2 * 60 * 60 * 1000,     // 2 hours
    concerned: 6 * 60 * 60 * 1000,  // 6 hours
    emergency: 1 * 60 * 60 * 1000,  // 1 hour (urgent, shorter)
  };

  private failsafeEnabled = true;
  private failsafeGentle = DEFAULT_FAILSAFE_GENTLE;
  private failsafeConcerned = DEFAULT_FAILSAFE_CONCERNED;
  private failsafeEmergency = DEFAULT_FAILSAFE_EMERGENCY;
  private pulseInterval: ReturnType<typeof setInterval> | null = null;
  private digestInterval: ReturnType<typeof setInterval> | null = null;
  private pulseEnabled = false;
  private pulseFrequency = 15; // minutes
  // Track the last pulse-gate skip reason so we coalesce repeated skips
  // (e.g. "presence active" hitting every 5 min while you're chatting)
  // down to one log line per state-transition. Reset when pulse actually
  // fires so the next skip cycle logs once on entry.
  private lastPulseSkipKey: string | null = null;
  private lastUserPresenceState: 'active' | 'idle' | 'offline' = 'offline';
  private wakePrompts: Record<string, string> = {};

  constructor(agent: AgentService, pushService?: PushService) {
    this.agent = agent;
    this.pushService = pushService || null;
  }

  start(): void {
    olog('Starting...');

    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const userName = config.identity.user_name;

    // Load wake prompts from file or use defaults
    const loadedPrompts = parseWakePromptsFile(config.orchestrator.wake_prompts_path, userName);
    this.wakePrompts = {};
    for (const [key, prompt] of Object.entries(loadedPrompts)) {
      this.wakePrompts[key] = `${WAKE_PROMPT_PREFIX}\n\n${prompt}`;
    }

    // Load failsafe config from DB, falling back to yaml config, then defaults
    this.failsafeEnabled = getConfigBool('failsafe.enabled', config.orchestrator.failsafe.enabled);
    this.failsafeGentle = getConfigNumber('failsafe.gentle', config.orchestrator.failsafe.gentle_minutes || DEFAULT_FAILSAFE_GENTLE);
    this.failsafeConcerned = getConfigNumber('failsafe.concerned', config.orchestrator.failsafe.concerned_minutes || DEFAULT_FAILSAFE_CONCERNED);
    this.failsafeEmergency = getConfigNumber('failsafe.emergency', config.orchestrator.failsafe.emergency_minutes || DEFAULT_FAILSAFE_EMERGENCY);

    // Load pulse config from DB
    this.pulseEnabled = getConfigBool('pulse.enabled', false);
    this.pulseFrequency = getConfigNumber('pulse.frequency', 15);

    // Apply any schedule overrides from config + register custom wake
    // types. YAML overrides go through the same isCronSupported check
    // as DB-persisted schedules so a malformed orchestrator.schedules
    // entry can't crash startup either — they get rejected here, not
    // later when ScheduledTask throws.
    const defaultWakeTypes = new Set(DEFAULT_TASKS.map(d => d.wakeType));
    const taskDefs: TaskDefinition[] = DEFAULT_TASKS.map(def => {
      const overrideCron = config.orchestrator.schedules[def.wakeType];
      if (overrideCron) {
        if (isValidCron(overrideCron)) {
          return { ...def, cronExpr: overrideCron };
        }
        olog(
          `  ${def.wakeType}: WARNING orchestrator.schedules YAML override "${overrideCron}" is invalid; ` +
            `falling back to default ${def.cronExpr}.`,
        );
      }
      return def;
    });

    // Add custom schedule entries not in DEFAULT_TASKS — same validation.
    // For custom wakes there's no default to fall back to, so an invalid
    // entry is skipped entirely with a loud log; the rest of the
    // orchestrator still loads.
    for (const [wakeType, cronExpr] of Object.entries(config.orchestrator.schedules)) {
      if (defaultWakeTypes.has(wakeType)) continue; // already handled above
      if (!isValidCron(cronExpr)) {
        olog(
          `  ${wakeType}: WARNING custom orchestrator.schedules YAML cron "${cronExpr}" is invalid; ` +
            `skipping this wake type. Fix the entry in resonant.yaml to register it.`,
        );
        continue;
      }
      const label = wakeType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      taskDefs.push({
        wakeType,
        label,
        cronExpr,
        category: 'checkin',
        conditional: true,
      });
      // Ensure a wake prompt exists for this custom type
      if (!this.wakePrompts[wakeType]) {
        this.wakePrompts[wakeType] = `${WAKE_PROMPT_PREFIX}\n\nScheduled check-in (${label}).`;
      }
    }

    // Register all scheduled tasks
    for (const def of taskDefs) {
      const savedCron = getConfig(`cron.${def.wakeType}.schedule`);
      // Validate the persisted cron before trusting it — historical
      // databases may carry a 6-field croner-extended value (rejected
      // by the strict ScheduledTask parser) or any other malformed
      // config that would otherwise throw and crash startup.
      const resolved = resolveCronExpression(savedCron, def.cronExpr);
      const cronExpr = resolved.expr;
      if (resolved.warning) {
        olog(`  ${def.wakeType}: WARNING ${resolved.warning}`);
      } else if (savedCron) {
        olog(`  ${def.wakeType}: using saved schedule ${cronExpr}`);
      }
      const enabled = getConfigBool(`cron.${def.wakeType}.enabled`, true);

      const handler = () => {

        if (def.conditional && this.shouldSkipCheckIn()) {
          olog(`${def.wakeType} — skipped (user active)`);
          return;
        }
        this.handleWake(def.wakeType, { freshSession: def.freshSession });
      };

      const task = new ScheduledTask(cronExpr, { timezone, paused: !enabled }, handler);

      if (!enabled) {
        olog(`  ${def.wakeType}: DISABLED (persisted)`);
      }

      this.tasks.set(def.wakeType, {
        task,
        cronExpr,
        handler,
        wakeType: def.wakeType,
        label: def.label,
        enabled,
        category: def.category,
      });
    }

    // --- Load custom routines from DB ---
    const customConfigs = getConfigsByPrefix('custom_routine.');
    const customRoutines = new Map<string, { label?: string; cronExpr?: string; prompt?: string }>();

    for (const [key, value] of Object.entries(customConfigs)) {
      const parts = key.split('.');
      if (parts.length !== 3) continue;
      const wakeType = parts[1];
      const field = parts[2];
      if (!customRoutines.has(wakeType)) customRoutines.set(wakeType, {});
      const entry = customRoutines.get(wakeType)!;
      if (field === 'label') entry.label = value;
      else if (field === 'cronExpr') entry.cronExpr = value;
      else if (field === 'prompt') entry.prompt = value;
    }

    for (const [wakeType, routineConfig] of customRoutines) {
      if (!routineConfig.label || !routineConfig.cronExpr || !routineConfig.prompt) {
        olog(`  custom routine ${wakeType}: incomplete config, skipping`);
        continue;
      }
      this.addRoutine({
        wakeType,
        label: routineConfig.label,
        cronExpr: routineConfig.cronExpr,
        prompt: routineConfig.prompt,
      });
    }

    // --- Failsafe polling (every 15 minutes) ---
    if (this.failsafeEnabled) {
      this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
    }

    // --- Timer + Trigger polling (every 60 seconds) ---
    this.timerInterval = setInterval(async () => {
      await this.checkTimers();
      await this.checkTriggers();
    }, 60 * 1000);

    olog('All schedules registered');
    const checkinNames = taskDefs.map(d => d.wakeType).join(', ');
    olog(`Check-ins: ${checkinNames}`);
    olog(`Failsafe: ${this.failsafeEnabled ? 'every 15 minutes' : 'DISABLED'}`);
    olog(`Failsafe thresholds: gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
    // --- Pulse (lightweight awareness check) ---
    if (this.pulseEnabled) {
      this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
    }

    // --- Scribe digest (every 30 minutes) ---
    const digestEnabled = getConfigBool('digest.enabled', true);
    if (digestEnabled) {
      this.digestInterval = setInterval(() => {
        runDigest(this.agent).catch(err => olog(`Digest error: ${err.message}`));
      }, 30 * 60 * 1000);
    }

    olog('Timers + Triggers: polling every 60s');
    olog(`Pulse: ${this.pulseEnabled ? `every ${this.pulseFrequency}m` : 'DISABLED'}`);
    olog(`Scribe digest: ${digestEnabled ? 'every 30m' : 'DISABLED'}`);
  }

  stop(): void {
    olog('Stopping...');

    // Cancel any in-flight autonomous agent processing
    if (this.agent?.isProcessing?.()) {
      this.agent.stopGeneration?.();
    }

    for (const [, managed] of this.tasks) {
      managed.task.stop();
    }
    this.tasks.clear();
    if (this.failsafeInterval) {
      clearInterval(this.failsafeInterval);
      this.failsafeInterval = null;
    }
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (this.pulseInterval) {
      clearInterval(this.pulseInterval);
      this.pulseInterval = null;
    }
    if (this.digestInterval) {
      clearInterval(this.digestInterval);
      this.digestInterval = null;
    }
  }

  // --- Public runtime control methods ---

  async getStatus(): Promise<OrchestratorTaskStatus[]> {
    const statuses: OrchestratorTaskStatus[] = [];

    for (const [, managed] of this.tasks) {
      let status: 'scheduled' | 'stopped' | 'running' = 'stopped';
      let nextRun: string | null = null;

      if (managed.task.isStopped()) {
        status = 'stopped';
      } else if (managed.task.isBusy()) {
        status = 'running';
      } else {
        status = managed.enabled ? 'scheduled' : 'stopped';
      }

      const next = managed.task.nextRun();
      if (next) nextRun = next.toISOString();

      statuses.push({
        wakeType: managed.wakeType,
        // Derive the time prefix from the CURRENT cron so reschedules
        // don't cause label drift (label was hardcoded at registration
        // and never updated when the cron was overridden via config).
        label: deriveLabelFromCron(managed.label, managed.cronExpr),
        cronExpr: managed.cronExpr,
        enabled: managed.enabled,
        status,
        nextRun,
        category: managed.category,
      });
    }

    return statuses;
  }

  enableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.resume();
    managed.enabled = true;
    setConfig(`cron.${wakeType}.enabled`, 'true');
    olog(`ENABLED: ${wakeType}`);
    return true;
  }

  disableTask(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    managed.task.pause();
    managed.enabled = false;
    setConfig(`cron.${wakeType}.enabled`, 'false');
    olog(`DISABLED: ${wakeType}`);
    return true;
  }

  rescheduleTask(wakeType: string, newCronExpr: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    if (!isValidCron(newCronExpr)) {
      olog(`RESCHEDULE FAILED: ${wakeType} — invalid cron expression: ${newCronExpr}`);
      return false;
    }

    const config = getResonantConfig();

    // Destroy old task and create new one
    managed.task.stop();

    const newTask = new ScheduledTask(newCronExpr, { timezone: config.identity.timezone, paused: !managed.enabled }, managed.handler);

    managed.task = newTask;
    managed.cronExpr = newCronExpr;
    setConfig(`cron.${wakeType}.schedule`, newCronExpr);
    olog(`RESCHEDULED: ${wakeType} -> ${newCronExpr}`);
    return true;
  }

  getFailsafeConfig(): { enabled: boolean; gentle: number; concerned: number; emergency: number } {
    return {
      enabled: this.failsafeEnabled,
      gentle: this.failsafeGentle,
      concerned: this.failsafeConcerned,
      emergency: this.failsafeEmergency,
    };
  }

  setFailsafeConfig(config: { enabled?: boolean; gentle?: number; concerned?: number; emergency?: number }): void {
    if (config.enabled !== undefined) {
      this.failsafeEnabled = config.enabled;
      setConfig('failsafe.enabled', String(config.enabled));

      // Start or stop failsafe interval
      if (config.enabled && !this.failsafeInterval) {
        this.failsafeInterval = setInterval(() => this.checkFailsafe(), 15 * 60 * 1000);
        olog('Failsafe ENABLED');
      } else if (!config.enabled && this.failsafeInterval) {
        clearInterval(this.failsafeInterval);
        this.failsafeInterval = null;
        olog('Failsafe DISABLED');
      }
    }

    if (config.gentle !== undefined) {
      this.failsafeGentle = config.gentle;
      setConfig('failsafe.gentle', String(config.gentle));
    }
    if (config.concerned !== undefined) {
      this.failsafeConcerned = config.concerned;
      setConfig('failsafe.concerned', String(config.concerned));
    }
    if (config.emergency !== undefined) {
      this.failsafeEmergency = config.emergency;
      setConfig('failsafe.emergency', String(config.emergency));
    }

    olog(`Failsafe config updated: enabled=${this.failsafeEnabled}, gentle=${this.failsafeGentle}m, concerned=${this.failsafeConcerned}m, emergency=${this.failsafeEmergency}m`);
  }

  // --- Custom routine management ---

  addRoutine(params: {
    wakeType: string;
    label: string;
    cronExpr: string;
    prompt: string;
  }): boolean {
    if (this.tasks.has(params.wakeType)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — already exists`);
      return false;
    }

    if (!isValidCron(params.cronExpr)) {
      olog(`ADD ROUTINE FAILED: ${params.wakeType} — invalid cron: ${params.cronExpr}`);
      return false;
    }

    const config = getResonantConfig();
    const handler = () => {
      this.handleWake(params.wakeType);
    };

    const task = new ScheduledTask(params.cronExpr, { timezone: config.identity.timezone }, handler);

    this.tasks.set(params.wakeType, {
      task,
      cronExpr: params.cronExpr,
      handler,
      wakeType: params.wakeType,
      label: params.label,
      enabled: true,
      category: 'routine',
    });

    // Persist to DB
    setConfig(`custom_routine.${params.wakeType}.label`, params.label);
    setConfig(`custom_routine.${params.wakeType}.cronExpr`, params.cronExpr);
    setConfig(`custom_routine.${params.wakeType}.prompt`, params.prompt);

    olog(`ROUTINE ADDED: ${params.wakeType} (${params.cronExpr}) — "${params.label}"`);
    return true;
  }

  removeRoutine(wakeType: string): boolean {
    const managed = this.tasks.get(wakeType);
    if (!managed) return false;

    // Only allow removal of custom routines, not defaults
    const isDefault = DEFAULT_TASKS.some(t => t.wakeType === wakeType);
    if (isDefault) {
      olog(`REMOVE ROUTINE FAILED: ${wakeType} — cannot remove default task (use disable instead)`);
      return false;
    }

    managed.task.stop();
    this.tasks.delete(wakeType);

    deleteConfig(`custom_routine.${wakeType}.label`);
    deleteConfig(`custom_routine.${wakeType}.cronExpr`);
    deleteConfig(`custom_routine.${wakeType}.prompt`);
    deleteConfig(`cron.${wakeType}.schedule`);
    deleteConfig(`cron.${wakeType}.enabled`);

    olog(`ROUTINE REMOVED: ${wakeType}`);
    return true;
  }

  // --- Pulse config ---

  getPulseConfig(): { enabled: boolean; frequency: number; model: string } {
    // Pulse model surfaces the same DB > YAML > default cascade as
    // agent.ts uses at query time, so the Orchestrator panel's pulse
    // dropdown shows the value that's actually in effect.
    return {
      enabled: this.pulseEnabled,
      frequency: this.pulseFrequency,
      model: resolveConfiguredAgentModel('pulse'),
    };
  }

  setPulseConfig(config: { enabled?: boolean; frequency?: number; model?: string }): void {
    if (config.enabled !== undefined) {
      this.pulseEnabled = config.enabled;
      setConfig('pulse.enabled', String(config.enabled));

      if (config.enabled && !this.pulseInterval) {
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
        olog('Pulse ENABLED');
      } else if (!config.enabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = null;
        olog('Pulse DISABLED');
      }
    }

    if (config.frequency !== undefined && config.frequency >= 5) {
      this.pulseFrequency = config.frequency;
      setConfig('pulse.frequency', String(config.frequency));

      if (this.pulseEnabled && this.pulseInterval) {
        clearInterval(this.pulseInterval);
        this.pulseInterval = setInterval(() => this.checkPulse(), this.pulseFrequency * 60 * 1000);
      }
    }

    // PR #10: pulse model selector. Writes to DB so the agent.ts
    // resolveConfiguredAgentModel('pulse') cascade picks it up on the
    // next pulse turn. Empty string clears the override (returns to
    // YAML/default fallback). Validation happens at the route layer.
    if (config.model !== undefined) {
      const trimmed = config.model.trim();
      if (trimmed) {
        setConfig('agent.model_pulse', trimmed);
      } else {
        deleteConfig('agent.model_pulse');
      }
    }

    olog(`Pulse config updated: enabled=${this.pulseEnabled}, frequency=${this.pulseFrequency}m, model=${resolveConfiguredAgentModel('pulse')}`);
  }

  // --- Pulse: lightweight awareness check ---

  private async checkPulse(): Promise<void> {
    const now = new Date();
    // Sovereignty: route pulse's hour gate AND its prompt-embedded
    // local-time string through services/time.ts. Date#getHours and
    // toLocaleTimeString without the timezone option both rely on the
    // process's wall clock / Intl, which can disagree with the user's
    // identity timezone (the same class of bug fixed for cron firing).
    const timezone = getResonantConfig().identity.timezone;
    const hour = tzLocalHour(timezone, now);

    // Coalesce gate skips: log once per state-transition, stay silent on
    // repeat skips of the same reason. Caller passes a stable `key` per
    // gate so e.g. `idle 5m` and `idle 10m` count as the same state.
    const skip = (key: string, message: string): void => {
      if (key !== this.lastPulseSkipKey) {
        olog(message);
        this.lastPulseSkipKey = key;
      }
    };

    if (hour < 8) {
      skip('hour', `Pulse skipped: local hour ${hour} < 8 (sleep window)`);
      return;
    }
    if (this.agent.isProcessing()) {
      skip('busy', 'Pulse skipped: agent busy');
      return;
    }
    if (registry.getUserPresenceState() === 'active') {
      skip('presence', 'Pulse skipped: presence active');
      return;
    }
    // Recency gate: pulse window is every 15 min; if the user was active
    // within the last 15 minutes, state hasn't materially changed since
    // the previous tick and there's nothing for the model to react to.
    const idleMins = Math.round(registry.minutesSinceLastUserActivity());
    if (idleMins < 15) {
      skip('idle', `Pulse skipped: idle ${idleMins}m < 15m`);
      return;
    }

    // All gates passed — pulse will fire. Reset so the next skip cycle
    // logs once on entry instead of staying silent because we happened
    // to last skip with the same reason.
    this.lastPulseSkipKey = null;

    const presence = registry.getUserPresenceState();
    const minutesSince = Math.round(registry.minutesSinceLastUserActivity());
    const device = registry.getUserDeviceType();
    const localTime = localTimeStr(timezone, now);
    const triggers = getActiveTriggers();

    const pulsePrompt = [
      'Heartbeat check. Default outcome is silence.',
      '',
      `State: User ${presence}, last active ${minutesSince}min ago. Device ${device}.`,
      `Time: ${localTime}. Active triggers: ${triggers.length}.`,
      '',
      'Output the literal token PULSE_OK on its own line — nothing else — UNLESS',
      'there is a specific, concrete reason to interrupt right now (a missed',
      'timer firing, a watcher condition met, a routine she explicitly asked for',
      'at this hour). A vague urge to check in, greet, or acknowledge is NOT a',
      'reason. You were already present in this thread today; this is not a',
      'greeting opportunity.',
      '',
      'If you do reach out, the first line must name the concrete reason',
      "(e.g. \"Timer 'tea' just fired\" / \"Watcher 'mood-low + idle 90min' met\").",
    ].join('\n');

    try {
      let thread = getTodayThread();
      if (!thread) return;

      const response = await this.agent.processAutonomous(thread.id, pulsePrompt, {
        suppressIf: isSuppressiblePulseResponse,
        streamToClient: false,
        suppressedLogLabel: 'PULSE suppressed',
        orientationMode: 'pulse',
      });

      // The agent layer already suppressed persist/push for soft-ack
      // responses; we just need to skip the activity bump so a quiet pulse
      // doesn't move the thread's last-activity timestamp.
      if (isSuppressiblePulseResponse(response)) return;

      updateThreadActivity(thread.id, new Date().toISOString(), true);
      olog(`PULSE: responded (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`PULSE ERROR: ${errMsg}`);
    }
  }

  // --- Public manual wake (called from /wake command) ---

  async triggerManualWake(wakeType = 'manual'): Promise<void> {
    await this.handleWake(wakeType);
  }

  // --- Core wake handler ---

  private async handleWake(
    wakeType: string,
    opts?: { freshSession?: boolean }
  ): Promise<void> {
    const prompt = this.wakePrompts[wakeType] || getConfig(`custom_routine.${wakeType}.prompt`);
    if (!prompt) {
      olog(`ERROR: Unknown wake type: ${wakeType}`);
      return;
    }

    // Don't fire if agent is already processing a query
    if (this.agent.isProcessing()) {
      olog(`${wakeType} — skipped (agent busy)`);
      return;
    }

    olog(`WAKE: ${wakeType}`);

    try {
      // Get or create today's daily thread
      let thread = getTodayThread();

      if (!thread) {
        // Create new daily thread (only when none exists for today)
        const now = new Date();
        // Sovereignty: route through time.ts — Node's ICU can lag IANA
        // so a toLocaleDateString with {timeZone} would drift for zones
        // Node hasn't shipped updated tzdata for.
        const dayName = localDateStr(getResonantConfig().identity.timezone, now);

        thread = createThread({
          id: crypto.randomUUID(),
          name: dayName,
          type: 'daily',
          createdAt: now.toISOString(),
          sessionType: 'v1',
        });

        // Broadcast new thread to connected clients
        registry.broadcast({ type: 'thread_created', thread });
        olog(`Created daily thread: ${thread.name} (${thread.id})`);
      }

      // Fresh session: clear session on existing thread (don't create duplicate)
      if (opts?.freshSession) {
        updateThreadSession(thread.id, null);
      }

      // Run digest before wake so orientation context has freshest data
      try {
        await runDigest(this.agent);
      } catch (err) {
        olog(`Pre-wake digest skipped: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Recency header: give the companion a signal about how recent
      // the last real exchange was so scheduled wakes stop producing
      // fresh "good morning" entrances 4 minutes after actual talks.
      // Empty for brand-new threads — the canned prompt runs unchanged.
      const lastMsg = getLastConversationalMessage(thread.id);
      const recencyHeader = buildRecencyHeader(lastMsg);
      const fullPrompt = recencyHeader + prompt;

      // Fire the autonomous query
      const response = await this.agent.processAutonomous(thread.id, fullPrompt);

      // Update thread activity
      updateThreadActivity(thread.id, new Date().toISOString(), true);

      olog(`DONE: ${wakeType} (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`ERROR: ${wakeType} failed — ${errMsg}`);
    }
  }

  // --- Failsafe ---

  private checkFailsafe(): void {
    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const now = new Date();
    // Sovereignty layer: Node's ICU can lag IANA; route through time.ts.
    const hour = tzLocalHour(timezone, now);

    // Only check during waking hours (8am - midnight)
    if (hour < 8) return;

    // Only skip if user is genuinely active (tab focused + recent real interaction)
    if (registry.getUserPresenceState() === 'active') return;

    const minutesSince = registry.minutesSinceLastUserActivity();

    // Helper to check per-severity cooldown
    const canFire = (severity: string): boolean => {
      const last = this.lastFailsafeActions[severity];
      const cooldown = this.FAILSAFE_COOLDOWNS[severity];
      if (!last || !cooldown) return true;
      return (now.getTime() - last.getTime()) >= cooldown;
    };

    // Tiered escalation using configurable thresholds and per-severity cooldowns
    if (minutesSince > this.failsafeEmergency && canFire('emergency')) {
      // 24+ hours — emergency
      olog(`FAILSAFE EMERGENCY — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeActions.emergency = now;
      this.handleWake('failsafe_emergency');
    } else if (minutesSince > this.failsafeConcerned && canFire('concerned')) {
      // 12+ hours — concerned
      olog(`FAILSAFE CONCERNED — ${Math.round(minutesSince / 60)}h since contact`);
      this.lastFailsafeActions.concerned = now;
      this.handleWake('failsafe_concerned');
    } else if (minutesSince > this.failsafeGentle && canFire('gentle')) {
      // 2+ hours — gentle check-in
      olog(`FAILSAFE gentle — ${Math.round(minutesSince)}min since contact`);
      this.lastFailsafeActions.gentle = now;
      this.handleWake('failsafe_gentle');
    }
  }

  // --- Timer polling ---

  private async checkTimers(): Promise<void> {
    const now = new Date().toISOString();
    const dueTimers = getDueTimers(now);

    for (const timer of dueTimers) {
      try {
        markTimerFired(timer.id, now);

        // Build reminder message
        let content = `**Reminder: ${timer.label}**`;
        if (timer.context) {
          content += `\n_Context: ${timer.context}_`;
        }

        // Post reminder as companion message
        const message = createMessage({
          id: crypto.randomUUID(),
          threadId: timer.thread_id,
          role: 'companion',
          content,
          metadata: { source: 'timer', timerId: timer.id },
          createdAt: now,
        });

        updateThreadActivity(timer.thread_id, now, true);
        registry.broadcast({ type: 'message', message });

        // Push notification for timers — always send (time-critical)
        if (this.pushService) {
          this.pushService.sendAlways({
            title: 'Reminder',
            body: timer.label,
            threadId: timer.thread_id,
            tag: `timer-${timer.id}`,
            url: '/chat',
          }).catch(err => console.error('Timer push error:', err));
        }

        olog(`TIMER FIRED: "${timer.label}" in thread ${timer.thread_id}`);

        // If prompt provided, fire autonomous wake
        if (timer.prompt) {
          if (this.agent.isProcessing()) {
            olog(`TIMER: autonomous prompt skipped (agent busy) for "${timer.label}"`);
          } else {
            const fullPrompt = `Timer reminder just fired: "${timer.label}"${timer.context ? ` (context: ${timer.context})` : ''}.\n\n${timer.prompt}`;
            this.agent.processAutonomous(timer.thread_id, fullPrompt).catch(err => {
              olog(`TIMER ERROR: autonomous prompt failed for "${timer.label}" — ${err.message || err}`);
            });
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TIMER ERROR: "${timer.label}" — ${errMsg}`);
      }
    }
  }

  // --- Trigger evaluation ---

  private async checkTriggers(): Promise<void> {
    const config = getResonantConfig();
    const timezone = config.identity.timezone;
    const triggers = getActiveTriggers();
    if (triggers.length === 0) return;

    const now = new Date();
    const presenceNow = registry.getUserPresenceState();
    const agentFree = !this.agent.isProcessing();

    // Local time in configured timezone (sovereignty layer, not Node ICU).
    const localHour = tzLocalHour(timezone, now);
    const localMinute = tzLocalMinute(timezone, now);

    // Lazy-fetch status only if any trigger needs it. One malformed
    // conditions row must NOT prevent every other valid trigger from
    // evaluating this tick — wrap the parse per row so a bad row is
    // logged and skipped instead of throwing out of the .some() loop.
    let statusText = '';
    const needsStatus = triggers.some(t => {
      try {
        const conditions: TriggerCondition[] = JSON.parse(t.conditions);
        return conditions.some(c => c.type === 'routine_missing');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        olog(`TRIGGER PARSE ERROR (needsStatus check): "${t.label ?? t.id}" — ${errMsg}`);
        return false;
      }
    });
    if (needsStatus) {
      statusText = await fetchLifeStatus();
    }

    const ctx: TriggerContext = {
      presenceNow,
      presencePrev: this.lastUserPresenceState,
      agentFree,
      statusText,
      hour: localHour,
      minute: localMinute,
    };

    for (const trigger of triggers) {
      try {
        if (trigger.status === 'waiting') {
          // Waiting triggers: conditions already met, just need agent free
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          }
          continue;
        }

        // Pending triggers: evaluate conditions
        const conditions: TriggerCondition[] = JSON.parse(trigger.conditions);

        // Watchers: check cooldown
        if (trigger.kind === 'watcher' && trigger.last_fired_at) {
          const lastFired = new Date(trigger.last_fired_at).getTime();
          const cooldownMs = (trigger.cooldown_minutes || 120) * 60 * 1000;
          if (now.getTime() - lastFired < cooldownMs) continue;
        }

        if (evaluateConditions(conditions, ctx)) {
          if (agentFree) {
            await this.fireTrigger(trigger, now);
          } else {
            // Conditions met but agent busy — mark waiting (impulses only)
            if (trigger.kind === 'impulse') {
              markTriggerWaiting(trigger.id);
              olog(`TRIGGER WAITING: "${trigger.label}" (agent busy)`);
            }
            // Watchers just skip this tick — they'll re-evaluate next time
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        olog(`TRIGGER ERROR: "${trigger.label}" — ${errMsg}`);
      }
    }

    // Update presence state at end of tick
    this.lastUserPresenceState = presenceNow;
  }

  private async fireTrigger(trigger: Trigger, now: Date): Promise<void> {
    const nowIso = now.toISOString();

    // Update DB first
    if (trigger.kind === 'impulse') {
      markTriggerFired(trigger.id, nowIso);
    } else {
      markWatcherFired(trigger.id, nowIso);
    }

    const kindLabel = trigger.kind === 'impulse' ? 'Impulse' : 'Watcher';
    olog(`TRIGGER FIRED: [${kindLabel}] "${trigger.label}" (fire_count: ${trigger.fire_count + 1})`);

    // If no prompt, just log
    if (!trigger.prompt) return;

    try {
      // Get or create today's thread (use trigger's thread_id if specified,
      // but redirect stale daily threads to today's — daily threads rotate)
      let threadId = trigger.thread_id;
      if (threadId) {
        const triggerThread = getThread(threadId);
        if (triggerThread?.type === 'daily') {
          const today = getTodayThread();
          if (today && today.id !== threadId) {
            olog(`TRIGGER: redirecting from stale daily thread "${triggerThread.name}" to today's`);
            threadId = today.id;
          }
        }
      }
      if (!threadId) {
        let thread = getTodayThread();
        if (!thread) {
          // Sovereignty: same reason as the other wake path above.
          const dayName = localDateStr(getResonantConfig().identity.timezone, now);
          thread = createThread({
            id: crypto.randomUUID(),
            name: dayName,
            type: 'daily',
            createdAt: nowIso,
            sessionType: 'v1',
          });
          registry.broadcast({ type: 'thread_created', thread });
          olog(`Created daily thread: ${thread.name} (${thread.id})`);
        }
        threadId = thread.id;
      }

      const fullPrompt = `${kindLabel}: "${trigger.label}"\n\n${trigger.prompt}`;
      const response = await this.agent.processAutonomous(threadId!, fullPrompt);
      updateThreadActivity(threadId!, nowIso, true);
      olog(`TRIGGER DONE: "${trigger.label}" (${response.length} chars)`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      olog(`TRIGGER FIRE ERROR: "${trigger.label}" — ${errMsg}`);
    }
  }

  // --- Helpers ---

  private shouldSkipCheckIn(): boolean {
    // Skip only if agent is currently processing (we're already mid-conversation)
    // Decision-point wakes handle user presence state in their own prompts —
    // the companion reads the room and decides whether to reach out or do its own thing
    return this.agent.isProcessing();
  }
}
