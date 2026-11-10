/**
 * Where the pet may stand while a given window is in front, learnt rather than set. For each window layout (program,
 * display, where the window sits) a strip across the display is kept in bins, and three kinds of evidence add up in
 * each bin:
 * - the look: what the fast window reading (workarea.ts) found, weak on its own, weighted by how sure it was;
 * - activity: where along the window's bottom the person moves the pointer while working; it only adds, since typing
 *   happens wherever the pointer happens to rest;
 * - the person's hand: every move by hand is kept as a record of its own (where from and to, whether the pet was
 *   walking or had stood there long, which arrangement, when); the evidence is worked out from those records each
 *   time, by the rule in placement.ts (`inTheWay`), and fades with their age, so a changed rule applies to all of them;
 * - spots it stood on long without being moved, and corrections the control center marks.
 * A bin is kept out of when its evidence passes a threshold. Nothing here calls a model; the control center is asked
 * only when the person keeps moving the pet away anyway.
 */
import { openDb, type Db } from '../sqlite.ts';
import { inTheWay } from './placement.ts';

/** A move by hand, as recorded: desktop pixels, epoch ms. */
export interface Touch { kind: 'throw' | 'drop'; from: number | null; to: number | null; moving: boolean; stillSec: number | null; at: number }
/** The hand's evidence halves in this many days. */
const TOUCH_HALF_DAYS = 30;

/** Bins across a display. */
export const BINS = 64;
/** Evidence at or above this keeps the pet out. */
export const BLOCK_AT = 0.4;

export interface WindowLook {
  app: string | null;
  /** The area activity counts in: the window, or the bottom band of the display. */
  window: { x: number; y: number; width: number; height: number };
  display: { index: number; x: number; y: number; width: number; height: number };
  zones: Array<[number, number]>;
  confidence: number;
  /** How sure each zone is, when they differ; `confidence` otherwise. */
  confidences?: number[];
  /** What the layout is remembered by, when the caller names it (the windows along the bottom). */
  key?: string;
}

/** Sure finds kept per layout; a stretch is kept out of when at least half of them found it. */
export const FINDS = 8;

interface Map {
  /** Retired: sure finds used to be unioned here, which only ever grew (a full-width window's modes added up). */
  sure?: { zones: Array<[number, number]>; confidence: number; at: string };
  /**
   * What the control center settled for this layout after looking (a case, cases.ts): fractions of the display width
   * to keep out of and to walk freely. Once settled, the rules (the looks, the activity, the hand) no longer move it;
   * only another decision does (WORKAREA-DESIGN W16). The hand's moves still count as signs of trouble.
   */
  settled?: { keepOut: Array<[number, number]>; free: Array<[number, number]>; caseId: string; confidence: number; at: string };
  /** The latest sure finds, oldest first, so one look that misses or overreaches does not decide alone. */
  finds?: Array<{ zones: Array<[number, number]>; confidence: number; at: string }>;
  /** Long stays and the control center's marks, -1 (fine here) .. 1 (in the way here); moves by hand are records of their own. */
  hand: number[];
  /** Where the person was seen working, as counts. */
  heat: number[];
  samples: number;
  updatedAt: string;
}

/** The layout a window is remembered by: program, display, and where the window sits, rounded to 2% of the display. */
export function layoutKey(l: WindowLook): string {
  if (l.key) return l.key;
  const d = l.display, q = (v: number) => Math.round((v / d.width) * 50);
  return `${(l.app ?? '?').toLowerCase()}|${d.index}|${q(l.window.x - d.x)}|${q(l.window.width)}`;
}

export class WorkMap {
  private readonly db: Db;
  private readonly cache = new globalThis.Map<string, Map>();
  private dirty = new Set<string>();
  private lastCursor: { x: number; y: number } | null = null;

  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS layout (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS touch (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, layout TEXT, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS touch_layout ON touch (layout, at);');
  }

  private get(key: string): Map {
    let m = this.cache.get(key);
    if (!m) {
      const row = this.db.prepare('SELECT body FROM layout WHERE key = ?').get(key) as { body: string } | undefined;
      m = row ? (JSON.parse(row.body) as Map) : { hand: new Array(BINS).fill(0), heat: new Array(BINS).fill(0), samples: 0, updatedAt: new Date().toISOString() };
      this.cache.set(key, m);
    }
    return m;
  }

  private bin(l: WindowLook, x: number): number {
    return Math.max(0, Math.min(BINS - 1, Math.floor(((x - l.display.x) / l.display.width) * BINS)));
  }

  /** The evidence in each bin for this layout, 0 none .. above BLOCK_AT kept out of. */
  evidence(l: WindowLook): number[] {
    const key = layoutKey(l), m = this.get(key);
    // settled by a decision: that holds as it was decided, whatever the rules would say now
    if (m.settled) {
      const out = new Array(BINS).fill(0);
      const at = (f: number) => Math.max(0, Math.min(BINS - 1, Math.floor(f * BINS)));
      // free first, so where the two meet the keep-out wins
      for (const [a, b] of m.settled.free) for (let i = at(a); i <= at(b - 1e-9); i++) out[i] = 0;
      for (const [a, b] of m.settled.keepOut) for (let i = at(a); i <= at(b - 1e-9); i++) out[i] = 1;
      return out;
    }
    // a sure look joins the layout's latest finds; the same find again is not counted twice
    if (l.confidence >= 0.6) {
      const sureZones = l.zones.filter((_, i) => (l.confidences?.[i] ?? l.confidence) >= 0.6);
      const finds = m.finds ?? [];
      if (JSON.stringify(finds.at(-1)?.zones) !== JSON.stringify(sureZones)) {
        m.finds = [...finds, { zones: sureZones, confidence: l.confidence, at: new Date().toISOString() }].slice(-FINDS);
        this.touch(key, m);
      }
    }
    const look = new Array(BINS).fill(0);
    const mark = (zs: Array<[number, number]>, conf: (k: number) => number) => zs.forEach(([a, b], k) => {
      for (let i = this.bin(l, a); i <= this.bin(l, b - 1); i++) look[i] = Math.max(look[i], 0.55 * conf(k));
    });
    // this look's zones, each as sure as it is
    mark(l.zones, (k) => l.confidences?.[k] ?? l.confidence);
    // and where most of the latest sure finds agree: a majority, not a union, so the zone can shrink back
    const finds = m.finds ?? [];
    if (finds.length) {
      const votes = new Array(BINS).fill(0), n = new Array(BINS).fill(0);
      for (const f of finds) for (const [a, b] of f.zones) for (let i = this.bin(l, a); i <= this.bin(l, b - 1); i++) { votes[i] += f.confidence; n[i]++; }
      const conf = finds.reduce((s, f) => s + f.confidence, 0);
      // kept at the agreeing finds' own sureness; a stretch only a minority found drops out
      for (let i = 0; i < BINS; i++) if (votes[i]! / conf >= 0.5) look[i] = Math.max(look[i], 0.55 * (votes[i]! / n[i]!) * (l.confidence >= 0.6 ? 1 : 0.9));
    }
    const peak = Math.max(...m.heat, 0);
    // where they were seen working adds, a little; a stretch the look got wrong is set right by the hand, not by absence
    const seen = m.samples >= 12 && peak > 0;
    const hand = this.handEvidence(l, key);
    return look.map((v, i) => v + (seen ? 0.5 * (m.heat[i]! / peak) : 0) + m.hand[i]! + hand[i]!);
  }

  /**
   * The control center's decision for a layout (a case): stretches, as fractions of the display width, to keep out of
   * and to walk freely. Replaces any decision before it.
   */
  settle(key: string, d: { keepOut: Array<[number, number]>; free: Array<[number, number]>; caseId: string; confidence: number }): void {
    const m = this.get(key);
    m.settled = { ...d, at: new Date().toISOString() };
    this.touch(key, m);
    this.flush();
  }

  /** The decision a layout was settled by, or null. */
  settledFor(key: string): Map['settled'] | null {
    return this.get(key).settled ?? null;
  }

  /** The stretches to keep out of, in desktop pixels. */
  zones(l: WindowLook): Array<[number, number]> {
    const e = this.evidence(l), out: Array<[number, number]> = [];
    const at = (i: number) => Math.round(l.display.x + (i / BINS) * l.display.width);
    let start = -1;
    for (let i = 0; i <= BINS; i++) {
      const on = i < BINS && e[i]! >= BLOCK_AT;
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([at(start), at(i)]); start = -1; }
    }
    return out;
  }

  /**
   * The person is active (`idleMs` small) with the pointer at `cursor`: when that is along the window's bottom, where
   * input boxes are, it counts as where they work. Returns true when it counted.
   */
  noteActivity(l: WindowLook, cursor: { x: number; y: number }, idleMs: number): boolean {
    const w = l.window, before = this.lastCursor;
    this.lastCursor = cursor;
    // only a pointer that moved says where they are working
    if (!before || Math.hypot(cursor.x - before.x, cursor.y - before.y) < 4) return false;
    if (idleMs < 0 || idleMs > 3000) return false;
    if (cursor.x < w.x || cursor.x >= w.x + w.width || cursor.y < w.y + w.height * 0.4 || cursor.y > w.y + w.height) return false;
    const key = layoutKey(l), m = this.get(key), c = this.bin(l, cursor.x);
    for (let d = -2; d <= 2; d++) {
      const i = c + d;
      if (i >= 0 && i < BINS) m.heat[i]! += d === 0 ? 1 : Math.abs(d) === 1 ? 0.6 : 0.25;
    }
    // old activity fades, so a layout that changed its use is relearnt
    if (++m.samples % 50 === 0) for (let i = 0; i < BINS; i++) m.heat[i]! *= 0.8;
    this.touch(key, m);
    return true;
  }

  /** Keeps a move by hand as a record of its own, under the arrangement `l` was in front then (null: none known). */
  recordTouch(l: WindowLook | null, e: Touch): void {
    this.db.prepare('INSERT INTO touch (at, layout, body) VALUES (?, ?, ?)').run(e.at, l ? layoutKey(l) : null,
      JSON.stringify({ ...e, displayWidth: l?.display.width ?? null }));
  }

  /** Moves by hand recorded since `since` (epoch ms), newest last, with the arrangement each was under. */
  touches(since = 0): Array<Touch & { layout: string | null; displayWidth: number | null }> {
    return (this.db.prepare('SELECT layout, body FROM touch WHERE at >= ? ORDER BY at').all(since) as Array<{ layout: string | null; body: string }>)
      .map((r) => ({ ...(JSON.parse(r.body) as Touch & { displayWidth: number | null }), layout: r.layout }));
  }

  /** What the recorded moves by hand under this arrangement say, bin by bin, each by the rule and faded by its age. */
  private handEvidence(l: WindowLook, key: string): number[] {
    const out = new Array(BINS).fill(0);
    const now = Date.now();
    const rows = this.db.prepare('SELECT body FROM touch WHERE layout = ?').all(key) as Array<{ body: string }>;
    for (const r of rows) {
      const t = JSON.parse(r.body) as Touch;
      const judged = inTheWay(t, l.display.width);
      const fade = 0.5 ** ((now - t.at) / 86_400_000 / TOUCH_HALF_DAYS);
      if (t.from !== null && judged.weight > 0) this.spreadInto(out, this.bin(l, t.from), (t.kind === 'throw' ? 0.45 : 0.3) * judged.weight * fade);
      // a throw lands wherever it lands; only a put-down far from where it was says where it is fine
      if (t.to !== null && t.kind === 'drop' && judged.weight > 0) this.spreadInto(out, this.bin(l, t.to), -0.35 * fade);
    }
    return out.map((v) => Math.max(-1, Math.min(1, v)));
  }

  /** The pet stood at `x` this long without anyone moving it: a little evidence that it is fine there. */
  noteStay(l: WindowLook, x: number, minutes: number): void {
    const key = layoutKey(l), m = this.get(key);
    this.spread(m, this.bin(l, x), -0.03 * Math.min(minutes, 10), 1);
    this.touch(key, m);
  }

  /** The control center (or the person through it) says: keep out of, or may stand in, this stretch. */
  mark(l: WindowLook, [a, b]: [number, number], keepOut: boolean): void {
    const key = layoutKey(l), m = this.get(key);
    for (let i = this.bin(l, a); i <= this.bin(l, b - 1); i++) m.hand[i] = Math.max(-1, Math.min(1, m.hand[i]! + (keepOut ? 0.6 : -0.6)));
    this.touch(key, m);
  }

  private spread(m: Map, c: number, v: number, radius = 2): void {
    this.spreadInto(m.hand, c, v, radius);
    for (let i = 0; i < BINS; i++) m.hand[i] = Math.max(-1, Math.min(1, m.hand[i]!));
  }

  private spreadInto(arr: number[], c: number, v: number, radius = 2): void {
    for (let d = -radius; d <= radius; d++) {
      const i = c + d;
      if (i >= 0 && i < BINS) arr[i]! += v * (1 - Math.abs(d) / (radius + 1));
    }
  }

  private touch(key: string, m: Map): void {
    m.updatedAt = new Date().toISOString();
    this.dirty.add(key);
  }

  /** Writes what changed; the caller does this every so often rather than on each sample. */
  flush(): void {
    const put = this.db.prepare('INSERT INTO layout (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body');
    for (const key of this.dirty) put.run(key, JSON.stringify(this.cache.get(key)));
    this.dirty.clear();
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}
