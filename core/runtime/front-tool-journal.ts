/** Experimental tool execution journal. Not yet connected to a production front. */
import { createHash } from 'node:crypto';
import { openDb, transaction, type Db } from '../sqlite.ts';

export type ToolReceipt = { text: string; failed: boolean };
export type ToolStart = { state: 'started' } | { state: 'unknown' } | { state: 'completed'; receipt: ToolReceipt };

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  throw new Error('tool arguments are not JSON values');
}

export class FrontToolJournal {
  private readonly db: Db;
  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS front_tool_execution (
      thread_id TEXT NOT NULL, call_id TEXT NOT NULL, name TEXT NOT NULL, args_hash TEXT NOT NULL,
      state TEXT NOT NULL, result_text TEXT, result_failed INTEGER,
      PRIMARY KEY (thread_id, call_id)
    )`);
  }

  begin(threadId: string, callId: string, name: string, args: unknown): ToolStart {
    if (!threadId || !callId || !name) throw new Error('missing tool execution identity');
    const hash = createHash('sha256').update(canonical(args)).digest('hex');
    let result: ToolStart = { state: 'unknown' };
    transaction(this.db, () => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO front_tool_execution
        (thread_id, call_id, name, args_hash, state) VALUES (?, ?, ?, ?, 'started')`).run(threadId, callId, name, hash);
      if (Number(inserted.changes) === 1) { result = { state: 'started' }; return; }
      const row = this.db.prepare(`SELECT name, args_hash, state, result_text, result_failed FROM front_tool_execution
        WHERE thread_id = ? AND call_id = ?`).get(threadId, callId) as { name: string; args_hash: string; state: string; result_text: string | null; result_failed: number | null };
      if (row.name !== name || row.args_hash !== hash) throw new Error('tool call identity conflicts with recorded execution');
      if (row.state === 'completed' && row.result_text !== null && row.result_failed !== null) {
        result = { state: 'completed', receipt: { text: row.result_text, failed: row.result_failed === 1 } };
      }
    });
    return result;
  }

  complete(threadId: string, callId: string, receipt: ToolReceipt): void {
    const changed = this.db.prepare(`UPDATE front_tool_execution SET state = 'completed', result_text = ?, result_failed = ?
      WHERE thread_id = ? AND call_id = ? AND state = 'started'`).run(receipt.text, receipt.failed ? 1 : 0, threadId, callId);
    if (Number(changed.changes) !== 1) throw new Error('tool execution is not awaiting a receipt');
  }

  unresolved(threadId: string): string[] {
    return (this.db.prepare("SELECT call_id FROM front_tool_execution WHERE thread_id = ? AND state IN ('started', 'unknown') ORDER BY call_id")
      .all(threadId) as Array<{ call_id: string }>).map((row) => row.call_id);
  }

  close(): void { this.db.close(); }
}
