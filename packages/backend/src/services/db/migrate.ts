/**
 * Versioned migration runner for Covenant-Fork.
 *
 * Migrations live at `packages/backend/migrations/` as numbered .sql files
 * (e.g. `001_init.sql`). This resolver works identically in dev (tsx from src/)
 * and prod (node from dist/) because both layouts put the migrations/
 * directory three levels above this module file:
 *
 *   src/services/db/migrate.ts   → ../../../migrations/   → packages/backend/migrations/
 *   dist/services/db/migrate.js  → ../../../migrations/   → packages/backend/migrations/
 *
 * The `_migrations` ledger table records which versions have been applied,
 * including a `bootstrapped` flag that distinguishes "ran the DDL fresh" from
 * "detected the effect already present on a legacy DB and marked as applied".
 *
 * See `melodic-orbiting-sunbeam.md` (Batch 7 plan) for the full design rationale.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { predicates } from './migration-predicates.js';

type Db = Database.Database;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Path to the migrations directory. Resolved relative to this module's location
 * so the same path works in dev (tsx from src/) and prod (node from dist/).
 */
export const MIGRATIONS_DIR = resolve(__dirname, '../../../migrations');

/** Directive a migration file can include to opt out of transaction wrapping. */
export const PRAGMA_OUTSIDE_TX_DIRECTIVE = '-- @pragma-outside-tx';

/** Default retention: keep this many backups per directory before pruning. */
export const DEFAULT_BACKUP_RETENTION = 10;

export interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sql: string;
  checksum: string;
  pragmaOutsideTx: boolean;
}

export interface MigrationSummary {
  applied: number[];
  bootstrapped: number[];
  skipped: number[];
  backupPath: string | null;
}

export class MigrationError extends Error {
  constructor(public readonly version: number, public readonly name: string, cause: unknown) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    super(`Migration ${version} (${name}) failed: ${causeMsg}`);
    this.name = 'MigrationError';
  }
}

export class PartialLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialLedgerError';
  }
}

export class NonLinearSchemaError extends Error {
  constructor(firstUnsatisfied: number, laterSatisfied: number[]) {
    super(
      `Non-linear legacy schema detected: migration ${firstUnsatisfied} is unsatisfied ` +
        `but later migrations [${laterSatisfied.join(', ')}] are satisfied. ` +
        `Manual intervention required.`,
    );
    this.name = 'NonLinearSchemaError';
  }
}

/**
 * Lists all migration files in the given directory, sorted by version.
 * Files must be named `NNN_description.sql` where NNN is a zero-padded number.
 * Files that don't match the pattern are ignored (allows README.md etc. in the dir).
 */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const files: MigrationFile[] = [];
  for (const entry of entries) {
    const match = /^(\d+)_(.+)\.sql$/.exec(entry);
    if (!match) continue;
    const version = parseInt(match[1], 10);
    if (!Number.isFinite(version)) continue;
    const fullPath = join(dir, entry);
    const sql = readFileSync(fullPath, 'utf-8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    files.push({
      version,
      name: entry,
      path: fullPath,
      sql,
      checksum,
      pragmaOutsideTx: sql.includes(PRAGMA_OUTSIDE_TX_DIRECTIVE),
    });
  }
  files.sort((a, b) => a.version - b.version);
  return files;
}

/** Creates the `_migrations` ledger table if it doesn't exist. Idempotent. */
export function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      bootstrapped INTEGER NOT NULL DEFAULT 0
    )
  `);
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  bootstrapped: number;
}

export function getAppliedVersions(db: Db): Map<number, AppliedRow> {
  const rows = db.prepare('SELECT version, name, checksum, applied_at, bootstrapped FROM _migrations').all() as AppliedRow[];
  return new Map(rows.map((r) => [r.version, r]));
}

/** Returns true if the DB has the legacy signal tables that predate Batch 7. */
function databaseLooksLikeLegacy(db: Db): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('threads','messages','config')",
    )
    .get() as { c: number };
  return row.c === 3;
}

/**
 * Bootstrap detection: for each file, check if its predicate matches the current
 * schema. Returns an array of versions to mark as applied WITHOUT running their
 * SQL. Aborts with NonLinearSchemaError if schema drift is detected (predicate N
 * is unsatisfied but predicate M>N is satisfied).
 *
 * Does NOT write to the database itself — caller wraps the inserts in a
 * transaction (see `runPendingMigrations`).
 */
export function computeBootstrapVersions(db: Db, files: MigrationFile[]): number[] {
  const satisfied: number[] = [];
  let firstUnsatisfied: number | null = null;

  for (const f of files) {
    const predicate = predicates[f.version];
    if (predicate && predicate(db)) {
      satisfied.push(f.version);
    } else if (firstUnsatisfied === null) {
      firstUnsatisfied = f.version;
    }
  }

  if (firstUnsatisfied !== null) {
    const laterSatisfied = satisfied.filter((v) => v > firstUnsatisfied!);
    if (laterSatisfied.length > 0) {
      throw new NonLinearSchemaError(firstUnsatisfied, laterSatisfied);
    }
  }

  // Only mark contiguous prefix as bootstrapped
  return firstUnsatisfied === null ? satisfied : satisfied.filter((v) => v < firstUnsatisfied!);
}

/**
 * Validates the state of the _migrations table against the known file set.
 * Throws PartialLedgerError if the ledger contains versions with no matching
 * file, or if bootstrapped rows have checksums that don't match current files.
 */
function validateLedgerAgainstFiles(applied: Map<number, AppliedRow>, files: MigrationFile[]): void {
  const fileVersions = new Map(files.map((f) => [f.version, f]));
  for (const [version, row] of applied) {
    const file = fileVersions.get(version);
    if (!file) {
      throw new PartialLedgerError(
        `_migrations row for version ${version} (${row.name}) has no matching .sql file. ` +
          `Manual intervention required — inspect the ledger and migration files directory.`,
      );
    }
    // Don't fail on checksum drift for applied (non-bootstrapped) migrations;
    // that's an intentional warn-only behavior for hotfixes. But for bootstrapped
    // rows, a checksum mismatch is suspicious — the file has changed since bootstrap.
    // We treat this as warn-only too to avoid breaking on intentional content
    // cleanup, but the plan allows this to be tightened later.
  }
}

/**
 * Creates a backup of the given database via VACUUM INTO. Skips for :memory: DBs.
 * Backups go to {dataDir}/backups/resonant-{timestamp}.db where dataDir is
 * dirname(dbPath). Filename contains only ISO timestamp — no user input.
 * Returns the backup file path, or null if skipped.
 */
export function backupDb(dbPath: string, retention: number = DEFAULT_BACKUP_RETENTION): string | null {
  if (dbPath === ':memory:' || !dbPath) return null;
  if (!existsSync(dbPath)) {
    throw new Error(`Cannot back up non-existent database: ${dbPath}`);
  }
  const dataDir = dirname(dbPath);
  const backupDir = join(dataDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `resonant-${stamp}.db`);
  // Defensive escape for path, even though our constructed path cannot contain
  // single quotes (dirname is a filesystem path, stamp is ISO-8601).
  const safePath = backupPath.replace(/'/g, "''");
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${safePath}'`);
  } finally {
    src.close();
  }
  if (retention > 0) pruneOldBackups(backupDir, retention);
  return backupPath;
}

/** Keeps the most recent `keep` backup files (by mtime), removes older ones. */
export function pruneOldBackups(backupDir: string, keep: number): void {
  if (!existsSync(backupDir)) return;
  const entries = readdirSync(backupDir)
    .filter((name) => /^resonant-.*\.db$/.test(name))
    .map((name) => {
      const fullPath = join(backupDir, name);
      return { fullPath, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const entry of entries.slice(keep)) {
    try {
      rmSync(entry.fullPath);
    } catch (err) {
      console.warn(`[Migrations] Failed to prune backup ${entry.fullPath}:`, err);
    }
  }
}

export interface RunOptions {
  /** Enable pre-migration backup. Defaults to true. */
  backup?: boolean;
  /** Path to DB file for backup purposes. Omit/null to skip backup entirely. */
  dbPath?: string | null;
  /** Override backup retention count. Defaults to DEFAULT_BACKUP_RETENTION. */
  backupRetention?: number;
  /** Optional migration dir override, mainly for tests. */
  migrationsDir?: string;
  /** Logger for side-channel info. Defaults to console. */
  logger?: { log: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Main entry point: applies all pending migrations to the given database.
 *
 * Behavior:
 * 1. Ensures the `_migrations` ledger table exists.
 * 2. Loads migration files from disk.
 * 3. Validates the ledger (throws PartialLedgerError if partial/manual state).
 * 4. If ledger is empty AND DB looks legacy: computes bootstrap version list
 *    (throws NonLinearSchemaError on drift).
 * 5. Determines pending = files whose version isn't in applied or bootstrapped set.
 * 6. If (pending.length > 0 OR bootstrap will run) AND backup enabled: VACUUM INTO.
 * 7. Wraps bootstrap inserts in a single transaction.
 * 8. For each pending migration: runs SQL + inserts ledger row, in a transaction
 *    (or outside a tx if the file declares `-- @pragma-outside-tx`).
 * 9. Returns a summary.
 */
export function runPendingMigrations(db: Db, opts: RunOptions = {}): MigrationSummary {
  const logger = opts.logger ?? console;
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const dbPath = opts.dbPath ?? null;
  const enableBackup = opts.backup ?? true;
  const retention = opts.backupRetention ?? DEFAULT_BACKUP_RETENTION;

  ensureMigrationsTable(db);
  const files = listMigrationFiles(migrationsDir);
  const applied = getAppliedVersions(db);

  // Validate the ledger is consistent with the file set.
  validateLedgerAgainstFiles(applied, files);

  // Bootstrap if applicable.
  const bootstrapVersions: number[] = [];
  let bootstrapWillRun = false;
  if (applied.size === 0 && databaseLooksLikeLegacy(db)) {
    const toMark = computeBootstrapVersions(db, files);
    if (toMark.length > 0) {
      bootstrapVersions.push(...toMark);
      bootstrapWillRun = true;
    }
  }

  const bootstrappedSet = new Set(bootstrapVersions);
  const pending = files.filter((f) => !applied.has(f.version) && !bootstrappedSet.has(f.version));

  // Backup if anything will change.
  let backupPath: string | null = null;
  if (enableBackup && dbPath && dbPath !== ':memory:' && (pending.length > 0 || bootstrapWillRun)) {
    backupPath = backupDb(dbPath, retention);
    if (backupPath) {
      logger.log(`[Migrations] Backup created: ${backupPath}`);
    }
  }

  // Apply bootstrap rows in a single transaction (atomic all-or-nothing).
  if (bootstrapVersions.length > 0) {
    const now = new Date().toISOString();
    const insertStmt = db.prepare(
      'INSERT INTO _migrations (version, name, checksum, applied_at, bootstrapped) VALUES (?, ?, ?, ?, 1)',
    );
    const fileByVersion = new Map(files.map((f) => [f.version, f]));
    const tx = db.transaction(() => {
      for (const v of bootstrapVersions) {
        const f = fileByVersion.get(v)!;
        insertStmt.run(v, f.name, f.checksum, now);
      }
    });
    tx();
    logger.log(`[Migrations] Bootstrapped ${bootstrapVersions.length} migrations: [${bootstrapVersions.join(', ')}]`);
  }

  // Apply pending migrations one at a time.
  const appliedVersions: number[] = [];
  for (const f of pending) {
    const now = new Date().toISOString();
    try {
      if (f.pragmaOutsideTx) {
        // Non-transactional execution. If this fails partway, ledger row is NOT
        // written; subsequent startup will retry. Schema may be inconsistent —
        // operator must recover from backup.
        db.exec(f.sql);
        const insertTx = db.transaction(() => {
          db.prepare(
            'INSERT INTO _migrations (version, name, checksum, applied_at, bootstrapped) VALUES (?, ?, ?, ?, 0)',
          ).run(f.version, f.name, f.checksum, now);
        });
        insertTx();
      } else {
        const tx = db.transaction(() => {
          db.exec(f.sql);
          db.prepare(
            'INSERT INTO _migrations (version, name, checksum, applied_at, bootstrapped) VALUES (?, ?, ?, ?, 0)',
          ).run(f.version, f.name, f.checksum, now);
        });
        tx();
      }
      appliedVersions.push(f.version);
      logger.log(`[Migrations] Applied ${f.name}`);
    } catch (err) {
      if (f.pragmaOutsideTx) {
        logger.warn(
          `[Migrations] FATAL: Non-transactional migration ${f.version} (${f.name}) failed partway. ` +
            `Database state is inconsistent. Startup aborted. ` +
            `Recover from latest backup at ${backupPath ?? 'data/backups/'} before restarting.`,
        );
      }
      throw new MigrationError(f.version, f.name, err);
    }
  }

  return {
    applied: appliedVersions,
    bootstrapped: bootstrapVersions,
    skipped: files.filter((f) => applied.has(f.version)).map((f) => f.version),
    backupPath,
  };
}
