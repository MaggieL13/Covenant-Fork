import Database from 'better-sqlite3';

let db: Database.Database | null = null;

export function setDb(database: Database.Database): void {
  db = database;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}
