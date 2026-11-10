/**
 * The operation ledger: what each role did, why, and how it turned out, so whoever takes over an incident can
 * read its history and the daily layer's accuracy can be measured over time. Why it exists and what it borrows
 * are noted with the code (L1).
 *
 * One SQLite file with two tables:
 * - `entry` holds one row per recorded act. Rows are appended, never updated. Rows of the kinds in `KEPT` stay
 *   forever and are hash-chained in the order they were written, so a silent edit of one shows in `verify`;
 *   other rows are dropped after the retention period, which is why they stay out of the chain.
 * - `tally` counts routine outcomes per hour, role, actor and outcome. The daily layer counts its routine
 *   judgements here instead of writing rows, and `prune` folds expired rows into it.
 *
 * Writes are queued in memory and committed in one transaction every `flushMs` or every `maxBatch` items,
 * on `flush` and `close`, and at once for a kept row; a crash loses at most the unkept rows of one interval. Reads flush first, so they see everything appended before them. Large content
 * (prompts, outputs) stays in the associated run store; a row names it in `ref`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { openDb, transaction, type Db } from '../sqlite.ts';

export const LEDGER_VERSION = 1;

export type Role = 'front' | 'control' | 'coder' | 'daily';
/** `evaluation` judges an earlier row, named by `targetSpanId`, after the fact. */
export type Op = 'decision' | 'action' | 'dispatch' | 'escalate' | 'evaluation' | 'note';
export type Result = 'ok' | 'fail' | 'uncertain';

/** Kinds kept past the retention period and chained: the material for learning what "doing badly" means. */
export const KEPT: ReadonlySet<Op> = new Set(['decision', 'escalate', 'evaluation']);

export interface EntryInput {
  role: Role;
  /** Who acted, specific enough to tell versions apart, e.g. `rule:window-classifier@3`. */
  actor: string;
  op: Op;
  summary: string;
  why?: string;
  /** Ids of what the act was based on: episodes, events, other spans. */
  evidence?: string[];
  result?: Result;
  incidentId?: string;
  traceId?: string;
  /** Generated when absent. */
  spanId?: string;
  parentSpanId?: string;
  targetSpanId?: string;
  /** Where the full content lives, for example a model run and cursor. */
  ref?: string;
}

export interface Entry extends Required<Pick<EntryInput, 'role' | 'actor' | 'op' | 'summary' | 'spanId'>> {
  seq: number;
  v: number;
  ts: string;
  why: string | null;
  evidence: string[];
  result: Result | null;
  incidentId: string | null;
  traceId: string | null;
  parentSpanId: string | null;
  targetSpanId: string | null;
  ref: string | null;
  prevHash: string | null;
  hash: string | null;
}

export interface LedgerOptions {
  flushMs?: number;
  maxBatch?: number;
  /** Days a row outside `KEPT` is kept before `prune` folds it into `tally`. */
  retentionDays?: number;
  now?: () => Date;
}

interface Pending { ts: string; input: EntryInput & { spanId: string } }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entry (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  v INTEGER NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  actor TEXT NOT NULL,
  op TEXT NOT NULL,
  summary TEXT NOT NULL,
  why TEXT,
  evidence TEXT,
  result TEXT,
  incident_id TEXT,
  trace_id TEXT,
  span_id TEXT NOT NULL UNIQUE,
  parent_span_id TEXT,
  target_span_id TEXT,
  ref TEXT,
  prev_hash TEXT,
  hash TEXT
);
CREATE INDEX IF NOT EXISTS entry_incident ON entry (incident_id);
CREATE INDEX IF NOT EXISTS entry_ts ON entry (ts);
CREATE INDEX IF NOT EXISTS entry_target ON entry (target_span_id);
CREATE TABLE IF NOT EXISTS tally (
  hour TEXT NOT NULL,
  role TEXT NOT NULL,
  actor TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (hour, role, actor, outcome)
);
`;

/** The hour bucket of an ISO timestamp, UTC: `2026-10-25T14`. */
const hourOf = (ts: string) => ts.slice(0, 13);

/** The chained hash of a kept row: everything it says plus the hash before it. */
export function hashOf(e: Omit<Entry, 'seq' | 'hash'>): string {
  const body = [e.v, e.ts, e.role, e.actor, e.op, e.summary, e.why, e.evidence, e.result, e.incidentId, e.traceId,
    e.spanId, e.parentSpanId, e.targetSpanId, e.ref, e.prevHash];
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function rowToEntry(r: Record<string, unknown>): Entry {
  return {
    seq: r.seq as number,
    v: r.v as number,
    ts: r.ts as string,
    role: r.role as Role,
    actor: r.actor as string,
    op: r.op as Op,
    summary: r.summary as string,
    why: r.why as string | null,
    evidence: r.evidence ? JSON.parse(r.evidence as string) as string[] : [],
    result: r.result as Result | null,
    incidentId: r.incident_id as string | null,
    traceId: r.trace_id as string | null,
    spanId: r.span_id as string,
    parentSpanId: r.parent_span_id as string | null,
    targetSpanId: r.target_span_id as string | null,
    ref: r.ref as string | null,
    prevHash: r.prev_hash as string | null,
    hash: r.hash as string | null,
  };
}

export class Ledger {
  private readonly db: Db;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private queue: Pending[] = [];
  private counts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string, opts: LedgerOptions = {}) {
    this.flushMs = opts.flushMs ?? 10_000;
    this.maxBatch = opts.maxBatch ?? 200;
    this.retentionDays = opts.retentionDays ?? 30;
    this.now = opts.now ?? (() => new Date());
    this.db = openDb(file);
    this.db.exec(SCHEMA);
  }

  /**
   * Queues one row and returns its span id, for children and later evaluations to point at. A row of a kind
   * in `KEPT` is committed at once, with whatever is queued before it: those are rare and must not be lost.
   */
  append(input: EntryInput): string {
    const spanId = input.spanId ?? randomUUID();
    this.queue.push({ ts: this.now().toISOString(), input: { ...input, spanId } });
    if (KEPT.has(input.op)) this.flush();
    else this.schedule();
    return spanId;
  }

  /** Counts one routine outcome without writing a row. */
  count(role: Role, actor: string, outcome: string, n = 1): void {
    const key = JSON.stringify([hourOf(this.now().toISOString()), role, actor, outcome]);
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
    this.schedule();
  }

  /** Commits everything queued in one transaction. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.queue.length && !this.counts.size) return;
    const queue = this.queue;
    const counts = this.counts;
    this.queue = [];
    this.counts = new Map();
    try { this.commit(queue, counts); }
    catch (error) {
      this.queue = [...queue, ...this.queue];
      for (const [key, n] of counts) this.counts.set(key, (this.counts.get(key) ?? 0) + n);
      throw error;
    }
  }

  private commit(queue: Pending[], counts: Map<string, number>): void {
    this.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO entry (v, ts, role, actor, op, summary, why, evidence, result, incident_id,
        trace_id, span_id, parent_span_id, target_span_id, ref, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let prevHash = this.lastHash();
      for (const { ts, input } of queue) {
        const e = {
          v: LEDGER_VERSION, ts, role: input.role, actor: input.actor, op: input.op, summary: input.summary,
          why: input.why ?? null, evidence: input.evidence ?? [], result: input.result ?? null,
          incidentId: input.incidentId ?? null, traceId: input.traceId ?? null, spanId: input.spanId,
          parentSpanId: input.parentSpanId ?? null, targetSpanId: input.targetSpanId ?? null, ref: input.ref ?? null,
          prevHash: KEPT.has(input.op) ? prevHash : null,
        };
        const hash = KEPT.has(input.op) ? hashOf(e) : null;
        if (hash) prevHash = hash;
        insert.run(e.v, e.ts, e.role, e.actor, e.op, e.summary, e.why, e.evidence.length ? JSON.stringify(e.evidence) : null,
          e.result, e.incidentId, e.traceId, e.spanId, e.parentSpanId, e.targetSpanId, e.ref, e.prevHash, hash);
      }
      this.addTallies(counts);
    });
  }

  /**
   * One incident's rows in the order they were written, with the evaluations of any of them: the latest
   * `limit`, and how many older ones were left out.
   */
  byIncident(incidentId: string, limit = 50): { entries: Entry[]; omitted: number } {
    this.flush();
    const where = `incident_id = ? OR target_span_id IN (SELECT span_id FROM entry WHERE incident_id = ?)`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM entry WHERE ${where}`).get(incidentId, incidentId) as { n: number }).n;
    const rows = this.db.prepare(`SELECT * FROM (SELECT * FROM entry WHERE ${where} ORDER BY seq DESC LIMIT ?) ORDER BY seq`)
      .all(incidentId, incidentId, limit) as Record<string, unknown>[];
    return { entries: rows.map(rowToEntry), omitted: Math.max(0, total - rows.length) };
  }

  /** Rows written in [from, to), ISO timestamps, oldest first. */
  range(from: string, to: string): Entry[] {
    this.flush();
    return (this.db.prepare('SELECT * FROM entry WHERE ts >= ? AND ts < ? ORDER BY seq').all(from, to) as Record<string, unknown>[])
      .map(rowToEntry);
  }

  /** Tally rows in [fromHour, toHour), hours as `hourOf` writes them. */
  tallies(fromHour: string, toHour: string): Array<{ hour: string; role: Role; actor: string; outcome: string; n: number }> {
    this.flush();
    return this.db.prepare('SELECT hour, role, actor, outcome, n FROM tally WHERE hour >= ? AND hour < ? ORDER BY hour, role, actor, outcome')
      .all(fromHour, toHour) as Array<{ hour: string; role: Role; actor: string; outcome: string; n: number }>;
  }

  /** Folds rows outside `KEPT` older than the retention period into `tally` and deletes them; returns how many. */
  prune(): number {
    this.flush();
    const cutoff = new Date(this.now().getTime() - this.retentionDays * 86_400_000).toISOString();
    const kept = [...KEPT].map(() => '?').join(', ');
    let removed = 0;
    this.transaction(() => {
      const old = this.db.prepare(`SELECT ts, role, actor, op, result FROM entry WHERE ts < ? AND op NOT IN (${kept})`)
        .all(cutoff, ...KEPT) as Array<{ ts: string; role: Role; actor: string; op: Op; result: Result | null }>;
      const counts = new Map<string, number>();
      for (const r of old) {
        const key = JSON.stringify([hourOf(r.ts), r.role, r.actor, `${r.op}:${r.result ?? 'none'}`]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.addTallies(counts);
      removed = Number(this.db.prepare(`DELETE FROM entry WHERE ts < ? AND op NOT IN (${kept})`).run(cutoff, ...KEPT).changes);
    });
    return removed;
  }

  /** The first kept row whose hash or link does not match, or null when the chain is intact. */
  verify(): Entry | null {
    this.flush();
    let prev: string | null = null;
    const kept = [...KEPT].map(() => '?').join(', ');
    for (const r of this.db.prepare(`SELECT * FROM entry WHERE op IN (${kept}) ORDER BY seq`).all(...KEPT) as Record<string, unknown>[]) {
      const e = rowToEntry(r);
      if (e.prevHash !== prev || e.hash !== hashOf(e)) return e;
      prev = e.hash;
    }
    return null;
  }

  close(): void {
    this.flush();
    this.db.close();
  }

  private schedule(): void {
    if (this.queue.length + this.counts.size >= this.maxBatch) { this.flush(); return; }
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushMs);
    this.timer.unref();
  }

  private lastHash(): string | null {
    const kept = [...KEPT].map(() => '?').join(', ');
    const row = this.db.prepare(`SELECT hash FROM entry WHERE op IN (${kept}) ORDER BY seq DESC LIMIT 1`).get(...KEPT) as { hash: string } | undefined;
    return row?.hash ?? null;
  }

  private addTallies(counts: Map<string, number>): void {
    const upsert = this.db.prepare(`INSERT INTO tally (hour, role, actor, outcome, n) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (hour, role, actor, outcome) DO UPDATE SET n = n + excluded.n`);
    for (const [key, n] of counts) {
      const [hour, role, actor, outcome] = JSON.parse(key) as [string, Role, string, string];
      upsert.run(hour, role, actor, outcome, n);
    }
  }

  private transaction(fn: () => void): void {
    transaction(this.db, fn);
  }
}

/** Rows as plain text, one line each, for a person to read. */
export function toText(entries: Entry[]): string {
  return entries.map((e) => [
    e.ts, e.role, e.actor, e.op, e.result ?? '-', e.summary,
    e.why ? `why: ${e.why}` : '', e.incidentId ? `incident: ${e.incidentId}` : '',
    e.targetSpanId ? `judges: ${e.targetSpanId}` : '', e.ref ? `ref: ${e.ref}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
}
