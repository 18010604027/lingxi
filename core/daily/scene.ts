/**
 * The scene along the bottom of a display: which windows sit along the bottom
 * line and where (the combination), and what each of them shows there (its part's mode).
 *
 * - A part is one window's stretch of the bottom: display and where it sits and how wide, in 2% steps of the
 *   display width. The same program full width and half width are different parts: interfaces change with width.
 * - A mode is one layout of a part, told by its structure: the long edges in the strip the pet's body would cover,
 *   compared mainly by the horizontal ones (an input box's top and bottom, a toolbar's edge, each with where it
 *   starts and ends along the width, which is what walking along the bottom cares about). Vertical edges count half:
 *   on the replay they were the noisy ones (the pet, icons, text), while the horizontal edges held still. Text is
 *   short scattered edges and leaves no long edge, so chat moving through the strip does not change it; the pet's own
 *   body is masked out. Pixel fingerprints (pHash with dHash, as UI-Oceanus pairs them) were tried first and failed
 *   on the replay: the same page differed by 25–55 bits of 128 between looks, as much as different programs did
 *   (scripts/scene-calibrate.ts).
 * - Titles are left out: a chat window's title changes with the conversation and would split one page into many.
 * - A look unlike every known mode is only a new mode when the next look is like it too; until then it is a flash (a
 *   menu, a notice) and the part keeps its last mode, less sure.
 * Matching is by these numbers only; no model is asked (a match that looks right but is not shows as trouble later,
 * and the control center sorts that out, §五).
 *
 * What is there along the bottom (`occupied`) is measured as content, not as lines (二之一): short dense edges, the
 * strokes of text, icons and controls, over the pet's body width; long lines are taken out, so the bottom of a chart
 * is free while a row of buttons is not.
 */
import { join } from 'node:path';
import { openDb, type Db } from '../sqlite.ts';

/** A grey image: row-major, one byte a pixel. */
export interface Gray { width: number; height: number; data: Uint8Array }
/**
 * The long edges of a part's strip. `rows`: horizontal edges, each its height (fraction of the strip's height) and where
 * it runs along the width (fractions of the part's width). `cols`: vertical edges, where they are along the width.
 */
export interface Structure { rows: Array<{ y: number; from: number; to: number }>; cols: number[] }

/** Unmatched edges (a horizontal one counts 1, a vertical one ½) at or under which two looks are the same mode. */
export const SAME = 2;
/** Looks running like each other before an unknown look becomes a mode of its own. */
export const PERSIST = 2;
/** The pet's height in physical pixels, about: the strip whose structure counts. */
export const PET_H = 150;

/** A brightness step between neighbours counted as an edge (0–255); light themes draw frames faintly. */
const EDGE = 6;
/** A line runs along at least this share of the strip's height (vertical) or of the part's width (horizontal). */
const LONG_V = 0.5, LONG_H = 0.15;
/** Lines this close are one line (fractions); and how far apart two lines may be and still match. */
const MERGE_V = 0.01, MERGE_H = 0.04, TOL_V = 0.015, TOL_H = 0.03, TOL_SPAN = 0.03;
/** What a vertical edge counts for, against a horizontal one's 1. */
const VERTICAL = 0.5;

/** Geometry identifies a part; program names and titles are labels, never template identity. */
export function partKey(display: { index: number; x: number; width: number; y?: number; height?: number }, app: string | null, from: number, to: number,
  window?: { y: number; height: number }): string {
  const q = (v: number) => Math.round(((v - display.x) / display.width) * 50);
  const vertical = window && display.height ? `^${Math.round(((window.y - (display.y ?? 0)) / display.height) * 50)}+${Math.round((window.height / display.height) * 50)}` : '';
  return `${display.index}|@${q(from)}+${q(to) - q(from)}${vertical}`;
}

/** The rows of a band from `top` (pixels) for `height`: the strip the pet's body would cover. */
export function rowsOf(g: Gray, top: number, height: number): Gray {
  const t = Math.max(0, Math.min(g.height - 1, Math.round(top))), b = Math.max(t + 1, Math.min(g.height, Math.round(top + height)));
  return { width: g.width, height: b - t, data: g.data.subarray(t * g.width, b * g.width) };
}

/**
 * The structure of columns [x0, x1) of a strip, with columns in `masked` (pixel spans, the pet's body) left out: an
 * edge touching them does not count, and a line inside them is not a line.
 */
export function structure(g: Gray, x0: number, x1: number, masked: Array<[number, number]> = []): Structure {
  const a = Math.max(0, Math.round(x0)), b = Math.min(g.width, Math.round(x1)), w = b - a, h = g.height;
  const cols: number[] = [], rows: Array<{ y: number; from: number; to: number }> = [];
  if (w < 4 || h < 4) return { cols, rows };
  const hidden = new Uint8Array(g.width);
  for (const [m0, m1] of masked) for (let x = Math.max(0, Math.floor(m0)); x < Math.min(g.width, Math.ceil(m1)); x++) hidden[x] = 1;
  const at = (x: number, y: number) => g.data[y * g.width + x]!;
  for (let x = a; x < b - 1; x++) {
    if (hidden[x] || hidden[x + 1]) continue;
    let n = 0;
    for (let y = 0; y < h; y++) if (Math.abs(at(x + 1, y) - at(x, y)) >= EDGE) n++;
    if (n >= LONG_V * h) cols.push((x - a + 0.5) / w);
  }
  for (let y = 0; y < h - 1; y++) {
    // the long runs of edge along the row, each where it starts and ends: a frame's edge is one run, text gives many
    // short ones; a hidden column neither breaks nor makes a run
    let start = -1, len = 0;
    const end = (x: number) => { if (len >= LONG_H * w) rows.push({ y: (y + 0.5) / h, from: (start - a) / w, to: (x - a) / w }); start = -1; len = 0; };
    for (let x = a; x < b; x++) {
      if (hidden[x]) continue;
      if (Math.abs(at(x, y + 1) - at(x, y)) >= EDGE) { if (start < 0) start = x; len++; } else if (start >= 0) end(x);
    }
    if (start >= 0) end(b);
  }
  const mergeCols = cols.reduce<number[]>((out, x) => (out.length && x - out.at(-1)! < MERGE_V ? out : [...out, x]), []);
  // the rows of one edge (an edge a few pixels thick) are one: near in height and running over the same stretch
  const mergeRows = rows.reduce<typeof rows>((out, r) => {
    const twin = out.find((o) => r.y - o.y < MERGE_H && Math.abs(o.from - r.from) <= TOL_SPAN && Math.abs(o.to - r.to) <= TOL_SPAN);
    return twin ? out : [...out, r];
  }, []);
  return { cols: mergeCols, rows: mergeRows };
}

/** How unlike two structures are: edges of either with no edge of the other near it, horizontal ones counting most. */
export function structureDistance(s: Structure, t: Structure): number {
  const near = (p: Structure['rows'][number], q: Structure['rows'][number]) => Math.abs(p.y - q.y) <= TOL_H && Math.abs(p.from - q.from) <= TOL_SPAN && Math.abs(p.to - q.to) <= TOL_SPAN;
  const rowsOff = s.rows.filter((p) => !t.rows.some((q) => near(p, q))).length + t.rows.filter((p) => !s.rows.some((q) => near(p, q))).length;
  const colsOff = (xs: number[], ys: number[]) => xs.filter((x) => !ys.some((y) => Math.abs(x - y) <= TOL_V)).length;
  return rowsOff + VERTICAL * (colsOff(s.cols, t.cols) + colsOff(t.cols, s.cols));
}

export interface Mode { id: number; part: string; structure: Structure; firstSeen: number; lastSeen: number; seen: number }
/** What a look of a part was taken for: a known mode, a new one, or a flash shown over the last mode. */
export interface Identified { mode: Mode; status: 'same' | 'new' | 'flash'; distance: number }

/** The modes of every part, kept in `scene.sqlite`, with what each part showed last. */
export class ModeBook {
  private readonly db: Db;
  /** Per part: the mode it was last taken to be, and an unknown look waiting to be seen again. */
  private readonly last = new Map<string, { mode: Mode; pending: { structure: Structure; count: number } | null }>();

  constructor(dir: string, file = join(dir, 'scene.sqlite')) {
    this.db = openDb(file);
    this.db.exec(`CREATE TABLE IF NOT EXISTS mode (id INTEGER PRIMARY KEY, part TEXT NOT NULL, structure TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, seen INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS mode_part ON mode (part);`);
  }

  modes(part: string): Mode[] {
    // Existing records keep their original part and plan keys. Match their geometry aliases without rewriting
    // stored plans; identify() still requires the current image structure to match before reusing any plan.
    const alias = part.includes('|@') ? part.replace('|@', '|%@') : part;
    return (this.db.prepare('SELECT id, part, structure, first_seen, last_seen, seen FROM mode WHERE part = ? OR part LIKE ? ORDER BY id').all(part, alias) as Array<Record<string, unknown>>)
      .map((r) => ({ id: Number(r.id), part: String(r.part), structure: JSON.parse(String(r.structure)) as Structure,
        firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), seen: Number(r.seen) }));
  }

  /** Takes one look of a part: which mode it shows. */
  identify(part: string, s: Structure, now = Date.now()): Identified {
    const known = this.modes(part);
    let best: Mode | null = null, bestD = Infinity;
    for (const m of known) { const d = structureDistance(m.structure, s); if (d < bestD) { best = m; bestD = d; } }
    const was = this.last.get(part);
    if (best && bestD <= SAME) {
      this.db.prepare('UPDATE mode SET last_seen = ?, seen = seen + 1 WHERE id = ?').run(now, best.id);
      const mode = { ...best, lastSeen: now, seen: best.seen + 1 };
      this.last.set(part, { mode, pending: null });
      return { mode, status: 'same', distance: bestD };
    }
    // unlike every known mode: a mode of its own once it holds; the first look of a part is one straight away
    const pending = was?.pending && structureDistance(was.pending.structure, s) <= SAME ? { structure: s, count: was.pending.count + 1 } : { structure: s, count: 1 };
    if (!known.length || pending.count >= PERSIST) {
      const id = Number(this.db.prepare('INSERT INTO mode (part, structure, first_seen, last_seen, seen) VALUES (?, ?, ?, ?, 1)')
        .run(part, JSON.stringify(s), now, now).lastInsertRowid);
      const mode: Mode = { id, part, structure: s, firstSeen: now, lastSeen: now, seen: 1 };
      this.last.set(part, { mode, pending: null });
      return { mode, status: 'new', distance: bestD };
    }
    // a flash: the part keeps the mode it showed (after a restart, the nearest known one)
    const keep = was?.mode ?? best!;
    this.last.set(part, { mode: keep, pending });
    return { mode: keep, status: 'flash', distance: bestD };
  }

  close(): void {
    this.db.close();
  }
}

/** One part of a look at the bottom, and the mode it was taken for. */
export interface PartLook { key: string; app: string | null; title: string; from: number; to: number; structure: Structure; seen: Identified }

/** What `readScene` and `occupied` need of a reading of the bottom (bottomstrip.ts StripLook). */
export interface SceneInput {
  display: { index: number; x: number; y?: number; width: number; height?: number; scale: number };
  stretches: Array<{ from: number; to: number; window: { app: string | null; title: string; rect: { y: number; height: number } } }>;
  gray?: { width: number; height: number; data: Uint8Array; top: number } | null;
  pets?: Array<{ x: number; width: number }>;
}

/** For each window along the bottom: the strip its body would cover, just above that window's bottom edge (so the taskbar below is left out). */
function strips(look: SceneInput): Array<{ s: SceneInput['stretches'][number]; strip: Gray; k: number; masked: Array<[number, number]> }> {
  const g = look.gray!;
  const d = look.display, k = g.width / d.width, petH = PET_H * (d.scale || 1) * k;
  const masked = (look.pets ?? []).map((p) => [(p.x - d.x) * k, (p.x + p.width - d.x) * k] as [number, number]);
  return look.stretches.map((s) => {
    const bottom = Math.min(g.height, (s.window.rect.y + s.window.rect.height - g.top) * k);
    return { s, strip: rowsOf({ width: g.width, height: g.height, data: g.data }, bottom - petH, petH), k, masked };
  });
}

/** The parts of a full look and their modes, the pet's own body masked. Empty for a look without the band. */
export function readScene(look: SceneInput, book: ModeBook, now = Date.now()): PartLook[] {
  if (!look.gray) return [];
  const d = look.display;
  return strips(look).map(({ s, strip, k, masked }) => {
    const st = structure(strip, (s.from - d.x) * k, (s.to - d.x) * k, masked);
    const key = partKey(d, s.window.app, s.from, s.to, s.window.rect);
    return { key, app: s.window.app, title: s.window.title, from: s.from, to: s.to, structure: st, seen: book.identify(key, st, now) };
  });
}

/** A step between neighbours counted as a stroke (0–255), and a run this long (pixels of the band) as a line rather than strokes. */
const INK = 24, LINE_PX = 40;

/**
 * How much there is at each column of a strip (WORKAREA-DESIGN 二之一 §2): the share of pixels, over a window of the
 * pet's body width, that are short edges, the strokes of text, icons and controls. Long lines (an axis, a divider, a
 * frame's edge, a window's edge) are taken out first: an edge alone is not something in the way, and a strip that is
 * blank but for a few lines is free. Masked columns (the pet's body) count as blank.
 */
export function contentProfile(g: Gray, body: number, masked: Array<[number, number]> = []): Float64Array {
  const w = g.width, h = g.height, at = (x: number, y: number) => g.data[y * w + x]!;
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    if (Math.abs(at(x + 1, y) - at(x, y)) >= INK || Math.abs(at(x, y + 1) - at(x, y)) >= INK) edge[y * w + x] = 1;
  }
  // long horizontal runs and long vertical runs are lines, not content
  for (let y = 0; y < h; y++) {
    let s = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && edge[y * w + x] === 1;
      if (on && s < 0) s = x;
      if (!on && s >= 0) { if (x - s >= LINE_PX) for (let i = s; i < x; i++) edge[y * w + i] = 2; s = -1; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && edge[y * w + x] !== 0;
      if (on && s < 0) s = y;
      if (!on && s >= 0) { if (y - s >= LONG_V * h) for (let i = s; i < y; i++) edge[i * w + x] = 2; s = -1; }
    }
  }
  const hidden = new Uint8Array(w);
  for (const [m0, m1] of masked) for (let x = Math.max(0, Math.floor(m0)); x < Math.min(w, Math.ceil(m1)); x++) hidden[x] = 1;
  const col = new Float64Array(w);
  for (let x = 0; x < w; x++) if (!hidden[x]) { let n = 0; for (let y = 0; y < h; y++) if (edge[y * w + x] === 1) n++; col[x] = n / h; }
  // the share over the body's width around each column
  const out = new Float64Array(w), half = Math.max(1, Math.round(body / 2));
  let sum = 0;
  for (let x = 0; x < Math.min(w, half); x++) sum += col[x]!;
  for (let x = 0; x < w; x++) {
    if (x + half < w) sum += col[x + half]!;
    if (x - half - 1 >= 0) sum -= col[x - half - 1]!;
    out[x] = sum / (Math.min(w - 1, x + half) - Math.max(0, x - half) + 1);
  }
  return out;
}

/** Content at or above this share (short edges over the body's width) is something there; blank and a few lines are under it. */
export const CONTENT = 0.02;

/**
 * Where along the bottom something is (WORKAREA-DESIGN 二之一): for each window, the columns whose content over the
 * pet's body width (`bodyPx`, desktop pixels) reaches CONTENT, in desktop pixels; a gap between two such stretches
 * narrower than the body is taken in too, since the body cannot stand there. Long lines (an axis, a divider, a
 * window's edge) do not count: the bottom of a chart is free. This is the reading of this moment, not something learnt.
 */
export function occupied(look: SceneInput, bodyPx: number): Array<[number, number]> {
  if (!look.gray) return [];
  const d = look.display, out: Array<[number, number]> = [];
  for (const { s, strip, k, masked } of strips(look)) {
    const desk = (c: number) => Math.round(d.x + c / k);
    const prof = contentProfile(strip, bodyPx * k, masked);
    const a = Math.max(0, Math.floor((s.from - d.x) * k)), b = Math.min(strip.width, Math.ceil((s.to - d.x) * k));
    let start = -1;
    for (let c = a; c <= b; c++) {
      const on = c < b && prof[c]! >= CONTENT;
      if (on && start < 0) start = c;
      if (!on && start >= 0) {
        const last = out.at(-1);
        if (last && desk(start) - last[1] < bodyPx) last[1] = desk(c);
        else out.push([desk(start), desk(c)]);
        start = -1;
      }
    }
  }
  return out;
}

/**
 * The content of each window's strip in `bins` across its stretch (the share of short edges over the pet's body width,
 * `contentProfile`, the most in each bin), in the order of `look.stretches`; null for a look without the band.
 */
export function partContents(look: SceneInput, bodyPx: number, bins: number): Array<number[]> | null {
  if (!look.gray) return null;
  const d = look.display;
  return strips(look).map(({ s, strip, k, masked }) => {
    const prof = contentProfile(strip, bodyPx * k, masked);
    const a = (s.from - d.x) * k, b = (s.to - d.x) * k, out = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) {
      const c0 = Math.max(0, Math.floor(a + (i / bins) * (b - a))), c1 = Math.min(strip.width, Math.ceil(a + ((i + 1) / bins) * (b - a)));
      for (let c = c0; c < c1; c++) out[i] = Math.max(out[i]!, prof[c]!);
    }
    return out;
  });
}
