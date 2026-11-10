import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Ledger, toText } from '../core/ledger/ledger.ts';

let dir: string;
let clock: Date;
const now = () => clock;
/** Runs `fn` on a separate handle to the ledger file and closes it, so Windows can delete the directory. */
function raw<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join(dir, 'ledger.sqlite'));
  try { return fn(db); } finally { db.close(); }
}
const rows = () => raw((db) => (db.prepare('SELECT COUNT(*) AS n FROM entry').get() as { n: number }).n);
const open = (opts = {}) => new Ledger(join(dir, 'ledger.sqlite'), { now, flushMs: 60_000, ...opts });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  clock = new Date('2026-10-25T14:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Ledger', () => {
  it('reads back one incident with the evaluations of its rows, oldest first', () => {
    const ledger = open();
    const report = ledger.append({ role: 'front', actor: 'front', op: 'dispatch', summary: 'reminder did not fire', incidentId: 'inc1' });
    const decide = ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: 'rerun the alarm', why: 'timer lost on restart', incidentId: 'inc1', parentSpanId: report });
    ledger.append({ role: 'daily', actor: 'rule:alarm@1', op: 'action', summary: 'other work', incidentId: 'inc2' });
    ledger.append({ role: 'control', actor: 'control', op: 'evaluation', summary: 'fixed', result: 'ok', targetSpanId: decide });

    const { entries, omitted } = ledger.byIncident('inc1');
    expect(entries.map((e) => e.summary)).toEqual(['reminder did not fire', 'rerun the alarm', 'fixed']);
    expect(entries[1].parentSpanId).toBe(report);
    expect(omitted).toBe(0);
    ledger.close();
  });

  it('caps an incident read at the latest rows and says how many were left out', () => {
    const ledger = open();
    for (let i = 0; i < 5; i++) ledger.append({ role: 'daily', actor: 'a', op: 'action', summary: `s${i}`, incidentId: 'inc' });
    const { entries, omitted } = ledger.byIncident('inc', 2);
    expect(entries.map((e) => e.summary)).toEqual(['s3', 's4']);
    expect(omitted).toBe(3);
    ledger.close();
  });

  it('keeps queued rows out of the file until a flush, and commits a kept row at once', () => {
    const ledger = open();
    ledger.append({ role: 'daily', actor: 'a', op: 'action', summary: 'queued' });
    expect(rows()).toBe(0);
    ledger.append({ role: 'control', actor: 'c', op: 'decision', summary: 'kept' });
    expect(rows()).toBe(2);
    ledger.close();
  });

  it('commits when the batch is full', () => {
    const ledger = open({ maxBatch: 3 });
    for (let i = 0; i < 3; i++) ledger.append({ role: 'daily', actor: 'a', op: 'note', summary: `n${i}` });
    expect(rows()).toBe(3);
    ledger.close();
  });

  it('counts routine outcomes per hour without writing rows', () => {
    const ledger = open();
    ledger.count('daily', 'rule:window@1', 'ok');
    ledger.count('daily', 'rule:window@1', 'ok', 4);
    clock = new Date('2026-10-25T15:10:00Z');
    ledger.count('daily', 'rule:window@1', 'ok');
    expect(ledger.tallies('2026-10-25T00', '2026-10-26T00')).toEqual([
      { hour: '2026-10-25T14', role: 'daily', actor: 'rule:window@1', outcome: 'ok', n: 5 },
      { hour: '2026-10-25T15', role: 'daily', actor: 'rule:window@1', outcome: 'ok', n: 1 },
    ]);
    expect(ledger.range('2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z')).toEqual([]);
    ledger.close();
  });

  it('folds expired unkept rows into tallies and keeps decisions forever', () => {
    const ledger = open({ retentionDays: 30 });
    ledger.append({ role: 'daily', actor: 'a', op: 'action', summary: 'old', result: 'fail' });
    ledger.append({ role: 'control', actor: 'c', op: 'decision', summary: 'old decision' });
    clock = new Date('2026-12-01T00:00:00Z');
    ledger.append({ role: 'daily', actor: 'a', op: 'action', summary: 'new' });

    expect(ledger.prune()).toBe(1);
    expect(ledger.range('2000-01-01', '2100-01-01').map((e) => e.summary)).toEqual(['old decision', 'new']);
    expect(ledger.tallies('2026-10-25T14', '2026-10-25T15')).toEqual([
      { hour: '2026-10-25T14', role: 'daily', actor: 'a', outcome: 'action:fail', n: 1 },
    ]);
    expect(ledger.verify()).toBeNull();
    ledger.close();
  });

  it('chains kept rows across restarts and finds an edited one', () => {
    let ledger = open();
    ledger.append({ role: 'control', actor: 'c', op: 'decision', summary: 'first' });
    ledger.append({ role: 'daily', actor: 'a', op: 'action', summary: 'unchained' });
    ledger.close();
    ledger = open();
    ledger.append({ role: 'control', actor: 'c', op: 'escalate', summary: 'second' });
    expect(ledger.verify()).toBeNull();

    raw((db) => db.exec("UPDATE entry SET summary = 'rewritten' WHERE summary = 'first'"));
    expect(ledger.verify()?.summary).toBe('rewritten');
    ledger.close();
  });

  it('renders rows as one line each', () => {
    const ledger = open();
    ledger.append({ role: 'control', actor: 'c', op: 'decision', summary: 'rerun', why: 'timer lost', incidentId: 'inc1' });
    expect(toText(ledger.range('2000', '2100'))).toBe('2026-10-25T14:00:00.000Z | control | c | decision | - | rerun | why: timer lost | incident: inc1');
    ledger.close();
  });
});
