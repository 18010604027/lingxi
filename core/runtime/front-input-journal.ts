/** Temporary input reconciliation journal; not connected to the production front. */
import { createHash } from 'node:crypto';
import { openDb, transaction, type Db } from '../sqlite.ts';

export interface FrontInputBatch {
  threadId: string;
  batchId: string;
  cursors: number[];
  /** Already materialized JSON records, including attachment references. */
  records: unknown[];
  /** EventStore cursors that Core must settle after this graph input is accepted. */
  deliveryCursors?: number[];
}

export interface PreparedFrontInput { batch: FrontInputBatch; fingerprint: string; state: 'prepared' | 'accepted' }

export interface FrontMaterializationClaim {
  threadId: string;
  batchId: string;
  cursors: number[];
  state: 'materializing' | 'materialized' | 'unknown';
  outcome?: 'noop';
}

export class FrontInputJournal {
  private readonly db: Db;
  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec('PRAGMA synchronous = FULL');
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS front_input_batch (
        thread_id TEXT NOT NULL, batch_id TEXT NOT NULL, payload TEXT NOT NULL,
        fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared', 'accepted')),
        PRIMARY KEY (thread_id, batch_id)
      ); CREATE TABLE IF NOT EXISTS front_input_cursor (
        thread_id TEXT NOT NULL, cursor INTEGER NOT NULL, batch_id TEXT NOT NULL,
        PRIMARY KEY (thread_id, cursor)
      ); CREATE UNIQUE INDEX IF NOT EXISTS front_input_cursor_global ON front_input_cursor (cursor);
      CREATE TABLE IF NOT EXISTS front_delivery_materialization (
        thread_id TEXT NOT NULL, batch_id TEXT NOT NULL, cursors TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('materializing', 'materialized', 'unknown')),
        outcome TEXT,
        PRIMARY KEY(thread_id, batch_id)
      ); CREATE TABLE IF NOT EXISTS front_graph_projection (
        thread_id TEXT PRIMARY KEY, message_index INTEGER NOT NULL CHECK(message_index >= 0)
      )`);
      const claimColumns = this.db.prepare('PRAGMA table_info(front_delivery_materialization)').all() as Array<{ name: string }>;
      if (!claimColumns.some((column) => column.name === 'outcome')) this.db.exec('ALTER TABLE front_delivery_materialization ADD COLUMN outcome TEXT');
      // Backfill databases created before cursor ownership was indexed. A cursor collision is corruption, not a migration choice.
      transaction(this.db, () => {
        const rows = this.db.prepare('SELECT thread_id, batch_id, payload FROM front_input_batch').all() as Array<{ thread_id: string; batch_id: string; payload: string }>;
        for (const row of rows) {
          const payload = JSON.parse(row.payload) as { cursors?: unknown };
          if (!Array.isArray(payload.cursors) || !payload.cursors.every((cursor) => Number.isSafeInteger(cursor) && cursor > 0)) {
            throw new Error('front input journal contains invalid cursors');
          }
          for (const cursor of payload.cursors as number[]) {
            const inserted = this.db.prepare('INSERT OR IGNORE INTO front_input_cursor (thread_id, cursor, batch_id) VALUES (?, ?, ?)')
              .run(row.thread_id, cursor, row.batch_id);
            if (Number(inserted.changes) === 0) {
            const owner = this.db.prepare('SELECT thread_id, batch_id FROM front_input_cursor WHERE cursor = ?')
              .get(cursor) as { thread_id: string; batch_id: string } | undefined;
            if (owner?.thread_id !== row.thread_id || owner.batch_id !== row.batch_id) throw new Error('front input cursor is assigned to multiple batches or threads');
            }
          }
        }
      });
    } catch (error) { this.db.close(); throw error; }
  }

  prepare(batch: FrontInputBatch): PreparedFrontInput {
    if (!batch.threadId || !batch.batchId || !batch.cursors.every((n) => Number.isSafeInteger(n) && n > 0)
      || new Set(batch.cursors).size !== batch.cursors.length
      || batch.cursors.some((cursor, index) => index > 0 && cursor <= batch.cursors[index - 1])
      || (batch.deliveryCursors !== undefined && (!batch.deliveryCursors.every((n) => Number.isSafeInteger(n) && n > 0)
        || new Set(batch.deliveryCursors).size !== batch.deliveryCursors.length))
      || !Array.isArray(batch.records)) throw new Error('invalid front input batch');
    const payload = JSON.stringify({ cursors: batch.cursors, records: batch.records,
      ...(batch.deliveryCursors ? { deliveryCursors: batch.deliveryCursors } : {}) }, (_key, value: unknown) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
        || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('front input is not JSON-safe');
      return value;
    });
    const fingerprint = createHash('sha256').update(payload).digest('hex');
    transaction(this.db, () => {
      this.db.prepare(`INSERT OR IGNORE INTO front_input_batch (thread_id, batch_id, payload, fingerprint, state)
        VALUES (?, ?, ?, ?, 'prepared')`).run(batch.threadId, batch.batchId, payload, fingerprint);
      for (const cursor of batch.cursors) {
        const owner = this.db.prepare('SELECT thread_id, batch_id FROM front_input_cursor WHERE cursor = ?')
          .get(cursor) as { thread_id: string; batch_id: string } | undefined;
        if (owner && (owner.thread_id !== batch.threadId || owner.batch_id !== batch.batchId)) throw new Error(`front input cursor ${cursor} already belongs to another batch or thread`);
        this.db.prepare('INSERT OR IGNORE INTO front_input_cursor (thread_id, cursor, batch_id) VALUES (?, ?, ?)')
          .run(batch.threadId, cursor, batch.batchId);
      }
      const row = this.get(batch.threadId, batch.batchId);
      if (!row || row.fingerprint !== fingerprint) throw new Error('front input batch identity conflict');
    });
    return this.get(batch.threadId, batch.batchId)!;
  }

  /** Persist the no-replay barrier before calling Persona.onDelivery. */
  claimMaterialization(threadId: string, batchId: string, cursors: readonly number[]): FrontMaterializationClaim {
    if (!threadId || !batchId || !cursors.every((n) => Number.isSafeInteger(n) && n > 0)
      || new Set(cursors).size !== cursors.length || cursors.some((n, i) => i > 0 && n <= cursors[i - 1])) {
      throw new Error('invalid front materialization claim');
    }
    const encoded = JSON.stringify(cursors);
    let inserted = false;
    transaction(this.db, () => {
      inserted = Number(this.db.prepare(`INSERT OR IGNORE INTO front_delivery_materialization (thread_id, batch_id, cursors, state)
        VALUES (?, ?, ?, 'materializing')`).run(threadId, batchId, encoded).changes) === 1;
    });
    let claim = this.getMaterialization(threadId, batchId);
    if (!claim || JSON.stringify(claim.cursors) !== encoded) throw new Error('front materialization identity conflict');
    if (inserted) return claim;
    if (claim.state === 'materializing') {
      // A prepared input proves complete material escaped to the journal before a crash.
      const prepared = this.get(threadId, batchId);
      if (prepared && JSON.stringify(prepared.batch.cursors) === encoded) {
        transaction(this.db, () => this.db.prepare(`UPDATE front_delivery_materialization SET state='materialized'
          WHERE thread_id=? AND batch_id=? AND state='materializing'`).run(threadId, batchId));
        claim = this.getMaterialization(threadId, batchId)!;
      } else {
        // This call is made on recovery: no durable proof says whether the hook completed.
        transaction(this.db, () => this.db.prepare(`UPDATE front_delivery_materialization SET state='unknown'
          WHERE thread_id=? AND batch_id=? AND state='materializing'`).run(threadId, batchId));
        claim = this.getMaterialization(threadId, batchId)!;
      }
    }
    return claim;
  }

  /** Save exact Persona output before graph checkpointing; safe to reconcile after a process exit. */
  completeMaterialization(batch: FrontInputBatch): PreparedFrontInput {
    const claim = this.getMaterialization(batch.threadId, batch.batchId);
    if (!claim || claim.state !== 'materializing' || JSON.stringify(claim.cursors) !== JSON.stringify(batch.cursors)) {
      throw new Error('front materialization is not claimed');
    }
    const prepared = this.prepare(batch);
    transaction(this.db, () => {
      const updated = this.db.prepare(`UPDATE front_delivery_materialization SET state='materialized'
        WHERE thread_id=? AND batch_id=? AND state='materializing'`).run(batch.threadId, batch.batchId);
      if (Number(updated.changes) !== 1) throw new Error('front materialization claim changed before completion');
    });
    return prepared;
  }

  getMaterialization(threadId: string, batchId: string): FrontMaterializationClaim | undefined {
    const row = this.db.prepare('SELECT cursors, state, outcome FROM front_delivery_materialization WHERE thread_id=? AND batch_id=?')
      .get(threadId, batchId) as { cursors: string; state: FrontMaterializationClaim['state']; outcome: 'noop' | null } | undefined;
    return row ? { threadId, batchId, cursors: JSON.parse(row.cursors) as number[], state: row.state,
      ...(row.outcome ? { outcome: row.outcome } : {}) } : undefined;
  }

  /** Close an intentionally empty materialization without creating a graph node or a fake cursor. */
  settleNoop(threadId: string, batchId: string): void {
    const input = this.get(threadId, batchId);
    if (!input || input.batch.records.length !== 0 || (input.batch.deliveryCursors?.length ?? 0) !== 0) {
      throw new Error('only an empty materialization can be settled without a graph checkpoint');
    }
    transaction(this.db, () => {
      const result = this.db.prepare(`UPDATE front_delivery_materialization SET outcome='noop'
        WHERE thread_id=? AND batch_id=? AND state='materialized' AND outcome IS NULL`).run(threadId, batchId);
      if (Number(result.changes) !== 1 && this.getMaterialization(threadId, batchId)?.outcome !== 'noop') {
        throw new Error('front no-op settlement identity conflict');
      }
    });
  }

  get(threadId: string, batchId: string): PreparedFrontInput | undefined {
    const row = this.db.prepare('SELECT payload, fingerprint, state FROM front_input_batch WHERE thread_id = ? AND batch_id = ?')
      .get(threadId, batchId) as { payload: string; fingerprint: string; state: 'prepared' | 'accepted' } | undefined;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload) as Pick<FrontInputBatch, 'cursors' | 'records' | 'deliveryCursors'>;
    if (createHash('sha256').update(row.payload).digest('hex') !== row.fingerprint) throw new Error('front input batch is corrupt');
    return { batch: { threadId, batchId, ...payload }, fingerprint: row.fingerprint, state: row.state };
  }

  list(threadId: string): PreparedFrontInput[] {
    const rows = this.db.prepare(`SELECT b.batch_id FROM front_input_batch b
      LEFT JOIN front_delivery_materialization m USING(thread_id, batch_id)
      WHERE b.thread_id = ? AND m.outcome IS NULL ORDER BY b.batch_id`)
      .all(threadId) as Array<{ batch_id: string }>;
    return rows.map(({ batch_id }) => this.get(threadId, batch_id)!).sort((a, b) =>
      (a.batch.cursors[0] ?? Number.MAX_SAFE_INTEGER) - (b.batch.cursors[0] ?? Number.MAX_SAFE_INTEGER)
      || a.batch.batchId.localeCompare(b.batch.batchId));
  }

  batchForCursor(threadId: string, cursor: number): string | undefined {
    const owner = this.db.prepare(`SELECT c.thread_id, c.batch_id FROM front_input_cursor c
      LEFT JOIN front_delivery_materialization m USING(thread_id, batch_id)
      WHERE c.cursor = ? AND m.outcome IS NULL`)
      .get(cursor) as { thread_id: string; batch_id: string } | undefined;
    return owner?.thread_id === threadId ? owner.batch_id : undefined;
  }

  graphProjectionIndex(threadId: string): number {
    const row = this.db.prepare('SELECT message_index FROM front_graph_projection WHERE thread_id=?').get(threadId) as { message_index: number } | undefined;
    return row?.message_index ?? 0;
  }

  advanceGraphProjection(threadId: string, expectedIndex: number, nextIndex: number): void {
    if (!threadId.trim() || !Number.isSafeInteger(expectedIndex) || expectedIndex < 0
      || !Number.isSafeInteger(nextIndex) || nextIndex < expectedIndex) throw new Error('invalid graph projection cursor');
    if (nextIndex === expectedIndex) return;
    transaction(this.db, () => {
      const current = this.graphProjectionIndex(threadId);
      if (current !== expectedIndex) throw new Error(`graph projection cursor changed: expected ${expectedIndex}, got ${current}`);
      this.db.prepare(`INSERT INTO front_graph_projection (thread_id, message_index) VALUES (?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET message_index=excluded.message_index`).run(threadId, nextIndex);
    });
  }

  /** Call only after the persisted graph checkpoint has been read and verified. */
  accept(threadId: string, batchId: string, checkpointFingerprint: string): void {
    transaction(this.db, () => {
      const row = this.get(threadId, batchId);
      if (!row || row.fingerprint !== checkpointFingerprint) throw new Error('checkpoint does not match prepared input');
      this.db.prepare("UPDATE front_input_batch SET state = 'accepted' WHERE thread_id = ? AND batch_id = ?")
        .run(threadId, batchId);
    });
  }

  close(): void { this.db.close(); }
}
