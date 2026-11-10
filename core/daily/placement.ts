/**
 * How the person's hand says the pet is in the way. The daily layer watches how often the person throws the pet or picks
 * it up and puts it elsewhere; moved away often in a short time, the pet is probably over where they work, and the
 * matter goes to the control center as a workarea case. Where the pet may walk is learnt per
 * window and mode (plans.ts) and settled by those cases; the per-program placement policies that came before are retired
 * (10-28).

 */

/** Moves away this many times inside the window make the matter the control center's. */
export const MOVED_AWAY = { count: 3, windowMs: 10 * 60_000, quietMs: 30 * 60_000 };

/**
 * Whether a move by hand says the pet was in the way, and how strongly (2026-10-26, the person's rule): it counts when
 * the pet had walked there (on the move when picked up, or standing there under `RECENT_SEC`) and was put somewhere
 * clearly else (at least `FAR` of the display's width and `FAR_PX`). Moved far from a spot it had stood on long counts
 * half; a short move is play.
 */
export const MOVED = { RECENT_SEC: 120, FAR: 0.08, FAR_PX: 160 };
export function inTheWay(e: { from: number | null; to: number | null; moving: boolean; stillSec: number | null }, displayWidth: number): { counts: boolean; weight: number } {
  // picked up while it was walking: its walk was cut short, near or far; that alone says something is wrong (WORKAREA-DESIGN W7)
  if (e.moving) return { counts: true, weight: e.from === null ? 0 : 1 };
  if (e.from === null || e.to === null) return { counts: false, weight: 0 };
  const far = Math.abs(e.to - e.from) >= Math.max(MOVED.FAR * displayWidth, MOVED.FAR_PX);
  if (!far) return { counts: false, weight: 0 };
  const walkedThere = e.stillSec !== null && e.stillSec <= MOVED.RECENT_SEC;
  return walkedThere ? { counts: true, weight: 1 } : { counts: false, weight: 0.5 };
}

/** A qualified removal contributes to the global repeated-trouble trigger, even before its spot has repeated. */
export function countsAsMovedAway(e: { from: number | null; to: number | null; moving: boolean; stillSec: number | null }, displayWidth: number): boolean {
  return e.from !== null && inTheWay(e, displayWidth).counts;
}

/**
 * A hand at the same spot needs a second, consistent removal before its start becomes avoidance evidence. Close throws
 * are play; the landing still counts as a free-spot observation in the normal plan path.
 */
export function repeatedRemovalFactor(e: { kind: 'throw' | 'drop'; from: number | null; to: number | null; moving: boolean; stillSec: number | null; at: number },
  history: Array<{ layout: string | null; kind: 'throw' | 'drop'; from: number | null; to: number | null; moving: boolean; stillSec: number | null; at: number }>,
  layout: string, displayWidth: number, bodyWidth: number): number {
  if (e.from === null || !inTheWay(e, displayWidth).counts) return 0;
  const radius = Math.max(bodyWidth * 1.5, displayWidth * 0.02);
  const sameSpot = history.filter((m) => m.layout === layout && m.from !== null && Math.abs(m.from - e.from!) <= radius
    && m.at <= e.at && e.at - m.at <= 10 * 60_000 && inTheWay(m, displayWidth).counts);
  const quickThrows = sameSpot.filter((m) => m.kind === 'throw' && e.at - m.at <= 2 * 60_000);
  if (quickThrows.length >= 2 || sameSpot.length < 2) return 0;
  return Math.min(1, (sameSpot.length - 1) / 2);
}

/** Counts the moves that say the pet was in the way and says when it is often enough to hand on. */
export class MovedAwayDetector {
  private moves: number[] = [];
  private handedAt = -Infinity;

  /** Notes one throw or pick-up-and-place at `at` (epoch ms); true when the matter should go to the control center now. */
  note(at: number): boolean {
    this.moves = [...this.moves.filter((t) => at - t < MOVED_AWAY.windowMs), at];
    if (this.moves.length < MOVED_AWAY.count || at - this.handedAt < MOVED_AWAY.quietMs) return false;
    this.handedAt = at;
    return true;
  }

  /** Times moved away inside the window ending at `at`. */
  recent(at: number): number {
    return this.moves.filter((t) => at - t < MOVED_AWAY.windowMs).length;
  }
}
