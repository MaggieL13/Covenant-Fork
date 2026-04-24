/**
 * Sovereignty-aware cron scheduler.
 *
 * External libraries (croner etc.) use Node's Intl to resolve cron
 * timezones, which inherits the same stale-tzdata problem that made us
 * adopt moment-timezone for display strings. A `0 8 * * *` cron in
 * America/Asuncion under croner fires at 9 AM local wall-clock on Node
 * builds whose ICU still thinks Asunción is UTC−4.
 *
 * ScheduledTask replaces the subset of the croner API we use with a thin
 * setTimeout-based scheduler that asks services/time.ts to compute the
 * next fire time via moment-timezone. Every fire recomputes from current
 * tzdata, so DST transitions and IANA updates flow through automatically.
 *
 * API surface deliberately mirrors croner's Cron for drop-in migration:
 *   new ScheduledTask(cronExpr, { timezone, paused }, handler)
 *   .stop()     — permanent cancel; isStopped() returns true after
 *   .pause()    — temporary; resume() to restart
 *   .resume()   — recompute next-fire and schedule
 *   .nextRun()  — Date | null
 *   .isBusy()   — handler currently executing
 *   .isStopped()
 */
import { cronNextFireTime, isCronSupported } from './time.js';

export interface ScheduledTaskOptions {
  timezone: string;
  /** If true, task is created in a paused state and must be resume()d to run. */
  paused?: boolean;
}

export class ScheduledTask {
  private readonly cronExpr: string;
  private readonly timezone: string;
  private readonly handler: () => void | Promise<void>;

  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private nextFire: Date | null = null;
  private paused: boolean;
  private stopped = false;
  private busy = false;

  constructor(
    cronExpr: string,
    options: ScheduledTaskOptions,
    handler: () => void | Promise<void>,
  ) {
    if (!isCronSupported(cronExpr)) {
      throw new Error(
        `ScheduledTask: unsupported cron expression: "${cronExpr}". ` +
          `Supported fields are fixed integers, wildcards (*), and step values (*/N).`,
      );
    }
    this.cronExpr = cronExpr;
    this.timezone = options.timezone;
    this.handler = handler;
    this.paused = options.paused ?? false;

    if (!this.paused) {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopped || this.paused) return;
    this.clearPending();

    const next = cronNextFireTime(this.cronExpr, this.timezone);
    if (!next) {
      // Unexpected — cron was validated in the constructor. Fail safe:
      // stay un-scheduled rather than fire at a wrong time.
      this.nextFire = null;
      return;
    }

    this.nextFire = next;
    const delay = Math.max(0, next.getTime() - Date.now());
    this.timeoutHandle = setTimeout(() => {
      this.timeoutHandle = null;
      void this.fire();
    }, delay);
  }

  private async fire(): Promise<void> {
    if (this.stopped || this.paused) return;
    this.busy = true;
    try {
      await this.handler();
    } catch (err) {
      // Match croner's behavior: swallow handler errors so the schedule
      // continues. Callers are responsible for their own logging.
      console.error('[ScheduledTask] handler error:', err);
    } finally {
      this.busy = false;
      // Recompute next fire from current moment — handles DST transitions
      // and wall-clock drift naturally.
      this.scheduleNext();
    }
  }

  private clearPending(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.paused = true;
    this.clearPending();
    this.nextFire = null;
  }

  pause(): void {
    if (this.stopped) return;
    this.paused = true;
    this.clearPending();
    this.nextFire = null;
  }

  resume(): void {
    if (this.stopped) return;
    if (!this.paused) return;
    this.paused = false;
    this.scheduleNext();
  }

  nextRun(): Date | null {
    return this.nextFire;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  isBusy(): boolean {
    return this.busy;
  }
}
