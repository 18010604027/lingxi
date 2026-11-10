/**
 * The bottom of the screen as regions, one per window along it (WORKAREA-DESIGN W17): each region is remembered on its
 * own in the work map, its evidence is only what happened inside it, and what it keeps out of never reaches past it.
 * A move by hand counts where it happened: where the pet was picked up, for the region there ("not here"); where it
 * was put down, for the region there ("there is fine"). The whole bottom used to be one map per arrangement, so a
 * window's zone took in activity and finds from its neighbours and the taskbar, and grew past its own edge.
 */
import type { StripLook } from '../screen/strip.ts';
import type { WindowLook, WorkMap } from './workmap.ts';

export interface Region {
  /** What the work map remembers the region by: display, program, and where the window sits along the bottom (2% steps). */
  key: string;
  app: string | null;
  title: string;
  /** Its stretch of the bottom, desktop pixels. */
  from: number;
  to: number;
  look: WindowLook;
}

/** The regions of a reading of the bottom, left to right. */
export function regionsOf(st: StripLook): Region[] {
  const d = st.display, q = (v: number) => Math.round(((v - d.x) / d.width) * 50);
  return st.stretches.map((s, i) => {
    const zone = st.zones[i];
    const conf = st.confidences[i] ?? 0;
    const key = `${d.index}|${(s.window.app ?? '?').toLowerCase()}@${q(s.from)}-${q(s.to)}`;
    const look: WindowLook = {
      app: s.window.app, key, display: d,
      window: { x: s.from, y: st.band.y, width: s.to - s.from, height: st.band.height },
      zones: zone ? [[Math.max(s.from, zone[0]), Math.min(s.to, zone[1])]] : [], confidences: zone ? [conf] : [], confidence: zone ? conf : 0,
    };
    return { key, app: s.window.app, title: s.window.title, from: s.from, to: s.to, look };
  });
}

/** The region a desktop x is in, or null. */
export function regionAt(regions: Region[], x: number | null): Region | null {
  if (x === null) return null;
  return regions.find((r) => x >= r.from && x < r.to) ?? null;
}

/** What the pet keeps out of along the whole bottom: each region's own, side by side. */
export function keepOut(workmap: WorkMap, regions: Region[]): Array<[number, number]> {
  return regions.flatMap((r) => workmap.zones(r.look));
}
