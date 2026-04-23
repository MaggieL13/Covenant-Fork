import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock heavy dependencies to avoid side effects
vi.mock('./agent.js', () => ({ AgentService: vi.fn() }));
vi.mock('./push.js', () => ({}));
vi.mock('./registry.js', () => ({ registry: { getCount: vi.fn().mockReturnValue(0) } }));
vi.mock('./db.js', () => ({
  getConfigBool: vi.fn().mockReturnValue(true),
  getConfigNumber: vi.fn().mockReturnValue(120),
  getConfig: vi.fn().mockReturnValue(null),
}));
vi.mock('./life-status.js', () => ({ fetchLifeStatus: vi.fn().mockResolvedValue('') }));
vi.mock('./triggers.js', () => ({ evaluateConditions: vi.fn().mockReturnValue(true) }));
vi.mock('./digest.js', () => ({ runDigest: vi.fn() }));
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    orchestrator: {
      enabled: true,
      wake_prompts_path: '/nonexistent/wake.md',
      schedules: {},
      failsafe: { enabled: true, gentle_minutes: 120, concerned_minutes: 720, emergency_minutes: 1440 },
    },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import { isValidCron, parseWakePromptsFile, DEFAULT_TASKS } from './orchestrator.js';

describe('isValidCron', () => {
  it('accepts standard cron expressions', () => {
    expect(isValidCron('0 8 * * *')).toBe(true);     // daily at 8am
    expect(isValidCron('*/15 * * * *')).toBe(true);   // every 15 min
    expect(isValidCron('0 0 1 * *')).toBe(true);      // first of month
    expect(isValidCron('0 13 * * 1-5')).toBe(true);   // weekdays at 1pm
  });

  it('rejects invalid cron expressions', () => {
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('* * * *')).toBe(false);        // too few fields
    expect(isValidCron('60 * * * *')).toBe(false);     // 60 minutes invalid
  });

  it('accepts 6-field cron (with seconds)', () => {
    expect(isValidCron('0 0 8 * * *')).toBe(true);
  });
});

describe('parseWakePromptsFile', () => {
  const tmpDir = join(tmpdir(), 'resonant-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  it('returns defaults when file does not exist', () => {
    const result = parseWakePromptsFile('/nonexistent/wake.md', 'Mary');
    expect(result.morning).toContain('Mary');
    expect(result.midday).toContain('Mary');
    expect(result.evening).toBeDefined();
    expect(result.failsafe_gentle).toBeDefined();
    expect(result.failsafe_concerned).toBeDefined();
    expect(result.failsafe_emergency).toBeDefined();
  });

  it('parses a valid wake prompts file', () => {
    const filePath = join(tmpDir, 'wake.md');
    writeFileSync(filePath, `## morning
Rise and shine, custom morning prompt.

## evening
Custom evening wind-down.

## custom_section
A completely custom wake type.
`);

    const result = parseWakePromptsFile(filePath, 'Mary');
    expect(result.morning).toBe('Rise and shine, custom morning prompt.');
    expect(result.evening).toBe('Custom evening wind-down.');
    expect(result.custom_section).toBe('A completely custom wake type.');
    // Defaults still present for missing sections
    expect(result.midday).toContain('Mary');
    expect(result.failsafe_gentle).toBeDefined();
  });

  it('returns defaults for malformed file', () => {
    const filePath = join(tmpDir, 'bad.md');
    // File with no ## sections at all
    writeFileSync(filePath, 'Just some text without sections\nMore text\n');

    const result = parseWakePromptsFile(filePath, 'User');
    // Should return defaults since no sections were parsed
    expect(result.morning).toContain('User');
    expect(result.evening).toBeDefined();
  });

  it('handles empty sections gracefully', () => {
    const filePath = join(tmpDir, 'empty.md');
    writeFileSync(filePath, `## morning

## evening
Has content here.
`);

    const result = parseWakePromptsFile(filePath, 'User');
    expect(result.morning).toBe('');
    expect(result.evening).toBe('Has content here.');
  });
});

describe('DEFAULT_TASKS', () => {
  it('has valid structure', () => {
    expect(DEFAULT_TASKS.length).toBeGreaterThan(0);

    for (const task of DEFAULT_TASKS) {
      expect(task.wakeType).toBeTruthy();
      expect(task.label).toBeTruthy();
      expect(task.cronExpr).toBeTruthy();
      expect(['wake', 'checkin', 'handoff', 'failsafe', 'routine']).toContain(task.category);
      expect(isValidCron(task.cronExpr)).toBe(true);
    }
  });

  it('includes the three core check-ins', () => {
    const wakeTypes = DEFAULT_TASKS.map(t => t.wakeType);
    expect(wakeTypes).toContain('morning');
    expect(wakeTypes).toContain('midday');
    expect(wakeTypes).toContain('evening');
  });
});

// Regression: the hardcoded DEFAULT_TASKS labels carry a time prefix
// like "9:00 PM — Evening", but the cron for any task can be overridden
// via config. Before this fix, the label stayed frozen at the default
// time even when the cron changed, so the UI showed "9:00 PM — Evening"
// with the actual schedule "19:00" underneath (labels drifted from
// reality). The fix derives the time prefix from the current cron at
// response time.
describe('cronToTimeLabel', async () => {
  const { cronToTimeLabel } = await import('./orchestrator.js');

  it('formats simple fixed minute+hour crons to 12-hour clock labels', () => {
    expect(cronToTimeLabel('0 8 * * *')).toBe('8:00 AM');
    expect(cronToTimeLabel('0 13 * * *')).toBe('1:00 PM');
    expect(cronToTimeLabel('0 19 * * *')).toBe('7:00 PM');
    expect(cronToTimeLabel('0 21 * * *')).toBe('9:00 PM');
    expect(cronToTimeLabel('50 23 * * *')).toBe('11:50 PM');
  });

  it('handles midnight and noon edge cases', () => {
    expect(cronToTimeLabel('0 0 * * *')).toBe('12:00 AM');
    expect(cronToTimeLabel('0 12 * * *')).toBe('12:00 PM');
    expect(cronToTimeLabel('30 0 * * *')).toBe('12:30 AM');
    expect(cronToTimeLabel('45 12 * * *')).toBe('12:45 PM');
  });

  it('pads single-digit minutes', () => {
    expect(cronToTimeLabel('5 9 * * *')).toBe('9:05 AM');
    expect(cronToTimeLabel('9 15 * * *')).toBe('3:09 PM');
  });

  it('returns null for non-simple cron expressions (caller falls back)', () => {
    expect(cronToTimeLabel('*/15 * * * *')).toBeNull();
    expect(cronToTimeLabel('0 */2 * * *')).toBeNull();
    expect(cronToTimeLabel('0 9-17 * * *')).toBeNull();
    expect(cronToTimeLabel('0 9,12,17 * * *')).toBeNull();
    expect(cronToTimeLabel('* * * * *')).toBeNull();
    expect(cronToTimeLabel('')).toBeNull();
    expect(cronToTimeLabel('garbage')).toBeNull();
  });

  it('returns null for out-of-range values', () => {
    expect(cronToTimeLabel('60 12 * * *')).toBeNull(); // minute > 59
    expect(cronToTimeLabel('0 24 * * *')).toBeNull(); // hour > 23
  });
});

describe('deriveLabelFromCron', async () => {
  const { deriveLabelFromCron } = await import('./orchestrator.js');

  it('replaces the time prefix while preserving the descriptive suffix', () => {
    // The actual bug Maggie reported: evening cron overridden to 19:00
    // but label stayed "9:00 PM — Evening".
    expect(deriveLabelFromCron('9:00 PM — Evening', '0 19 * * *')).toBe('7:00 PM — Evening');
    expect(deriveLabelFromCron('1:00 PM — Midday', '30 14 * * *')).toBe('2:30 PM — Midday');
  });

  it('handles default labels that already match their cron (no-op semantically)', () => {
    expect(deriveLabelFromCron('8:00 AM — Morning', '0 8 * * *')).toBe('8:00 AM — Morning');
    expect(deriveLabelFromCron('11:50 PM — Handoff', '50 23 * * *')).toBe('11:50 PM — Handoff');
  });

  it('falls back to the original label when the cron is not a simple fixed minute+hour', () => {
    expect(deriveLabelFromCron('Every 15 min — Pulse', '*/15 * * * *')).toBe('Every 15 min — Pulse');
  });

  it('handles labels without the em-dash separator', () => {
    // Rare but possible: pure-descriptive label without a time prefix.
    // The whole string becomes the suffix, and a derived time is prepended.
    expect(deriveLabelFromCron('Custom task', '0 10 * * *')).toBe('10:00 AM — Custom task');
  });
});
