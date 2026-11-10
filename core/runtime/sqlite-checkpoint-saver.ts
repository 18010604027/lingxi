/** Small local checkpointer using Node's built-in sqlite; experimental until crash tests pass. */
import { BaseCheckpointSaver } from '@langchain/langgraph';
import { openDb, transaction, type Db } from '../sqlite.ts';

// Fixed indices from @langchain/langgraph-checkpoint 1.2.2, WRITES_IDX_MAP.
const specialWriteIndex: Record<string, number> = { __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 };

function textOf(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function bytesOf(value: string): Uint8Array { return Uint8Array.from(Buffer.from(value, 'base64')); }
function validUnicode(value: string): boolean { return [...value].every((ch) => { const n = ch.codePointAt(0)!; return n < 0xd800 || n > 0xdfff; }); }
function cfg(config: any): { threadId: string; namespace: string; checkpointId?: string } {
  const c = config?.configurable ?? {};
  if (!c.thread_id) throw new Error('missing checkpoint thread_id');
  return { threadId: c.thread_id, namespace: c.checkpoint_ns ?? '', checkpointId: c.checkpoint_id };
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private readonly db: Db;
  constructor(file: string) {
    super(); this.db = openDb(file);
    // Checkpoints and tool receipts form recovery evidence; request a WAL sync on each commit.
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      parent_checkpoint_id TEXT, checkpoint_type TEXT NOT NULL, metadata_type TEXT NOT NULL, checkpoint BLOB NOT NULL, metadata BLOB NOT NULL,
      PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id)
    ); CREATE TABLE IF NOT EXISTS checkpoint_writes (
      thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
      task_id TEXT NOT NULL, task_path TEXT NOT NULL DEFAULT '', idx INTEGER NOT NULL, channel TEXT NOT NULL, value_type TEXT NOT NULL,
      value BLOB NOT NULL, PRIMARY KEY(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );`);
  }

  async getTuple(config: any): Promise<any> {
    const { threadId, namespace, checkpointId } = cfg(config);
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ${checkpointId ? 'AND checkpoint_id=?' : ''}
      ORDER BY checkpoint_id DESC LIMIT 1`).get(...(checkpointId ? [threadId, namespace, checkpointId] : [threadId, namespace])) as any;
    if (!row) return undefined;
    const checkpoint = await this.serde.loadsTyped(row.checkpoint_type, bytesOf(row.checkpoint)) as { v?: number };
    if (checkpoint.v !== 4) throw new Error('unsupported checkpoint version; migration required');
    const metadata = await this.serde.loadsTyped(row.metadata_type, bytesOf(row.metadata));
    const writes = this.db.prepare(`SELECT task_id, task_path, idx, channel, value_type, value FROM checkpoint_writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY task_path, task_id, idx`)
      .all(threadId, namespace, row.checkpoint_id) as any[];
    return { config: { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: row.checkpoint_id } }, checkpoint, metadata,
      ...(row.parent_checkpoint_id ? { parentConfig: { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: row.parent_checkpoint_id } } } : {}),
      pendingWrites: await Promise.all(writes.map(async (w) => [w.task_id, w.channel, await this.serde.loadsTyped(w.value_type, bytesOf(w.value))])) };
  }

  async *list(config: any, options: any = {}): AsyncGenerator<any> {
    const c = config?.configurable ?? {};
    const conditions: string[] = []; const values: string[] = [];
    for (const [column, value] of [['thread_id', c.thread_id], ['checkpoint_ns', c.checkpoint_ns], ['checkpoint_id', c.checkpoint_id]] as const) {
      if (value !== undefined) { conditions.push(`${column} = ?`); values.push(value); }
    }
    if (options.before?.configurable?.checkpoint_id) { conditions.push('checkpoint_id < ?'); values.push(options.before.configurable.checkpoint_id); }
    const rows = this.db.prepare(`SELECT thread_id,checkpoint_ns,checkpoint_id FROM checkpoints ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY thread_id, checkpoint_ns, checkpoint_id DESC`).all(...values) as any[];
    let count = 0;
    for (const row of rows) {
      if (options.limit !== undefined && count >= options.limit) break;
      const item = await this.getTuple({ configurable: { thread_id: row.thread_id, checkpoint_ns: row.checkpoint_ns, checkpoint_id: row.checkpoint_id } });
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => item.metadata?.[key] === value)) continue;
      count++; yield item;
    }
  }

  async put(config: any, checkpoint: any, metadata: any, _newVersions: any): Promise<any> {
    const { threadId, namespace } = cfg(config);
    const [type, encoded] = await this.serde.dumpsTyped(checkpoint);
    const [metadataType, meta] = await this.serde.dumpsTyped(metadata);
    transaction(this.db, () => this.db.prepare(`INSERT OR REPLACE INTO checkpoints
      (thread_id,checkpoint_ns,checkpoint_id,parent_checkpoint_id,checkpoint_type,metadata_type,checkpoint,metadata) VALUES (?,?,?,?,?,?,?,?)`)
      .run(threadId, namespace, checkpoint.id, config.configurable?.checkpoint_id ?? null, type, metadataType, textOf(encoded), textOf(meta)));
    return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: any, writes: any[], taskId: string, taskPath = ''): Promise<void> {
    const { threadId, namespace, checkpointId } = cfg(config); if (!checkpointId) throw new Error('missing checkpoint_id for writes');
    if (!validUnicode(taskId) || !validUnicode(taskPath)) throw new Error('checkpoint task identity contains invalid Unicode');
    const encoded = await Promise.all(writes.map(async ([channel, value]: any[]) => [channel, ...(await this.serde.dumpsTyped(value))] as const));
    const allSpecial = writes.every(([channel]) => Object.hasOwn(specialWriteIndex, channel));
    transaction(this.db, () => { for (let idx = 0; idx < encoded.length; idx++) {
      const [channel, type, bytes] = encoded[idx];
      this.db.prepare(`INSERT OR ${allSpecial ? 'REPLACE' : 'IGNORE'} INTO checkpoint_writes
        (thread_id,checkpoint_ns,checkpoint_id,task_id,task_path,idx,channel,value_type,value) VALUES (?,?,?,?,?,?,?,?,?)`).run(threadId, namespace, checkpointId, taskId, taskPath, Object.hasOwn(specialWriteIndex, channel) ? specialWriteIndex[channel] : idx, channel, type, textOf(bytes));
    } });
  }

  async deleteThread(threadId: string): Promise<void> {
    transaction(this.db, () => { this.db.prepare('DELETE FROM checkpoint_writes WHERE thread_id=?').run(threadId); this.db.prepare('DELETE FROM checkpoints WHERE thread_id=?').run(threadId); });
  }
  close(): void { this.db.close(); }
}
