/**
 * The new body as the work area sees it (daily/workarea.ts): where it stands and how wide it is in
 * screen pixels, the stretches it may not stand in handed to the behaviour system, and moves by hand put together from
 * the body's grab and drop.
 */
import type { WorkareaBody, HandMove } from '../daily/workarea.ts';
import type { Behavior, CommandEnd } from './behavior.ts';
import type { BodyLink, BodyMessage } from './body-link.ts';

/** The drawn body covers 200–440 of the 640-wide clip (as body/main.cjs measures it), centred. */
const DRAWN_SHARE = (440 - 200) / 640;

export function workareaBody(link: BodyLink, behavior: Behavior, bodyPx: number, now: () => number = Date.now): WorkareaBody {
  const span = () => {
    const d = link.display;
    return d ? { x: d.x * d.scale, y: d.y * d.scale, w: d.width * d.scale } : null;
  };
  // how long she has stood where she is, and whether a hand cut a walk short
  let lastX: number | null = null;
  let stillSince = now();
  let cutWalk = false;
  let grabbed: { x: number; moving: boolean; still: number } | null = null;
  let listener: ((e: HandMove) => void) | null = null;
  const toPx = (share: number) => { const s = span(); return s ? s.x + share * s.w : null; };
  behavior.on('command', (e: CommandEnd) => { if (e.by === 'hand' && (e.id === 'walk' || e.id === 'run')) cutWalk = true; });
  link.on('message', (m: BodyMessage) => {
    if (m.t === 'pose' || m.t === 'landed' || m.t === 'move') {
      if (lastX === null || Math.abs(m.x - lastX) > 0.005) { lastX = m.x; stillSince = now(); }
    }
    if (m.t === 'grab') {
      // the behaviour system hears the grab first and says what it cut short
      grabbed = { x: link.x, moving: cutWalk, still: (now() - stillSince) / 1000 };
      cutWalk = false;
    }
    if (m.t === 'drop') {
      const g = grabbed;
      grabbed = null;
      listener?.({ kind: Math.hypot(m.vx, m.vy) > 500 ? 'throw' : 'drop', from: g ? toPx(g.x) : null, to: toPx(m.x),
        moving: g?.moving ?? false, stillSec: g?.still ?? null, at: now() });
    }
  });
  // The work area is read from the moment the plugin starts, often before the body has said hello — and the mapping
  // from screen pixels to shares needs the display, which only the hello brings. So the last stretches are kept and
  // handed over again when the hello arrives; otherwise the first reading is silently lost and she never steps aside.
  let lastZones: Array<[number, number]> | null = null;
  const handOver = (zones: Array<[number, number]>) => {
    const s = span();
    if (!s) return;
    behavior.setZones(zones.map(([a, b]) => [(a - s.x) / s.w, (b - s.x) / s.w] as [number, number])
      .filter(([a, b]) => b > 0 && a < 1).map(([a, b]) => [Math.max(0, a), Math.min(1, b)] as [number, number]));
  };
  link.on('hello', () => { if (lastZones) handOver(lastZones); });

  return {
    span,
    x: () => (link.display ? link.x : null),
    box: () => {
      const s = span(), d = link.display;
      if (!s || !d) return null;
      const width = bodyPx * DRAWN_SHARE * d.scale;
      return { x: s.x + link.x * s.w - width / 2, width };
    },
    keepOut: (zones) => {
      lastZones = zones;
      handOver(zones);
    },
    onHand: (l) => { listener = l; },
  };
}
