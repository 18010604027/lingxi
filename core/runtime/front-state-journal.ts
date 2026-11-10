import { openDb, transaction, type Db } from '../sqlite.ts';

export interface DurableFrontState {
  state: 'idle' | 'processing' | 'failed';
  inputCursors: number[];
  error?: string;
  updatedAt?: string;
}

/**
 * Durable evidence for the host front state. A processing row is never
 * treated as success after restart: recover() records the interruption and
 * leaves the live observation unknown until a new batch starts.
 */
export class FrontStateJournal {
  private readonly db: Db;
  constructor(file: string, private readonly onState?: (state: DurableFrontState) => void) {
    this.db = openDb(file);
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS front_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL,
      input_cursors TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS front_state_recovery (
      id INTEGER PRIMARY KEY AUTOINCREMENT, previous_state TEXT NOT NULL,
      input_cursors TEXT NOT NULL, reason TEXT NOT NULL, recovered_at TEXT NOT NULL
    )`);
  }

  private write(state: DurableFrontState): void {
    if (!state.inputCursors.every((cursor) => Number.isSafeInteger(cursor) && cursor > 0)) {
      throw new Error('front state contains an invalid input cursor');
    }
    transaction(this.db, () => this.db.prepare(`INSERT INTO front_state
      (id, state, input_cursors, error, updated_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, input_cursors=excluded.input_cursors,
      error=excluded.error, updated_at=excluded.updated_at`)
      .run(state.state, JSON.stringify([...new Set(state.inputCursors)]), state.error ?? null, new Date().toISOString()));
    try { this.onState?.(state); } catch { /* body status is a projection; durable state remains authoritative */ }
  }

  /** Re-emit the live processing projection at a new model round without changing durable cursors. */
  processing(inputCursors: readonly number[]): void {
    try { this.onState?.({ state: 'processing', inputCursors: [...new Set(inputCursors)] }); }
    catch { /* body status is a projection; durable state remains authoritative */ }
  }

  read(): DurableFrontState | undefined {
    const row = this.db.prepare('SELECT state, input_cursors, error, updated_at FROM front_state WHERE id = 1')
      .get() as { state: DurableFrontState['state']; input_cursors: string; error: string | null; updated_at: string } | undefined;
    if (!row) return undefined;
    const cursors = JSON.parse(row.input_cursors) as unknown;
    if (!Array.isArray(cursors) || !cursors.every((cursor) => Number.isSafeInteger(cursor) && cursor > 0)) {
      throw new Error('front state journal is corrupt');
    }
    return { state: row.state, inputCursors: cursors as number[], updatedAt: row.updated_at, ...(row.error !== null ? { error: row.error } : {}) };
  }

  /** Every stored state describes the previous process; the new process starts unknown. */
  recover(): DurableFrontState | undefined {
    const previous = this.read();
    if (!previous) return undefined;
    const reason = previous.state === 'processing'
      ? 'process restarted while front was processing'
      : 'host restarted; previous state is not a live observation';
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO front_state_recovery (previous_state, input_cursors, reason, recovered_at)
        VALUES (?, ?, ?, ?)`)
        .run(previous.state, JSON.stringify(previous.inputCursors), reason, new Date().toISOString());
      this.db.prepare('DELETE FROM front_state WHERE id = 1').run();
    });
    return undefined;
  }

  begin(inputCursors: readonly number[]): void { this.write({ state: 'processing', inputCursors: [...inputCursors] }); }
  idle(inputCursors: readonly number[]): void { this.write({ state: 'idle', inputCursors: [...inputCursors] }); }
  failed(inputCursors: readonly number[], error: string): void {
    this.write({ state: 'failed', inputCursors: [...inputCursors], error });
  }

  recoveryCount(): number { return Number((this.db.prepare('SELECT COUNT(*) AS count FROM front_state_recovery').get() as { count: number }).count); }
  close(): void { this.db.close(); }
}
