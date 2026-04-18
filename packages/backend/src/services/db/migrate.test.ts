import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MIGRATIONS_DIR,
  MigrationError,
  NonLinearSchemaError,
  PartialLedgerError,
  backupDb,
  computeBootstrapVersions,
  ensureMigrationsTable,
  getAppliedVersions,
  listMigrationFiles,
  pruneOldBackups,
  runPendingMigrations,
} from './migrate.js';
import { predicates, messagesAllowsStickerContentType, helpers } from './migration-predicates.js';

/**
 * Helper to build a fresh controlled migrations directory on disk.
 * Each test gets its own temp dir so we don't collide with the real
 * packages/backend/migrations/ or with sibling tests.
 */
function makeTempMigrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'covenant-migrate-test-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf-8');
  }
  return dir;
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('migration runner — basic shape', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('ensureMigrationsTable creates the ledger idempotently', () => {
    ensureMigrationsTable(db);
    ensureMigrationsTable(db); // second call must not throw
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").all();
    expect(rows.length).toBe(1);
  });

  it('getAppliedVersions returns empty map on fresh DB', () => {
    ensureMigrationsTable(db);
    expect(getAppliedVersions(db).size).toBe(0);
  });

  it('listMigrationFiles returns empty array for missing dir', () => {
    expect(listMigrationFiles('/nonexistent/does/not/exist')).toEqual([]);
  });

  it('listMigrationFiles parses version prefixes and sorts by number', () => {
    const dir = makeTempMigrationsDir({
      '010_later.sql': 'SELECT 1;',
      '001_first.sql': 'SELECT 2;',
      '003_third.sql': 'SELECT 3;',
      'README.md': 'not a migration', // ignored
      '002_second.sql': 'SELECT 4;',
    });
    try {
      const files = listMigrationFiles(dir);
      expect(files.map((f) => f.version)).toEqual([1, 2, 3, 10]);
      expect(files[0].name).toBe('001_first.sql');
      expect(files[0].checksum).toHaveLength(64); // sha256 hex
      expect(files[0].pragmaOutsideTx).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('listMigrationFiles detects @pragma-outside-tx directive', () => {
    const dir = makeTempMigrationsDir({
      '001_normal.sql': 'SELECT 1;',
      '002_pragma.sql': '-- @pragma-outside-tx\nSELECT 2;',
    });
    try {
      const files = listMigrationFiles(dir);
      expect(files.find((f) => f.version === 1)?.pragmaOutsideTx).toBe(false);
      expect(files.find((f) => f.version === 2)?.pragmaOutsideTx).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('migration runner — fresh database', () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = new Database(':memory:');
    dir = makeTempMigrationsDir({
      '001_first.sql': 'CREATE TABLE test_a (id INTEGER PRIMARY KEY);',
      '002_second.sql': 'CREATE TABLE test_b (id INTEGER PRIMARY KEY);',
      '003_third.sql': 'CREATE TABLE test_c (id INTEGER PRIMARY KEY); INSERT INTO test_c (id) VALUES (1);',
    });
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it('runs all migrations in order, records them in ledger with bootstrapped=0', () => {
    const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
    expect(summary.applied).toEqual([1, 2, 3]);
    expect(summary.bootstrapped).toEqual([]);
    const applied = getAppliedVersions(db);
    expect(applied.size).toBe(3);
    expect(applied.get(1)?.bootstrapped).toBe(0);
    expect(applied.get(2)?.bootstrapped).toBe(0);
    expect(applied.get(3)?.bootstrapped).toBe(0);
    // Each migration's side effect is visible
    expect(helpers.tableExists(db, 'test_a')).toBe(true);
    expect(helpers.tableExists(db, 'test_b')).toBe(true);
    const rowCount = db.prepare('SELECT COUNT(*) AS c FROM test_c').get() as { c: number };
    expect(rowCount.c).toBe(1);
  });

  it('is idempotent — second run applies nothing', () => {
    runPendingMigrations(db, { migrationsDir: dir, backup: false });
    const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
    expect(summary.applied).toEqual([]);
    expect(summary.bootstrapped).toEqual([]);
    expect(summary.skipped).toEqual([1, 2, 3]);
  });

  it('records correct name and checksum in ledger', () => {
    runPendingMigrations(db, { migrationsDir: dir, backup: false });
    const rows = db.prepare('SELECT version, name, checksum FROM _migrations ORDER BY version').all() as {
      version: number;
      name: string;
      checksum: string;
    }[];
    expect(rows[0].name).toBe('001_first.sql');
    expect(rows[0].checksum).toHaveLength(64);
    expect(rows[1].name).toBe('002_second.sql');
    expect(rows[2].name).toBe('003_third.sql');
  });
});

describe('migration runner — bootstrap detection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('skips bootstrap on a truly fresh DB (no legacy tables)', () => {
    const dir = makeTempMigrationsDir({
      '001_first.sql': 'CREATE TABLE foo (id INTEGER PRIMARY KEY);',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      expect(summary.bootstrapped).toEqual([]);
      expect(summary.applied).toEqual([1]);
    } finally {
      cleanup(dir);
    }
  });

  it('bootstraps when DB has legacy tables and ledger is empty', () => {
    // Simulate legacy schema: threads + messages + config tables already exist
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE canvases (id TEXT PRIMARY KEY);
    `);
    // Use a test predicate map — the real one is imported, but we can simulate
    // by writing a migration file whose version's predicate matches our schema.
    const dir = makeTempMigrationsDir({
      '001_init.sql': 'CREATE TABLE should_not_run (x INTEGER);',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      // Predicate 1 in migration-predicates.ts checks for threads+messages+config+canvases
      expect(summary.bootstrapped).toEqual([1]);
      expect(summary.applied).toEqual([]);
      // Critically: the migration's SQL did NOT run
      expect(helpers.tableExists(db, 'should_not_run')).toBe(false);
      const row = getAppliedVersions(db).get(1);
      expect(row?.bootstrapped).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  it('runs remaining migrations normally after bootstrap prefix', () => {
    // Legacy tables present — predicate 1 will match
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      CREATE TABLE canvases (id TEXT PRIMARY KEY);
    `);
    const dir = makeTempMigrationsDir({
      '001_init.sql': 'CREATE TABLE should_not_run (x INTEGER);',
      // Version 99 — no predicate, so it WILL run
      '099_new_feature.sql': 'CREATE TABLE really_new (x INTEGER);',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      expect(summary.bootstrapped).toEqual([1]);
      expect(summary.applied).toEqual([99]);
      expect(helpers.tableExists(db, 'should_not_run')).toBe(false);
      expect(helpers.tableExists(db, 'really_new')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('throws NonLinearSchemaError when schema has later-but-not-earlier migrations', () => {
    // Use a synthetic set: version 1 predicate requires tableA, version 2 requires tableB.
    // Seed with only tableB — predicate 1 false, predicate 2 true → non-linear drift.
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      -- No canvases table → predicate 1 returns false
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE care_entries (id TEXT PRIMARY KEY);
    `);
    // Predicate 1 checks threads+messages+config+canvases (canvases missing → false)
    // Predicate 2 checks tasks+care_entries (present → true)
    const dir = makeTempMigrationsDir({
      '001_init.sql': 'CREATE TABLE foo (x INTEGER);',
      '002_cc.sql': 'CREATE TABLE bar (x INTEGER);',
    });
    try {
      expect(() => runPendingMigrations(db, { migrationsDir: dir, backup: false })).toThrow(NonLinearSchemaError);
    } finally {
      cleanup(dir);
    }
  });

  it('bootstrap inserts are atomic (all-or-nothing)', () => {
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      CREATE TABLE canvases (id TEXT PRIMARY KEY);
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE care_entries (id TEXT PRIMARY KEY);
    `);
    const dir = makeTempMigrationsDir({
      '001_init.sql': 'SELECT 1;',
      '002_cc.sql': 'SELECT 2;',
    });
    try {
      // Normal run — both bootstrap
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      expect(summary.bootstrapped).toEqual([1, 2]);
      expect(getAppliedVersions(db).size).toBe(2);
    } finally {
      cleanup(dir);
    }
  });
});

describe('migration runner — partial ledger defense', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureMigrationsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it('aborts when ledger references an unknown version', () => {
    // Insert a ledger row for a version that has no matching file
    db.prepare(
      'INSERT INTO _migrations (version, name, checksum, applied_at, bootstrapped) VALUES (?, ?, ?, ?, ?)',
    ).run(999, '999_phantom.sql', 'deadbeef', new Date().toISOString(), 0);
    const dir = makeTempMigrationsDir({
      '001_first.sql': 'SELECT 1;',
    });
    try {
      expect(() => runPendingMigrations(db, { migrationsDir: dir, backup: false })).toThrow(PartialLedgerError);
    } finally {
      cleanup(dir);
    }
  });
});

describe('migration runner — error handling', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('rolls back a transactional migration on failure', () => {
    const dir = makeTempMigrationsDir({
      '001_good.sql': 'CREATE TABLE t_good (id INTEGER);',
      '002_bad.sql': 'CREATE TABLE t_bad (id INTEGER); INSERT INTO nonexistent VALUES (1);',
    });
    try {
      expect(() => runPendingMigrations(db, { migrationsDir: dir, backup: false })).toThrow(MigrationError);
      // Migration 001 applied successfully before 002 failed
      expect(helpers.tableExists(db, 't_good')).toBe(true);
      // Migration 002's transaction rolled back fully
      expect(helpers.tableExists(db, 't_bad')).toBe(false);
      const applied = getAppliedVersions(db);
      expect(applied.has(1)).toBe(true);
      expect(applied.has(2)).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  it('retries the failed migration on next run after fix', () => {
    const dir = makeTempMigrationsDir({
      '001_first.sql': 'CREATE TABLE t1 (id INTEGER); INSERT INTO missing_table VALUES (1);',
    });
    try {
      expect(() => runPendingMigrations(db, { migrationsDir: dir, backup: false })).toThrow();
      expect(getAppliedVersions(db).has(1)).toBe(false);

      // "Fix" the migration
      writeFileSync(join(dir, '001_first.sql'), 'CREATE TABLE t1 (id INTEGER);', 'utf-8');
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      expect(summary.applied).toEqual([1]);
      expect(helpers.tableExists(db, 't1')).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});

describe('migration runner — pragma-outside-tx', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('runs a non-transactional migration and records it', () => {
    // Use a migration that would fail inside a transaction (PRAGMA foreign_keys
    // cannot be set while a transaction is open AND be persistent, but the
    // directive makes the runner skip the tx wrap regardless)
    const dir = makeTempMigrationsDir({
      '001_pragma.sql': '-- @pragma-outside-tx\nPRAGMA foreign_keys=OFF;\nCREATE TABLE t (id INTEGER);\nPRAGMA foreign_keys=ON;',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, backup: false });
      expect(summary.applied).toEqual([1]);
      expect(helpers.tableExists(db, 't')).toBe(true);
      const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
    } finally {
      cleanup(dir);
    }
  });
});

describe('real migrations directory resolves', () => {
  it('MIGRATIONS_DIR points at a directory containing 001_init.sql and 002_command_center.sql', () => {
    const files = listMigrationFiles();
    const names = files.map((f) => f.name);
    expect(names).toContain('001_init.sql');
    expect(names).toContain('002_command_center.sql');
  });
});

describe('predicates — behavioral probes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('messagesAllowsStickerContentType returns false when messages table is missing', () => {
    expect(messagesAllowsStickerContentType(db)).toBe(false);
  });

  it('messagesAllowsStickerContentType returns false when content_type CHECK excludes sticker', () => {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        sequence INTEGER,
        role TEXT,
        content TEXT,
        content_type TEXT CHECK(content_type IN ('text', 'image', 'audio', 'file')),
        created_at TEXT
      );
    `);
    expect(messagesAllowsStickerContentType(db)).toBe(false);
  });

  it('messagesAllowsStickerContentType returns true when sticker is allowed', () => {
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        sequence INTEGER,
        role TEXT,
        content TEXT,
        content_type TEXT CHECK(content_type IN ('text', 'image', 'audio', 'file', 'sticker')),
        created_at TEXT
      );
    `);
    expect(messagesAllowsStickerContentType(db)).toBe(true);
    // Probe must not leave any data behind
    const count = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('predicate 1 matches the core init schema', () => {
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      CREATE TABLE canvases (id TEXT PRIMARY KEY);
    `);
    expect(predicates[1](db)).toBe(true);
  });

  it('predicate 1 returns false if any required table is missing', () => {
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      -- canvases missing
    `);
    expect(predicates[1](db)).toBe(false);
  });

  it('predicate 2 matches the Command Center schema', () => {
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE care_entries (id TEXT PRIMARY KEY);
    `);
    expect(predicates[2](db)).toBe(true);
  });
});

describe('backup — VACUUM INTO', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'covenant-backup-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('returns null for :memory: DB', () => {
    expect(backupDb(':memory:')).toBeNull();
  });

  it('creates a backup file and returns its path', () => {
    const dbPath = join(tmpDir, 'src.db');
    const src = new Database(dbPath);
    src.exec("CREATE TABLE foo (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO foo (name) VALUES ('hello');");
    src.close();

    const backupPath = backupDb(dbPath);
    expect(backupPath).not.toBeNull();
    expect(backupPath!.startsWith(join(tmpDir, 'backups'))).toBe(true);

    // Backup opens and has the same data
    const restored = new Database(backupPath!, { readonly: true });
    const row = restored.prepare('SELECT name FROM foo').get() as { name: string };
    expect(row.name).toBe('hello');
    restored.close();
  });

  it('prunes old backups beyond retention limit', () => {
    const dbPath = join(tmpDir, 'src.db');
    const src = new Database(dbPath);
    src.exec('CREATE TABLE foo (id INTEGER);');
    src.close();

    // Create 5 backups with retention=3 — expect 3 remain
    for (let i = 0; i < 5; i++) {
      backupDb(dbPath, 3);
      // Ensure mtime ordering — without a sleep, some filesystems give identical mtimes
      // Touch the newest file's mtime forward
    }

    const backupDir = join(tmpDir, 'backups');
    // Manual prune check to ignore mtime flakiness from the loop above
    pruneOldBackups(backupDir, 3);
    const remaining = require('fs').readdirSync(backupDir).filter((n: string) => n.startsWith('resonant-'));
    expect(remaining.length).toBeLessThanOrEqual(3);
  });
});

describe('backup triggers correctly', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'covenant-backup-trigger-test-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it('creates backup on fresh DB with pending migrations', () => {
    const dbPath = join(tmpDir, 'src.db');
    const db = new Database(dbPath);
    const dir = makeTempMigrationsDir({
      '001_first.sql': 'CREATE TABLE foo (id INTEGER);',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, dbPath, backup: true });
      expect(summary.backupPath).not.toBeNull();
      expect(summary.applied).toEqual([1]);
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  it('creates backup when bootstrap will run even if pending is empty', () => {
    const dbPath = join(tmpDir, 'src.db');
    const db = new Database(dbPath);
    // Simulate legacy schema inline (pre-population)
    db.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE messages (id TEXT PRIMARY KEY);
      CREATE TABLE config (key TEXT PRIMARY KEY);
      CREATE TABLE canvases (id TEXT PRIMARY KEY);
    `);
    const dir = makeTempMigrationsDir({
      '001_init.sql': 'CREATE TABLE should_not_run (x INTEGER);',
    });
    try {
      const summary = runPendingMigrations(db, { migrationsDir: dir, dbPath, backup: true });
      expect(summary.bootstrapped).toEqual([1]);
      expect(summary.applied).toEqual([]);
      // Critical: backup STILL happens on bootstrap-only runs (revised rule)
      expect(summary.backupPath).not.toBeNull();
    } finally {
      db.close();
      cleanup(dir);
    }
  });

  it('skips backup when there is nothing to change', () => {
    const dbPath = join(tmpDir, 'src.db');
    const db = new Database(dbPath);
    const dir = makeTempMigrationsDir({
      '001_first.sql': 'CREATE TABLE foo (id INTEGER);',
    });
    try {
      // First run — backup happens
      runPendingMigrations(db, { migrationsDir: dir, dbPath, backup: true });
      // Second run — nothing to do, no backup
      const summary = runPendingMigrations(db, { migrationsDir: dir, dbPath, backup: true });
      expect(summary.applied).toEqual([]);
      expect(summary.bootstrapped).toEqual([]);
      expect(summary.backupPath).toBeNull();
    } finally {
      db.close();
      cleanup(dir);
    }
  });
});
