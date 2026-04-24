import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduledTask } from './scheduler.js';

describe('ScheduledTask', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin wall-clock so cronNextFireTime is deterministic across tests.
    // 07:30 UTC on 24 Apr 2026 = 04:30 Asunción (UTC−3).
    vi.setSystemTime(new Date('2026-04-24T07:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects unsupported cron expressions at construction', () => {
    // Step-within-range (0-10/2) and malformed strings go through the
    // isCronSupported validator in the constructor.
    expect(
      () => new ScheduledTask('1-5/2 * * * *', { timezone: 'UTC' }, () => {}),
    ).toThrow(/unsupported cron expression/);
    expect(
      () => new ScheduledTask('garbage', { timezone: 'UTC' }, () => {}),
    ).toThrow(/unsupported cron expression/);
  });

  it('computes the first nextRun immediately when not paused', () => {
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, () => {});
    // 8 AM Asunción today = 11:00 UTC
    expect(task.nextRun()?.toISOString()).toBe('2026-04-24T11:00:00.000Z');
    task.stop();
  });

  it('does not schedule when constructed paused, and resume()s later', () => {
    const handler = vi.fn();
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion', paused: true }, handler);
    expect(task.nextRun()).toBeNull();

    task.resume();
    expect(task.nextRun()?.toISOString()).toBe('2026-04-24T11:00:00.000Z');
    task.stop();
  });

  it('fires the handler when the scheduled time is reached', async () => {
    const handler = vi.fn();
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, handler);

    // Advance to just past fire time
    await vi.advanceTimersByTimeAsync(3.5 * 60 * 60 * 1000 + 1_000); // +3.5h past start
    expect(handler).toHaveBeenCalledTimes(1);

    // Next fire should be tomorrow's 8 AM local = next day 11:00 UTC
    expect(task.nextRun()?.toISOString()).toBe('2026-04-25T11:00:00.000Z');
    task.stop();
  });

  it('stop() cancels the timer and sets isStopped()', () => {
    const handler = vi.fn();
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, handler);
    task.stop();
    expect(task.isStopped()).toBe(true);
    expect(task.nextRun()).toBeNull();

    // Fast-forward well past fire time — handler should not run
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it('pause() prevents firing but allows resume()', async () => {
    const handler = vi.fn();
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, handler);
    task.pause();
    expect(task.nextRun()).toBeNull();

    // Advance past the would-be fire — handler still shouldn't run
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    expect(handler).not.toHaveBeenCalled();

    // Resume — should schedule the NEXT fire from current time
    task.resume();
    expect(task.nextRun()?.toISOString()).toBe('2026-04-25T11:00:00.000Z');
    task.stop();
  });

  it('swallows handler errors so the schedule continues', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, handler);

    await vi.advanceTimersByTimeAsync(3.5 * 60 * 60 * 1000 + 1_000);
    expect(handler).toHaveBeenCalledTimes(1);
    // Next fire still scheduled despite the error
    expect(task.nextRun()?.toISOString()).toBe('2026-04-25T11:00:00.000Z');

    task.stop();
    consoleSpy.mockRestore();
  });

  // Regression for the reported bug: a Paraguay user sees "morning wake
  // didn't fire at 8 AM" because croner + Node ICU schedule it for 12:00
  // UTC (Node thinks Asunción is UTC−4). moment-tz correctly places 8 AM
  // Asunción at 11:00 UTC. This test pins the sovereignty-aware result.
  it('REGRESSION: schedules Paraguay morning wakes at 11:00 UTC, not 12:00 UTC', () => {
    const task = new ScheduledTask('0 8 * * *', { timezone: 'America/Asuncion' }, () => {});
    expect(task.nextRun()?.toISOString()).toBe('2026-04-24T11:00:00.000Z');
    expect(task.nextRun()?.toISOString()).not.toBe('2026-04-24T12:00:00.000Z');
    task.stop();
  });
});
