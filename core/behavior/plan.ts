/**
 * How the behaviour system turns "go there" into moves: one move is one pass of a moving clip, still for `leadSec`
 * at its start and `tailSec`
 * at its end, carrying the body `minDist`–`maxDist` in between (at the figure's reference width, scaled to the
 * body's). Going farther is ours to decide: as few moves as the way needs, of equal length, each inside the clip's
 * range. A way shorter than half the least is not walked.
 */
export interface MoveClip {
  clip: string; leadSec: number; tailSec: number; minDist: number; maxDist: number;
  /** Optional media duration and cutoff for a clip whose later frames should not be shown. */
  durationSec?: number; endSec?: number;
  /** A continuous, native-speed subrange; the body may loop only this range. */
  segment?: { startSec: number; endSec: number };
  /** False keeps a deliberately slow style available only when named. */
  default?: boolean;
  /** How the front names this way of moving, what it looks like, and when to pick it over the others (the pack's
   * id/zh/bout/when): the front knows the difference and chooses, rather than one random walk. */
  id?: string; zh?: string[]; en?: string[]; about?: string; when?: string;
  /** How this way of moving feels, as free tags the selectors match on. */
  mood?: string[];
}

export interface Figure {
  name: string;
  /** Free text the pack wants to keep about itself; the code never reads it. */
  source?: string;
  /** The body width the move distances were made for, in pixels. */
  refWidth: number;
  /** The width the figure is drawn at. */
  bodyWidth: number;
  /** Which way the character faces in the clips as made; the other way is mirrored. */
  nativeFacing: 'left' | 'right';
  idle: string[];
  held: string[];
  /** The clip canvas, so her drawn width can be worked out from `hit.box`. */
  canvas?: { width: number; height: number };
  /** Where her body may be touched, in the clip canvas (the pack's `hit.box`); the body keeps the default otherwise. */
  hit?: { box?: { x0: number; y0: number; x1: number; y1: number } };
  /** Clips with writing in them, which read wrong mirrored. */
  noMirror: string[];
  moves: {
    walk: MoveClip[];
    run: MoveClip[];
    /** Whether the body supports instant obstacle crossings; false uses the one configured `cross` move instead. */
    teleport?: boolean;
    /** How this figure gets across a stretch she may not walk through (the pack says which clip, at what speed);
     * the run is used when the pack names nothing. */
    cross?: MoveClip;
  };
  /** Action words to the clips that show them; one is picked each time. */
  words: Record<string, string[]>;
  /** How the front writes each word (`walk`, `run` and the words above): kind, Chinese names, what it looks like, and
   * when to reach for it (the pack's `when`). */
  vocab?: Record<string, { kind: 'expression' | 'motion'; zh: string[]; about: string; en?: string[]; when?: string; whenEn?: string;
    /** How the action feels, as free tags (`calm`, `happy`, `shy`, ...): the front and the daily layer choose by them. */
    mood?: string[] }>;
}

export interface Step { clip: string; x: number; leadSec: number; tailSec: number; endSec?: number; segment?: { startSec: number; endSec: number; durationSec: number } }
export interface Travel { facing: 'left' | 'right'; steps: Step[] }

/**
 * The steps from `from` to `to` (shares of a work area `areaPx` wide) with `move`, for a body `bodyPx` wide; null when
 * the way is shorter than half the clip's least stride, so not worth a walk.
 */
export function planTravel(from: number, to: number, areaPx: number, bodyPx: number, refWidth: number, move: MoveClip): Travel | null {
  const scale = bodyPx / refWidth;
  const distPx = Math.abs(to - from) * areaPx;
  const least = move.minDist * scale;
  const most = move.maxDist * scale;
  if (distPx < least / 2) return null;
  // A segmented clip carries a whole legal leg at native speed.  Its range
  // describes the stride rate, while the body loops the known moving frames;
  // splitting here would replay the start and stop frames for every chunk.
  const count = move.segment ? 1 : Math.max(1, Math.ceil(distPx / most));
  const dir = Math.sign(to - from);
  const tailSec = move.endSec !== undefined && move.durationSec !== undefined
    ? Math.max(move.tailSec, move.durationSec - move.endSec) : move.tailSec;
  const steps: Step[] = [];
  const segment = move.segment;
  // Keep the existing maximum stride per active media second.  The old
  // lead/tail describe a full pass; they are not repeated in segment mode.
  const strideSec = move.durationSec !== undefined
    ? Math.min(move.endSec ?? move.durationSec, move.durationSec - move.tailSec) - move.leadSec
    : segment ? segment.endSec - segment.startSec : 0;
  const segmentDuration = segment ? (distPx / most) * strideSec : null;
  for (let i = 1; i <= count; i++) {
    steps.push({ clip: move.clip, x: from + (dir * distPx * i) / count / areaPx,
      leadSec: segment ? 0 : move.leadSec, tailSec: segment ? 0 : tailSec,
      ...(!segment && move.endSec !== undefined ? { endSec: move.endSec } : {}),
      ...(segment && segmentDuration !== null ? { segment: { ...segment, durationSec: segmentDuration } } : {}) });
  }
  return { facing: dir > 0 ? 'right' : 'left', steps };
}

/**
 * One clip that carries her the whole way across: no stops, no second clip (user, 10-29 — a crossing is one run in one
 * breath). The distance goes in a single step, so a longer stretch is covered faster rather than in more steps.
 */
export function crossTravel(from: number, to: number, move: MoveClip, areaPx = 1, bodyPx = 1, refWidth = 1): Travel | null {
  if (Math.abs(to - from) < 1e-4) return null;
  if (move.segment) return planTravel(from, to, areaPx, bodyPx, refWidth, { ...move, minDist: 0 });
  const tailSec = move.endSec !== undefined && move.durationSec !== undefined
    ? Math.max(move.tailSec, move.durationSec - move.endSec) : move.tailSec;
  return { facing: to > from ? 'right' : 'left', steps: [{ clip: move.clip, x: to, leadSec: move.leadSec, tailSec,
    ...(move.endSec !== undefined ? { endSec: move.endSec } : {}) }] };
}

/** One of `list`, by `random` (0..1). */
export function pick<T>(list: readonly T[], random: () => number = Math.random): T {
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
}

/** Stretches of the work area she may not stand in, as shares of its width: [from, to]. */
export type Zone = [number, number];

/** Whether she may stand at `x`. */
export function allowed(x: number, zones: readonly Zone[]): boolean {
  return !zones.some(([a, b]) => x > a && x < b);
}

/** The exact legal edge nearest `x`; null when there is no reachable position in [lo, hi]. */
export function nearestAllowed(x: number, zones: readonly Zone[], lo = 0, hi = 1, _step = 0.005): number | null {
  const c = Math.max(lo, Math.min(hi, x));
  if (allowed(c, zones)) return c;
  // Consider exact legal edges, including narrow gaps that a fixed sampling step could skip. Filter every edge
  // against all zones so an overlapping interval cannot turn an interior edge into a false exit.
  return zones.flatMap(([a, b]) => [a, b]).filter((p) => p >= lo && p <= hi && p > 0 && p < 1 && allowed(p, zones))
    .sort((a, b) => Math.abs(a - c) - Math.abs(b - c) || a - b)[0] ?? null;
}

export type Leg = { kind: 'walk'; to: number } | { kind: 'cross'; to: number };

/**
 * The way from `from` to `to` as legs: walking where she may stand, crossing a stretch she may not in one fast run (to `gap`
 * past its far edge), so she never walks over where the person works.
 */
export function route(from: number, to: number, zones: readonly Zone[], gap = 0.01): Leg[] {
  const dir = Math.sign(to - from);
  if (dir === 0) return [];
  // Overlapping keep-outs are one obstacle: their individual edges are not legal landing places.
  const merged: Zone[] = [];
  for (const [a, b] of [...zones].sort((p, q) => p[0] - q[0])) {
    const previous = merged.at(-1);
    if (previous && a < previous[1]) previous[1] = Math.max(previous[1], b);
    else merged.push([a, b]);
  }
  zones = merged;
  // If the body is already in a kept out stretch, leave it through the nearest legal edge first.
  // This is mechanical recovery; it does not reinterpret an explicit destination.
  const inside = zones.find(([a, b]) => from > a && from < b);
  if (inside) {
    const [a, b] = inside;
    const left = a - gap, right = b + gap;
    const exit = Math.abs(from - left) <= Math.abs(right - from) ? left : right;
    return [{ kind: 'cross', to: exit }, ...route(exit, to, zones, gap)];
  }
  const crossed = zones
    .filter(([a, b]) => (dir > 0 ? a >= from && a < to : b <= from && b > to))
    .sort((p, q) => (dir > 0 ? p[0] - q[0] : q[1] - p[1]));
  const legs: Leg[] = [];
  let at = from;
  for (const [a, b] of crossed) {
    const near = dir > 0 ? a - gap : b + gap;
    const far = dir > 0 ? b + gap : a - gap;
    if ((near - at) * dir > 0) legs.push({ kind: 'walk', to: near });
    legs.push({ kind: 'cross', to: far });
    at = far;
  }
  if ((to - at) * dir > 0) legs.push({ kind: 'walk', to });
  return legs;
}
