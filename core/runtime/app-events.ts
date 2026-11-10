/** Small durable event log for the app conversation. This is business event storage, not a model host. */
import { openDb, transaction, type Db } from '../sqlite.ts';
import type { EventEnvelope, EventStoreReader, FrontInputEvent, TriggerMode } from '../contracts.ts';

export class AppEvents implements EventStoreReader {
  private readonly db: Db;
  private onWake: ((event: FrontInputEvent) => void) | null = null;
  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS app_event (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0,
      event_key TEXT
    );`);
    const columns = this.db.prepare('PRAGMA table_info(app_event)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'event_key')) this.db.exec('ALTER TABLE app_event ADD COLUMN event_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS app_event_key ON app_event(event_key) WHERE event_key IS NOT NULL');
  }
  push(event: Omit<EventEnvelope, 'cursor'>, id?: string): EventEnvelope {
    const key = id ? `${event.type}:${id}` : null;
    const stmt = this.db.prepare('INSERT OR IGNORE INTO app_event(payload, delivered, event_key) VALUES (?, 0, ?)');
    const result = stmt.run(JSON.stringify(event), key);
    if (Number(result.changes) === 0 && key) {
      const prior = this.db.prepare('SELECT cursor,payload FROM app_event WHERE event_key=?').get(key) as { cursor: number; payload: string };
      return { ...JSON.parse(prior.payload) as Omit<EventEnvelope, 'cursor'>, cursor: prior.cursor };
    }
    return { ...event, cursor: Number(result.lastInsertRowid) };
  }
  enqueue(event: FrontInputEvent): boolean {
    this.push({ type: event.type, ts: new Date().toISOString(), source: 'lingxi', origin: 'internal',
      text: event.text, ...(event.trigger ? { senderKey: event.trigger } : {}),
      ...(event.meta || event.id ? { meta: { ...event.meta, ...(event.id ? { eventId: event.id } : {}) } } : {}) }, event.id);
    this.onWake?.(event);
    return true;
  }
  async pushEvent(input: Record<string, unknown>, options: { deliver?: boolean; trigger?: TriggerMode } = {}): Promise<EventEnvelope> {
    const event = {
      type: String(input.type ?? 'event'), source: String(input.source ?? 'lingxi'),
      ts: String(input.ts ?? new Date().toISOString()), origin: input.origin === 'internal' ? 'internal' as const : 'external' as const,
      text: String(input.text ?? ''), ...(typeof input.senderKey === 'string' ? { senderKey: input.senderKey } : {}),
      ...(input.meta && typeof input.meta === 'object' ? { meta: input.meta as Record<string, unknown> } : {}),
      ...(options.deliver === false ? { contextDelivery: 'archive-only' as const } : { contextDelivery: 'deliver' as const }),
    };
    const saved = this.push(event);
    if (options.deliver !== false) this.onWake?.({ type: saved.type, text: saved.text, trigger: options.trigger, meta: saved.meta });
    return saved;
  }
  setOnWake(listener: ((event: FrontInputEvent) => void) | null): void { this.onWake = listener; }
  pending(): EventEnvelope[] {
    return (this.db.prepare('SELECT cursor, payload FROM app_event WHERE delivered=0 ORDER BY cursor').all() as Array<{ cursor: number; payload: string }>).
      map((row) => ({ ...JSON.parse(row.payload) as Omit<EventEnvelope, 'cursor'>, cursor: row.cursor }));
  }
  confirm(cursors: readonly number[]): void {
    if (!cursors.length) return;
    transaction(this.db, () => {
      const update = this.db.prepare('UPDATE app_event SET delivered=1 WHERE cursor=?');
      for (const cursor of cursors) update.run(cursor);
    });
  }
  get(cursor: number): EventEnvelope | undefined {
    const row = this.db.prepare('SELECT payload FROM app_event WHERE cursor=?').get(cursor) as { payload: string } | undefined;
    return row ? { ...JSON.parse(row.payload) as Omit<EventEnvelope, 'cursor'>, cursor } : undefined;
  }
  latestCursor(): number {
    return Number((this.db.prepare('SELECT COALESCE(MAX(cursor),0) AS cursor FROM app_event').get() as { cursor: number }).cursor);
  }
  range(query: { fromCursor?: number; toCursor?: number; fromTs?: string; toTs?: string; source?: string; origin?: string; senderKey?: string; limit?: number }): EventEnvelope[] {
    const rows = this.db.prepare('SELECT cursor,payload FROM app_event WHERE cursor>=? AND cursor<=? ORDER BY cursor')
      .all(query.fromCursor ?? 1, query.toCursor ?? Number.MAX_SAFE_INTEGER) as Array<{ cursor: number; payload: string }>;
    return rows.map((row) => ({ ...JSON.parse(row.payload) as Omit<EventEnvelope, 'cursor'>, cursor: row.cursor }))
      .filter((event) => (!query.source || event.source === query.source) && (!query.origin || event.origin === query.origin)
        && (!query.senderKey || event.senderKey === query.senderKey) && (!query.fromTs || event.ts >= query.fromTs) && (!query.toTs || event.ts <= query.toTs))
      .slice(-(query.limit ?? Number.MAX_SAFE_INTEGER));
  }
  around(cursor: number, before: number, after: number): EventEnvelope[] {
    return this.range({ fromCursor: Math.max(1, cursor - before), toCursor: cursor + after });
  }
  grep(query: { keyword: string; context: number; source?: string; origin?: string; senderKey?: string; fromTs?: string; toTs?: string; limit?: number }): Array<{ hitCursor: number; events: EventEnvelope[] }> {
    const rows = this.range({ source: query.source, origin: query.origin, senderKey: query.senderKey, fromTs: query.fromTs, toTs: query.toTs });
    const out: Array<{ hitCursor: number; events: EventEnvelope[] }> = [];
    for (let i = 0; i < rows.length && out.length < (query.limit ?? 50); i++) if (rows[i]!.text.toLowerCase().includes(query.keyword.toLowerCase())) {
      out.push({ hitCursor: rows[i]!.cursor, events: rows.slice(Math.max(0, i - query.context), i + query.context + 1) });
    }
    return out;
  }
  close(): void { this.db.close(); }
}
