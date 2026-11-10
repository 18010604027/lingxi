/**
 * The action library: the person's own list of named actions, which the executor runs and the selector chooses from.
 *
 * It is data, not a schema of the figure pack: an entry may be added or removed at any time, and nothing in the code
 * knows an action by name. An entry needs an id and at least one clip; everything else is what the front reads to
 * understand what the clips actually show (`looks`), when to reach for it (`when`), how it feels (`mood`), and the two
 * roles that need more than a description: a click response and an obstacle crossing (`use`).
 *
 * Loading is forgiving on purpose: a malformed entry is dropped with a note, the rest stay, and an empty library is a
 * valid state (she simply has nothing to play).
 */

export type ActionUse = 'avoid' | 'click';

/** The ids a configuration marks as click responses. */
export function clickActions(entries: readonly ActionEntry[]): string[] {
  return entries.filter((entry) => entry.use === 'click').map((entry) => entry.id);
}

export type ActionFrequency = 'high' | 'low';

export interface ActionEntry {
  id: string;
  clips: string[];
  /** What the animation really shows: shape, amplitude, speed, how it starts and ends. The front reads this. */
  looks?: string;
  /** When the front should reach for it. */
  when?: string;
  /** Free mood tags (`calm`, `happy`, `shy`, ...). */
  mood?: string[];
  /** A role beyond description: a click response, or an obstacle crossing. */
  use?: ActionUse;
  /** For `use: avoid`: `high` may be used often (a blink), `low` only now and then (a dash). */
  frequency?: ActionFrequency;
  /** For `use: avoid`: how the crossing itself moves. `instant` is a blink, `continuous` one run to the point. */
  motion?: { mode: 'instant' | 'continuous'; clip?: string; leadSec?: number; tailSec?: number; minDist?: number; maxDist?: number };
}

export interface LibraryCheck {
  entries: ActionEntry[];
  problems: string[];
}

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : undefined;
const list = (value: unknown): string[] | undefined => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim().slice(0, 120)).filter(Boolean)
  : undefined;

/** Reads a library, keeping what is usable and saying what was dropped and why. */
export function checkLibrary(value: unknown): LibraryCheck {
  if (value === undefined || value === null) return { entries: [], problems: [] };
  if (!Array.isArray(value)) return { entries: [], problems: ['action library must be an array'] };
  const entries: ActionEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`#${index}: not an object`); return; }
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!ID.test(id)) { problems.push(`#${index}: invalid id`); return; }
    if (seen.has(id)) { problems.push(`${id}: repeated`); return; }
    const clips = list(item.clips);
    if (!clips?.length) { problems.push(`${id}: no clips`); return; }
    const use = item.use === 'avoid' || item.use === 'click' ? item.use : undefined;
    const frequency = use === 'avoid' && (item.frequency === 'high' || item.frequency === 'low') ? item.frequency : undefined;
    let motion: ActionEntry['motion'];
    if (use === 'avoid' && item.motion && typeof item.motion === 'object' && !Array.isArray(item.motion)) {
      const raw = item.motion as Record<string, unknown>;
      if (raw.mode === 'instant' || raw.mode === 'continuous') {
        const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
        motion = { mode: raw.mode,
          ...(typeof raw.clip === 'string' && raw.clip.trim() ? { clip: raw.clip.trim() } : {}),
          ...(number(raw.leadSec) !== undefined ? { leadSec: number(raw.leadSec) } : {}),
          ...(number(raw.tailSec) !== undefined ? { tailSec: number(raw.tailSec) } : {}),
          ...(number(raw.minDist) !== undefined ? { minDist: number(raw.minDist) } : {}),
          ...(number(raw.maxDist) !== undefined ? { maxDist: number(raw.maxDist) } : {}) };
      }
    }
    seen.add(id);
    entries.push({ id, clips, ...(text(item.looks) ? { looks: text(item.looks)! } : {}), ...(text(item.when) ? { when: text(item.when)! } : {}),
      ...(list(item.mood)?.length ? { mood: list(item.mood)! } : {}), ...(use ? { use } : {}), ...(frequency ? { frequency } : {}),
      ...(motion ? { motion } : {}) });
  });
  return { entries, problems };
}

/** The entries a pack can seed from its own action words, for the first start or when the person has no library yet. */
export function libraryFromFigure(figure: { words: Record<string, string[]>; vocab?: Record<string, { about?: string; when?: string; mood?: string[] }> }): ActionEntry[] {
  return Object.entries(figure.words).map(([id, clips]) => {
    const vocab = figure.vocab?.[id];
    return { id, clips: [...clips], ...(vocab?.about ? { looks: vocab.about } : {}), ...(vocab?.when ? { when: vocab.when } : {}),
      ...(vocab?.mood?.length ? { mood: [...vocab.mood] } : {}) };
  });
}

/**
 * Puts a library in place of the pack's words, in the same figure object so the running system picks it up. The
 * pack's movement clips, idle and held poses are not touched: those are the body's mechanics, not named actions.
 */
export function applyLibrary(figure: { words: Record<string, string[]>; vocab?: Record<string, { kind: 'expression' | 'motion'; zh: string[]; about: string; when?: string; mood?: string[] }>;
  moves: { teleport?: boolean; cross?: { clip: string; leadSec: number; tailSec: number; minDist: number; maxDist: number } } }, entries: ActionEntry[]): void {
  const words: Record<string, string[]> = {};
  const vocab: NonNullable<typeof figure.vocab> = {};
  for (const entry of entries) {
    words[entry.id] = [...entry.clips];
    vocab[entry.id] = { kind: entry.use === 'click' ? 'expression' : 'motion', zh: [], about: entry.looks ?? '', ...(entry.when ? { when: entry.when } : {}),
      ...(entry.mood?.length ? { mood: [...entry.mood] } : {}) };
  }
  figure.words = words;
  figure.vocab = vocab;
  // An avoid entry with a motion decides how the body crosses: a blink is always available, a run is the one move the
  // crossing uses when no blink is offered. Without such an entry the pack's own crossing stays as configured.
  const avoid = entries.filter((entry) => entry.use === 'avoid' && entry.motion);
  if (avoid.length) {
    const blink = avoid.find((entry) => entry.motion?.mode === 'instant');
    figure.moves.teleport = !!blink;
    const run = avoid.find((entry) => entry.motion?.mode === 'continuous');
    if (run?.motion) {
      figure.moves.cross = { clip: run.motion.clip ?? run.clips[0]!, leadSec: run.motion.leadSec ?? 0, tailSec: run.motion.tailSec ?? 0,
        minDist: run.motion.minDist ?? 1, maxDist: run.motion.maxDist ?? 4000 };
    }
  }
}
