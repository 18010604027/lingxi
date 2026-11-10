/**
 * Where the pet may walk, per part and mode: one plan for each window's
 * stretch of the bottom in each of its layouts (scene.ts), in bins across that stretch, so nothing learnt in one window
 * reaches another (W17) and a plan follows its mode wherever the same part shows it again.
 *
 * Each bin holds log-odds that something there is in use, occupancy-grid style (research/workarea-v3.md §2):
 * - the content of this look (scene.ts `contentProfile`): the prior, read anew each look, not kept;
 * - learnt, kept and fading (half-life `HALF_DAYS`), clamped so the hand can always turn a bin over:
 *   - where the person picked the pet up: "not here", most when it was walking (W7, W14);
 *   - where they put it down: "there is fine" (W14);
 *   - where their pointer works in the window;
 *   - where it stood long and nobody moved it.
 * A plan the control center settled (a case) holds as decided; the rules only note trouble then (W16). What is in use
 * this moment (the typing caret) is laid over every plan, not learnt.
 */
import { join } from 'node:path';
import { openDb, type Db } from '../sqlite.ts';

/** Bins across a part. */
export const PBINS = 48;
/** Learnt log-odds are kept within these, so a few moves by hand can always turn a bin. */
const L_MAX = 3;
/** Learnt evidence halves in this many days. */
export const HALF_DAYS = 14;
/** The prior from content: something there, nothing there. */
export const PRIOR = { content: 1.2, blank: -0.6 };
/** What each kind of evidence adds, spread over about the pet's body width. */
export const STEP = {
  /** picked up while walking (its walk cut short) */
  takenWalking: 1.4,
  /** picked up soon after it stood there */
  takenSoon: 0.9,
  /** picked up after standing long */
  takenLate: 0.3,
  /** put down there */
  putDown: -1.2,
  /** landed there after a throw */
  thrownTo: -0.3,
  /** the pointer worked there (per sample) */
  pointer: 0.08,
  /** stood there a minute, nobody moved it */
  stayMinute: -0.05,
};

export type Span = [number, number];
type Settled = { keepOut: Span[]; free: Span[]; caseId: string; confidence: number; at: string };
interface Plan { learnt: number[]; at: number; manualFree?: boolean[]; settled?: Settled; settledVersions?: Settled[]; settledIndex?: number }

export class PlanBook {
  private readonly db: Db;
  private readonly cache = new Map<string, Plan>();

  constructor(dir: string, file = join(dir, 'plans.sqlite')) {
    this.db = openDb(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS plan (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }

  private plan(key: string, now: number): Plan {
    let p = this.cache.get(key);
    if (!p) {
      const row = this.db.prepare('SELECT body FROM plan WHERE key = ?').get(key) as { body: string } | undefined;
      p = row ? JSON.parse(row.body) as Plan : { learnt: new Array(PBINS).fill(0), at: now };
      this.cache.set(key, p);
    }
    // fading: brought up to now on each use
    const days = (now - p.at) / 86_400_000;
    if (days > 0) { const k = 0.5 ** (days / HALF_DAYS); p.learnt = p.learnt.map((v) => v * k); p.at = now; }
    return p;
  }

  private save(key: string, p: Plan): void {
    this.db.prepare('INSERT INTO plan (key, body) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET body = excluded.body').run(key, JSON.stringify(p));
  }

  /** Adds `v` around the bin of `frac` (a share of the part's width), spread over `radius` bins either side. */
  note(key: string, frac: number, v: number, radius = 3, now = Date.now()): void {
    const p = this.plan(key, now), c = binOf(frac);
    for (let d = -radius; d <= radius; d++) {
      const i = c + d;
      if (i < 0 || i >= PBINS) continue;
      const w = 1 - Math.abs(d) / (radius + 1);
      p.learnt[i] = Math.max(-L_MAX, Math.min(L_MAX, p.learnt[i]! + v * w));
    }
    this.save(key, p);
  }

  /** A direct hand placement makes this part of the matched template active, including over a settled keep-out. */
  noteFree(key: string, frac: number, radius: number, now = Date.now()): void {
    const p = this.plan(key, now);
    p.manualFree ??= new Array(PBINS).fill(false);
    const center = binOf(frac);
    for (let i = Math.max(0, center - radius); i <= Math.min(PBINS - 1, center + radius); i++) p.manualFree[i] = true;
    this.save(key, p);
  }

  /** The active bins explicitly selected by direct hand placement in this template. */
  manualFree(key: string): boolean[] { return [...(this.plan(key, Date.now()).manualFree ?? new Array(PBINS).fill(false))]; }

  /** The control center's decision for a part and mode: holds until another decision (W16). */
  settle(key: string, d: { keepOut: Span[]; free: Span[]; caseId: string; confidence: number }, now = Date.now()): void {
    const p = this.plan(key, now);
    const versions = p.settledVersions ?? (p.settled ? [p.settled] : []);
    const settled = { ...d, at: new Date(now).toISOString() };
    p.settledVersions = [...versions, settled];
    p.settledIndex = p.settledVersions.length - 1;
    p.settled = settled;
    this.save(key, p);
  }

  /** Restores the previous control-center decision without deleting either decision from the stored history. */
  rollbackSettled(key: string): Settled | null {
    const p = this.plan(key, Date.now());
    const versions = p.settledVersions ?? (p.settled ? [p.settled] : []);
    const index = p.settledIndex ?? (versions.length - 1);
    if (index <= 0) return null;
    p.settledVersions = versions;
    p.settledIndex = index - 1;
    p.settled = versions[index - 1]!;
    this.save(key, p);
    return p.settled;
  }

  /** Decisions made for a part and mode, oldest first. */
  settledHistory(key: string): Settled[] {
    const p = this.plan(key, Date.now());
    return p.settledVersions ? [...p.settledVersions] : p.settled ? [p.settled] : [];
  }

  settledFor(key: string): Plan['settled'] | null {
    return this.plan(key, Date.now()).settled ?? null;
  }

  /**
   * Bins in use for a part and mode: settled ones as decided; otherwise this look's content prior plus what was
   * learnt, above zero. `content` is the content share per bin (scene.ts), or null when this look has none.
   */
  blocked(key: string, content: number[] | null, threshold: number, now = Date.now()): boolean[] {
    const p = this.plan(key, now);
    let out: boolean[];
    if (p.settled) {
      out = new Array(PBINS).fill(false);
      for (const [a, b] of p.settled.keepOut) for (let i = binOf(a); i <= binOf(b - 1e-9); i++) out[i] = true;
      for (const [a, b] of p.settled.free) for (let i = binOf(a); i <= binOf(b - 1e-9); i++) out[i] = false;
    } else {
      out = p.learnt.map((l, i) => (content ? (content[i]! >= threshold ? PRIOR.content : PRIOR.blank) : 0) + l > 0);
    }
    for (let i = 0; i < PBINS; i++) if (p.manualFree?.[i]) out[i] = false;
    return out;
  }

  /** What was learnt for a part and mode, per bin (for the case's facts). */
  learnt(key: string): number[] {
    return [...this.plan(key, Date.now()).learnt];
  }

  close(): void {
    this.db.close();
  }
}

export const binOf = (frac: number): number => Math.max(0, Math.min(PBINS - 1, Math.floor(frac * PBINS)));

/** The plan key of a part in a mode. */
export const planKey = (part: string, mode: number): string => `${part}#${mode}`;

/** Bins in use, as stretches of desktop pixels across the part [from, to]. */
export function spansOf(blocked: boolean[], from: number, to: number): Span[] {
  const w = to - from, out: Span[] = [];
  let start = -1;
  for (let i = 0; i <= blocked.length; i++) {
    const on = i < blocked.length && blocked[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([Math.round(from + (start / blocked.length) * w), Math.round(from + (i / blocked.length) * w)]); start = -1; }
  }
  return out;
}

/** Stretches sorted and joined where they overlap or the gap between them is under `gap` (pixels). */
export function mergeNarrow(spans: Span[], gap: number): Span[] {
  const out: Span[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out.at(-1);
    if (last && a - last[1] < gap) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Joins the mode plan with certain current window detections and the live caret. */
export function combineWorkareaZones(planned: Span[], detected: Span[], confidences: number[], caret: Span[], bodyPx: number, handFree: Span[] = []): Span[] {
  const certain = detected.filter((_, i) => (confidences[i] ?? 0) >= 0.8);
  const blocked = mergeNarrow([...planned, ...certain, ...caret], bodyPx * 1.5);
  // The caret remains forbidden even when it overlaps a hand landing. Subtract only the rest of the opening after
  // merging the inferred narrow gaps, so the merge cannot close the directly selected active spot again.
  const openings = handFree.flatMap((opening) => subtractSpans([opening], caret));
  return subtractSpans(blocked, openings);
}

/** Removes hand-placed active spans from inferred or planned keep-out spans. */
export function subtractSpans(spans: Span[], openings: Span[]): Span[] {
  let out = spans.map(([a, b]) => [a, b] as Span);
  for (const [openA, openB] of openings) {
    out = out.flatMap(([a, b]) => {
      if (openB <= a || openA >= b) return [[a, b] as Span];
      const pieces: Span[] = [];
      if (openA > a) pieces.push([a, Math.min(openA, b)]);
      if (openB < b) pieces.push([Math.max(openB, a), b]);
      return pieces;
    });
  }
  return out.filter(([a, b]) => b > a);
}

/** How a move by hand counts where it was picked up: walking (cut short), soon after it stood there, or after long. */
export function takenStep(e: { kind: string; moving: boolean; stillSec: number | null }): number {
  const base = e.moving ? STEP.takenWalking : e.stillSec !== null && e.stillSec <= 120 ? STEP.takenSoon : STEP.takenLate;
  // a throw may be play: it counts for less where it was picked up
  return e.kind === 'throw' ? base * 0.6 : base;
}
