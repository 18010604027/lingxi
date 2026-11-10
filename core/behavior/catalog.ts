/**
 * The action catalogue: what the figure pack offers, as data the front and the daily layer choose from.
 *
 * The executor never invents an action: it is told one of these ids and carries it out. This file only turns the pack
 * (plus the person's overrides) into that list: kind, clips, how the move travels, which roles an action can play, and
 * how it feels. Nothing here picks an action.
 */
import type { Figure, MoveClip } from './plan.ts';

export type ActionKind = 'gesture' | 'move' | 'teleport' | 'click' | 'daily' | 'idle' | 'held';
export type MotionMode = 'step' | 'continuous' | 'instant';
export type ActionRole = 'cross' | 'idle' | 'held' | 'click';

export interface CatalogAction {
  id: string;
  kind: ActionKind;
  clips: string[];
  /** How a moving action reaches its target; absent for actions that stay in place. */
  motion?: {
    mode: MotionMode;
    clip: string;
    leadSec: number;
    tailSec: number;
    minDist: number;
    maxDist: number;
    segment?: { startSec: number; endSec: number };
    durationSec?: number;
    endSec?: number;
  };
  roles: ActionRole[];
  /** Free mood tags the pack wrote; the selectors match on them and pass unknown ones through. */
  mood: string[];
  about: string;
  when: string;
}

const motionOf = (move: MoveClip, mode: MotionMode) => ({
  mode,
  clip: move.clip,
  leadSec: move.leadSec,
  tailSec: move.tailSec,
  minDist: move.minDist,
  maxDist: move.maxDist,
  ...(move.segment ? { segment: { startSec: move.segment.startSec, endSec: move.segment.endSec } } : {}),
  ...(move.durationSec !== undefined ? { durationSec: move.durationSec } : {}),
  ...(move.endSec !== undefined ? { endSec: move.endSec } : {}),
});

/** How the pack calls this action; a move without an id is named after its clip. */
const idOf = (move: MoveClip): string => move.id ?? move.clip;

/**
 * Every action the pack offers, in pack order, with the click and daily lists the caller knows about.
 *
 * `walk` and `run` map to `step` and `continuous`; a pack that supports instant crossings turns its `cross` into a
 * teleport, otherwise it stays a continuous run the caller may use rarely (see `crossAction`).
 */
export function buildCatalog(figure: Figure, lists: { click?: string[]; daily?: string[] } = {}): CatalogAction[] {
  const vocabOf = (id: string) => figure.vocab?.[id];
  const actions: CatalogAction[] = [];
  const seen = new Set<string>();
  const add = (action: CatalogAction): void => {
    if (seen.has(action.id)) return;
    seen.add(action.id);
    actions.push(action);
  };
  const moodOf = (id: string, move?: MoveClip): string[] => vocabOf(id)?.mood ?? move?.mood ?? [];

  for (const clip of figure.idle) {
    add({ id: `idle:${clip}`, kind: 'idle', clips: [clip], roles: ['idle'], mood: [], about: '待机', when: '没事的时候' });
  }
  for (const clip of figure.held) {
    add({ id: `held:${clip}`, kind: 'held', clips: [clip], roles: ['held'], mood: [], about: '被拎起', when: '被手抓住的时候' });
  }
  for (const move of figure.moves.walk) {
    const id = idOf(move);
    add({ id, kind: 'move', clips: [move.clip], motion: motionOf(move, 'step'), roles: [], mood: moodOf(id, move),
      about: vocabOf(id)?.about ?? move.about ?? '', when: vocabOf(id)?.when ?? move.when ?? '' });
  }
  for (const move of figure.moves.run) {
    const id = idOf(move);
    add({ id, kind: 'move', clips: [move.clip], motion: motionOf(move, 'continuous'), roles: [], mood: moodOf(id, move),
      about: vocabOf(id)?.about ?? move.about ?? '', when: vocabOf(id)?.when ?? move.when ?? '' });
  }
  if (figure.moves.cross) {
    const move = figure.moves.cross;
    const id = idOf(move);
    const mode: MotionMode = figure.moves.teleport ? 'instant' : 'continuous';
    add({ id, kind: mode === 'instant' ? 'teleport' : 'move', clips: [move.clip], motion: motionOf(move, mode), roles: ['cross'],
      mood: moodOf(id, move), about: vocabOf(id)?.about ?? move.about ?? '', when: vocabOf(id)?.when ?? move.when ?? '' });
  }
  for (const [id, clips] of Object.entries(figure.words)) {
    const click = (lists.click ?? []).includes(id);
    const daily = (lists.daily ?? []).includes(id);
    add({ id, kind: click ? 'click' : daily ? 'daily' : 'gesture', clips, roles: click ? ['click'] : [], mood: moodOf(id),
      about: vocabOf(id)?.about ?? '', when: vocabOf(id)?.when ?? '' });
  }
  return actions;
}

/**
 * The action to use when the body must cross a stretch it may not walk through: the pack's `cross` role.
 *
 * A teleport may be used whenever it is needed; a continuous run is only worth it sometimes, so the caller passes the
 * random draw it already has and `runChance` decides. Returns null when the pack names no cross action.
 */
export function crossAction(actions: CatalogAction[], roll: number, runChance = 0.1): CatalogAction | null {
  const crossing = actions.find((action) => action.roles.includes('cross'));
  if (!crossing?.motion) return null;
  if (crossing.motion.mode === 'instant') return crossing;
  return roll < runChance ? crossing : null;
}

/** Actions a life of their own may pick from: gestures and daily pieces, never the walk/run machinery. */
export function dailyChoices(actions: CatalogAction[], moods: string[] = []): CatalogAction[] {
  const kindOk = (action: CatalogAction): boolean => action.kind === 'gesture' || action.kind === 'daily' || action.kind === 'click';
  if (!moods.length) return actions.filter(kindOk);
  return actions.filter((action) => kindOk(action) && action.mood.some((mood) => moods.includes(mood)));
}
