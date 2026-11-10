/** Node's built-in SQLite. No native module, so nothing is rebuilt for Electron. */
import { createRequire } from 'node:module';

// Loaded through require: Vite 5, under the tests, does not know `node:sqlite` as a builtin and fails to import it.
export const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export type Db = InstanceType<typeof DatabaseSync>;

/** Opens `file` in WAL mode, the setting every store here uses: readers do not block the writer. */
export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return db;
}

/** Runs `fn` in one write transaction. */
export function transaction(db: Db, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try { fn(); db.exec('COMMIT'); }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
