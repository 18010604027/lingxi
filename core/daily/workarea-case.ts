/**
 * Where the pet may walk, as a case for the control center: built when the
 * person's hand shows plain trouble, or the zones cover most of the screen. It carries the bottom of the screen as a
 * marked picture, the pet's recent moves and the person's (where each was picked up and put down, and whether it was
 * walking), what the window reading and edge detection found, what the pet keeps out of now and why, and every
 * decision made on this arrangement before. The answer, once sure enough, settles the arrangement (workmap.ts
 * `settle`): the rules stop moving it, and only another decision does (W16).
 */
import type { CaseKind, CaseSection, StoredCase } from '../agents/cases.ts';

export const WORKAREA_KIND = 'workarea';
/** An answer at least this sure settles the arrangement; a less sure one is only kept as history. */
export const SETTLE_AT = 0.6;
/** Kept-out stretches over this share of the width are trouble on their own. */
export const TOO_WIDE = 0.6;

const VERDICTS = ['in_the_way', 'zone_wrong', 'both', 'play', 'unclear'] as const;

export const WORKAREA_ANSWER = [
  'Answer as JSON, every position in percent of the screen width (0 = left edge, 100 = right edge), read off the ticks:',
  '{',
  '  "segments": [{"from": 0, "to": 12, "what": "Claude: conversation list"}, ...],   // what is along the bottom, left to right, all of it',
  '  "work": [{"from": 30, "to": 70, "what": "chat input box"}],                       // where the person types or works',
  '  "verdict": "in_the_way" | "zone_wrong" | "both" | "play" | "unclear",',
  '      // in_the_way: the pet stood or walked where they work; zone_wrong: the red stretches are wrong (too wide, too narrow, misplaced)',
  '  "keep_out": [[30, 70]],     // where the pet must not stand or walk, as it should be',
  '  "free": [[0, 30], [70, 100]], // where it may walk freely (a plain, empty area is fine)',
  '  "moves_mean": "left_here" | "go_there" | "both" | "play",  // what the person\'s moves say: not here, or over there',
  '  "mode": "Claude, chat page",   // what this screen is, in a few words',
  '  "same_mode_as_before": true | false | null,  // whether it is the same kind of screen as the decisions before, or only looks like it',
  '  "why": "...",            // what you see in the picture and the facts that decide it, concretely',
  '  "confidence": 0.8        // 0..1; under 0.6 nothing changes, the answer is only kept',
  '}',
].join('\n');

type Span = [number, number];

function spans(v: unknown): Span[] | null {
  if (!Array.isArray(v)) return null;
  const out: Span[] = [];
  for (const s of v) {
    if (!Array.isArray(s) || s.length !== 2) return null;
    const [a, b] = s.map(Number) as [number, number];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > 100 || a >= b) return null;
    out.push([a, b]);
  }
  return out;
}

const pct = ([a, b]: Span) => `${Math.round(a)}–${Math.round(b)}%`;

/**
 * The work-area kind of case. A sure answer settles the plan the case is about (`key`, a part and mode, plans.ts)
 * through `settle`, given the stretches as shares of the screen's width; it returns what it did.
 */
export function workareaKind(settle: (c: StoredCase, keepOut: Span[], free: Span[], confidence: number) => string): CaseKind {
  return {
    answerFormat: WORKAREA_ANSWER,
    check(a) {
      if (!VERDICTS.includes(a.verdict as never)) return `verdict must be one of ${VERDICTS.join(', ')}`;
      if (!spans(a.keep_out)) return 'keep_out must be a list of [from, to] in percent, from < to, within 0..100';
      if (!spans(a.free)) return 'free must be a list of [from, to] in percent, from < to, within 0..100';
      if (!Array.isArray(a.segments) || !a.segments.length) return 'segments must say what is along the bottom, left to right';
      if (typeof a.why !== 'string' || a.why.trim().length < 15) return 'why must say concretely what you see and what decides it';
      const c = Number(a.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) return 'confidence must be a number from 0 to 1';
      return null;
    },
    apply(c: StoredCase, a) {
      const keepOut = spans(a.keep_out)!, free = spans(a.free)!, confidence = Number(a.confidence);
      if (confidence < SETTLE_AT) return `kept only (confidence ${confidence.toFixed(2)}): keep out ${keepOut.map(pct).join(', ') || 'nothing'}`;
      const frac = (s: Span[]) => s.map(([x, y]) => [x / 100, y / 100] as Span);
      return settle(c, frac(keepOut), frac(free), confidence);
    },
    describe(d) {
      const a = d.answer;
      const keep = spans(a.keep_out)?.map(pct).join(', ') || 'nothing';
      return `${d.at.slice(0, 16).replace('T', ' ')} [${String(a.verdict)}; mode ${String(a.mode ?? '?')}; confidence ${String(a.confidence)}] keep out ${keep} — ${String(a.why ?? '').slice(0, 200)} → ${d.applied}`;
    },
  };
}

/** One of the person's moves of the pet, in desktop pixels. */
export interface MoveFact { at: number; kind: string; from: number | null; to: number | null; moving: boolean; stillSec: number | null }

/** The facts a work-area case is built from. */
export interface WorkareaFacts {
  why: string;
  display: { x: number; width: number };
  /** The windows along the bottom, left to right, with what the reading made of each. */
  stretches: Array<{ app: string | null; title: string; from: number; to: number; found: string }>;
  /** What the pet keeps out of now, and what it is made of. */
  zones: Span[];
  basis: string[];
  pet: { x: number | null; doing: string };
  moves: MoveFact[];
  cursor: { x: number; y: number } | null;
  caret: { x: number; width: number } | null;
  idleMs: number;
  inFront: string | null;
}

/** The sections of a work-area case, positions in percent of the display width. */
export function workareaSections(f: WorkareaFacts): CaseSection[] {
  const p = (x: number) => `${Math.round(((x - f.display.x) / f.display.width) * 100)}%`;
  const ago = (at: number) => `${Math.max(0, Math.round((Date.now() - at) / 1000))}s ago`;
  return [
    { title: 'Why this case', lines: [f.why] },
    { title: 'Along the bottom now (left to right)', lines: f.stretches.length
      ? f.stretches.map((s) => `${p(s.from)}–${p(s.to)}: ${s.app ?? '?'} 「${s.title.slice(0, 60)}」 — the reading found: ${s.found}`)
      : ['(no window reaches the bottom)'] },
    { title: 'What the pet keeps out of now (red in the picture), and what it rests on', lines: [
      f.zones.length ? f.zones.map(([a, b]) => `${p(a)}–${p(b)}`).join(', ') : '(nothing)',
      ...f.basis,
    ] },
    { title: 'The pet', lines: [`stands at ${f.pet.x === null ? 'an unknown spot' : p(f.pet.x)} (yellow); ${f.pet.doing}`] },
    { title: 'The person\'s moves of the pet, oldest first (blue: picked up from, green: put down at)', lines: f.moves.length
      ? f.moves.map((m) => `${ago(m.at)}: ${m.kind} from ${m.from === null ? '?' : p(m.from)} to ${m.to === null ? '?' : p(m.to)}; it was ${m.moving ? 'walking' : `standing ${m.stillSec ?? '?'}s`}`)
      : ['(none lately)'] },
    { title: 'The person now', lines: [
      `in front: ${f.inFront ?? 'unknown'}; last input ${Math.round(f.idleMs / 1000)}s ago`,
      `pointer at ${f.cursor ? p(f.cursor.x) : 'unknown'}${f.caret ? `; typing caret at ${p(f.caret.x)} (magenta)` : ''}`,
    ] },
  ];
}

/** Whether kept-out stretches cover too much of the width to be right. */
export function tooWide(zones: Span[], width: number): boolean {
  return zones.reduce((s, [a, b]) => s + (b - a), 0) > TOO_WIDE * width;
}
