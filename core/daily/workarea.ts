/**
 * Where she may walk along the bottom of the screen, kept separate from application assembly so the body
 * and the new behaviour system both use it. The bottom is read as parts, one per window, each in one
 * of its modes (scene.ts); each part and mode has its own plan (plans.ts), from what a look sees there and what was
 * learnt there, or as the control center settled it; the typing caret is kept clear of on top of them all. What comes
 * out is the stretches she may not stand in, handed to the body (`WorkareaBody.keepOut`).
 * It learns from the person: a move by hand counts where she was picked up and put down, the pointer working in a
 * window counts there, and standing a while unbothered says a spot is fine. A plan that keeps her out of most of the
 * screen opens a case for the control center, whose decision settles it.
 */
import { bandPicture, watchStrip } from '../screen/look.ts';
import { overBottomWindow, type StripLook } from '../screen/strip.ts';
import { join } from 'node:path';
import type { Agents } from '../agents/roles.ts';
import { countsAsMovedAway, inTheWay, repeatedRemovalFactor } from './placement.ts';
import { PBINS, PlanBook, STEP, combineWorkareaZones, planKey, spansOf, takenStep } from './plans.ts';
import { CONTENT, ModeBook, partContents, readScene, SAME, type PartLook } from './scene.ts';
import { WORKAREA_KIND, tooWide, workareaSections } from './workarea-case.ts';
import type { WindowLook } from './workmap.ts';

/** A move by hand: where she was picked up and put down, in screen pixels. */
export interface HandMove {
  kind: 'throw' | 'drop';
  from: number | null;
  to: number | null;
  /** She was walking when picked up. */
  moving: boolean;
  /** How long she had stood there before. */
  stillSec: number | null;
  /** Epoch ms. */
  at: number;
}

/** The body, as the work area sees it. */
export interface WorkareaBody {
  /** The display she stands on, in screen (physical) pixels, as the screen reading takes them. */
  span(): { x: number; y: number; w: number } | null;
  /** Where she stands, as a share of the span's width. */
  x(): number | null;
  /** The stretch her body covers, in screen pixels, to leave out of reading the screen. */
  box(): { x: number; width: number } | null;
  /** Where she may not stand, in screen pixels, with the program each stretch lies in. */
  keepOut(zones: Array<[number, number]>, labels: string[]): void;
  /** Hands over the listener for moves by hand; called again on each change, so set it once. */
  onHand(listener: (e: HandMove) => void): void;
}

export interface Workarea {
  /** The program in front, as last read. */
  foreground(): string | null;
  /** The bottom as the old work map takes it. */
  currentLook(): WindowLook | null;
  stop(): void;
}

export function watchWorkarea(opts: { dataDir: string; agents?: Agents; body: WorkareaBody }): Workarea {
  // without the roles behind her (the plugin runs her instinct, her mind is a DSH session) the
  // work area is still read and kept clear of; only the learning that feeds the control center is skipped
  const { dataDir, agents, body } = opts;
  let inFront: string | null = null;
  let strip: StripLook | null = null;
  let lastSaid = '';
  // the bottom as the old work map takes it: still where moves by hand are recorded (the cases list them) and
  // what the control center's workarea tools look at
  const asLook = (st: StripLook): WindowLook => ({
    app: null, key: st.key, window: st.band, display: st.display, zones: st.zones,
    confidences: st.confidences, confidence: Math.max(0, ...st.confidences),
  });
  let look: WindowLook | null = null;
  const modes = new ModeBook(dataDir);
  const plans = new PlanBook(dataDir);
  let sceneSaid = '';
  let parts: PartLook[] = [];
  let contents: number[][] | null = null;
  let lastZones: Array<[number, number]> = [];
  // A placement during a temporary unmatched frame waits for the detector to settle a new mode; it must not alter
  // the old matched template. Until then it is an immediate, local opening only.
  const pendingLandings = new Map<string, number[]>();
  const partAt = (x: number | null) => (x === null ? null : parts.find((p) => x >= p.from && x < p.to) ?? null);
  const keyOf = (p: PartLook) => planKey(p.seen.mode.part, p.seen.mode.id);
  const fracIn = (p: PartLook, x: number) => (x - p.from) / (p.to - p.from);
  const bodyPx = () => body.box()?.width ?? 120 * (strip?.display.scale || 1);
  const onHand = (e: HandMove) => {
    const judged = inTheWay(e, strip?.display.width ?? 2560);
    agents?.ledger.count('daily', 'hand-move', judged.counts ? 'in-the-way' : judged.weight > 0 ? 'far-after-stay' : 'play');
    // each end counts in the part it is in: picked up there, "not here"; put down there, "there is fine" (W14)
    const from = partAt(e.from), to = partAt(e.to);
    // Keep the raw event first; the repeated-start rule below reads the complete, layout-bound history including this move.
    agents?.workmap.recordTouch(look ? { ...look, key: from ? keyOf(from) : look.key } : null, e);
    if (from && e.from !== null) {
      const key = keyOf(from);
      const history = agents?.workmap.touches(e.at - 10 * 60_000) ?? [];
      const repeat = repeatedRemovalFactor(e, history, key, strip?.display.width ?? 2560, bodyPx());
      if (repeat > 0) plans.note(key, fracIn(from, e.from), takenStep(e) * repeat);
    }
    if (countsAsMovedAway(e, strip?.display.width ?? 2560)) agents?.noteMovedAway(e.at);
    if (to && e.to !== null) plans.note(keyOf(to), fracIn(to, e.to), e.kind === 'drop' ? STEP.putDown : STEP.thrownTo);
    if (to && e.to !== null && strip) {
      if (to.seen.status === 'flash') {
        const xs = pendingLandings.get(to.key) ?? [];
        xs.push(e.to);
        pendingLandings.set(to.key, xs.slice(-12));
      } else {
        const radius = Math.ceil((bodyPx() / (to.to - to.from)) * PBINS);
        plans.noteFree(keyOf(to), fracIn(to, e.to), radius);
      }
    }
    apply();
  };
  const apply = () => {
    if (!strip) return;
    const d = strip.display;
    const perPart = parts.map((p, i) => {
      const current = contents?.[i] ?? null;
      // A one-frame layout that matches none of the stored modes is not the
      // last mode. Until it matches or persists as its own mode, use this
      // frame's measured cells and detections without borrowing that plan.
      const blocked = p.seen.status === 'flash'
        ? (current?.map((v) => v >= CONTENT) ?? new Array(PBINS).fill(false))
        : plans.blocked(keyOf(p), current, CONTENT);
      return spansOf(blocked, p.from, p.to);
    });
    // what is in use this moment: where the person types, half a body either side
    const f = strip.inputFocus;
    const bodyTop = d.y + d.height - 150 * (d.scale || 1);
    const caretInWalkBand = f?.kind === 'caret' && f.rect.y <= d.y + d.height && f.rect.y + f.rect.height >= bodyTop;
    const caret: Array<[number, number]> = caretInWalkBand
      ? [[f!.rect.x - bodyPx() / 2, f!.rect.x + f!.rect.width + bodyPx() / 2]] : [];
    // a gap she could barely stand in (inside an input box, between two buttons) is kept out of too
    // `strip.zones` is the current frame's direct detection. It overlays the
    // matched template, except where the person directly placed the pet; a live
    // caret remains forbidden even inside that selected landing.
    const free = parts.flatMap((p) => [
      ...(p.seen.status === 'flash' ? [] : spansOf(plans.manualFree(keyOf(p)), p.from, p.to)),
      ...(pendingLandings.get(p.key) ?? []).map((x) => [x - bodyPx(), x + bodyPx()] as [number, number]),
    ]);
    const deskZones = combineWorkareaZones(perPart.flat(), strip.zones, strip.confidences, caret, bodyPx(), free);
    lastZones = deskZones;
    // kept out of most of the screen and not settled by a decision: plain trouble, for the control center
    const worst = parts.map((p, i) => ({ p, share: perPart[i]!.reduce((s, [a, b]) => s + b - a, 0) / (p.to - p.from) })).sort((a, b) => b.share - a.share)[0];
    if (tooWide(deskZones, d.width) && worst && !plans.settledFor(keyOf(worst.p))) {
      openCase(`What the pet keeps out of covers ${Math.round(deskZones.reduce((s, [a, b]) => s + b - a, 0) / d.width * 100)}% of the screen width: it is left a sliver to stand in.`, worst.p);
    }
    const said = `${parts.map(keyOf).join(',')} ${JSON.stringify(deskZones)}`;
    if (said !== lastSaid) { lastSaid = said; console.log(`[workarea] ${parts.map((p) => `${p.app ?? '?'} mode ${p.seen.mode.id}`).join(', ') || 'nothing along the bottom'} → keep out of ${JSON.stringify(deskZones.map(([a, b]) => [Math.round(a), Math.round(b)]))}`); }
    // what each stretch is: the program whose window it lies in, for telling her where she may go
    const appAt = (x: number) => partAt(x)?.app?.replace(/\.exe$/i, '') ?? '';
    body.keepOut(deskZones, deskZones.map(([a, b]) => appAt((a + b) / 2)));
    body.onHand(onHand);
  };
  // the control center's decision on a case settles that part and mode's plan (W16); its stretches come as
  // shares of the screen's width and are turned into shares of the part as it stood when the case was opened
  const caseParts = new Map<string, { from: number; to: number; x: number; width: number }>();
  if (agents) agents.settleWorkarea = (key, keepOut, free, caseId, confidence) => {
    const g = caseParts.get(key);
    if (!g) return 'kept only: that window is not along the bottom now';
    const toPart = (ss: Array<[number, number]>) => ss.map(([a, b]) => [((g.x + a * g.width) - g.from) / (g.to - g.from), ((g.x + b * g.width) - g.from) / (g.to - g.from)] as [number, number])
      .map(([a, b]) => [Math.max(0, a), Math.min(1, b)] as [number, number]).filter(([a, b]) => b > a);
    plans.settle(key, { keepOut: toPart(keepOut), free: toPart(free), caseId, confidence });
    apply();
    return `settled for that window: keep out ${keepOut.map(([a, b]) => `${Math.round(a * 100)}–${Math.round(b * 100)}%`).join(', ') || 'nothing'}`;
  };
  // a work-area case: the bottom of the screen marked, the moves, the readings, the plan and its history
  const caseAt = new Map<string, number>();
  const openCase = (why: string, hint?: PartLook) => {
    if (!strip) return;
    const st = strip, now = Date.now();
    const lastMove = agents?.workmap.touches(now - 10 * 60_000).at(-1);
    const span = body.span(), x = body.x();
    const petX = span && x !== null ? span.x + x * span.w : null;
    const part = hint ?? partAt(lastMove?.from ?? null) ?? partAt(petX) ?? parts[0];
    if (!part) return;
    const key = keyOf(part);
    if (now - (caseAt.get(key) ?? -Infinity) < 30 * 60_000) return;
    caseAt.set(key, now);
    caseParts.set(key, { from: part.from, to: part.to, x: st.display.x, width: st.display.width });
    void (async () => {
      const d = st.display;
      const zones = lastZones;
      const moves = (agents?.workmap.touches(now - 30 * 60_000) ?? []).filter((t) => t.layout === key).slice(-8);
      const f = st.inputFocus;
      const caret = f?.kind === 'caret' ? { x: f.rect.x, width: f.rect.width } : null;
      const points = [
        ...moves.flatMap((m) => [...(m.from !== null ? [{ x: m.from, color: 'blue' as const }] : []), ...(m.to !== null ? [{ x: m.to, color: 'green' as const }] : [])]),
        ...(petX !== null ? [{ x: petX, color: 'yellow' as const }] : []),
        ...(caret ? [{ x: caret.x, color: 'magenta' as const }] : []),
      ];
      const pic = await bandPicture({ x: d.x + d.width / 2, y: d.y + 10 }, { zones, points }).catch(() => null);
      const settled = plans.settledFor(key);
      const pct = (v: number) => Math.round((v - d.x) / d.width * 100);
    agents?.submitCase({
        kind: WORKAREA_KIND, key,
        question: `Where should the pet keep out of along the bottom, in the window ${part.app ?? '?'} at ${pct(part.from)}–${pct(part.to)}% `
          + 'of the screen width, and where may it walk freely? Say what is there, where the person works, what the person\'s moves mean, '
          + 'and whether this window shows the same kind of page as when it was decided before, or only looks like it.',
        sections: workareaSections({
          why, display: d,
          stretches: parts.map((p) => ({ app: p.app, title: p.title, from: p.from, to: p.to,
            found: `layout ${p.seen.mode.id} of this window (${p.seen.status === 'same' ? 'seen before' : p.seen.status === 'new' ? 'new' : 'a passing change'})${p === part ? '; this case is about this window' : ''}` })),
          zones,
          basis: settled
            ? [`this window's layout was settled by the control center (case ${settled.caseId}, ${settled.at.slice(0, 16)}); the rules do not move it`]
            : ['worked out by rules: what is drawn in the strip the pet would cover (text, icons, controls; lines do not count), where the person picked the pet up and put it down in this window, where their pointer worked, and where the pet stood unbothered'],
          pet: { x: petX, doing: moves.length ? `it was ${moves.at(-1)!.moving ? 'walking' : 'standing'} when last picked up` : 'not moved by hand lately' },
          moves, cursor: st.cursor, caret, idleMs: st.idleMs, inFront: st.foreground,
        }),
        images: pic ? [{ label: 'The bottom of the screen, full width', jpeg: pic.jpeg,
          legend: 'Ticks along the bottom edge every 10% of the width (longer at 50%). Red: what the pet keeps out of now. '
            + 'Blue lines: where the person picked the pet up. Green: where they put it down. Yellow: the pet now. Magenta: the typing caret.' }] : [],
      }, { label: 'internal:workarea' });
    })().catch((err) => console.warn('[workarea] case failed', err));
  };
  if (agents) agents.openWorkareaCase = (why) => openCase(why);
  let samples = 0;
  const stopLooks = watchStrip({
    // the display she is on
    at: () => { const s = body.span(); return s ? { x: s.x + s.w / 2, y: s.y + 10 } : null; },
    samplesDir: join(dataDir, 'workarea-samples'),
    onLook: (a) => {
      strip = a; look = asLook(a); inFront = a.foreground;
      try {
        const box = body.box();
        const seen = { ...a, pets: box ? [{ x: box.x - 20, width: box.width + 40 }] : a.pets };
        const read = readScene(seen, modes);
        // a look without the band (a cheap one) keeps the parts and content of the last full one
        if (read.length) {
          parts = read; contents = partContents(seen, bodyPx(), PBINS);
          for (const p of read) {
            const xs = pendingLandings.get(p.key);
            if (!xs || p.seen.status === 'flash') continue;
            const radius = Math.ceil((bodyPx() / (p.to - p.from)) * PBINS);
            for (const x of xs) plans.noteFree(keyOf(p), fracIn(p, x), radius);
            pendingLandings.delete(p.key);
          }
          const unlikeKnown = read.find((p) => p.seen.status === 'new' && Number.isFinite(p.seen.distance) && p.seen.distance > SAME);
          if (unlikeKnown) openCase(`A stable bottom layout has low similarity to its known modes (edge distance ${unlikeKnown.seen.distance}); keep it as a separate candidate and check whether the earlier plan applies.`, unlikeKnown);
        }
        const said = parts.map((p) => `${p.key} mode ${p.seen.mode.id}${p.seen.status === 'same' ? '' : ` (${p.seen.status})`}`).join(', ');
        if (said && said !== sceneSaid) { sceneSaid = said; console.log(`[scene] ${said}`); }
      } catch (err) { console.warn('[scene] reading failed', err); }
      apply();
    },
    // where they work as they work: the pointer moving in a window along the bottom (not the taskbar, not the
    // desktop) counts in that window's plan, a little each time
    onSample: (a) => {
      const oldFocus = strip?.inputFocus;
      if (strip && JSON.stringify(oldFocus) !== JSON.stringify(a.inputFocus)) {
        strip = { ...strip, inputFocus: a.inputFocus };
        apply();
      }
      if (!look || !strip || !overBottomWindow(strip, a.cursor) || !(agents?.workmap.noteActivity(look, a.cursor, a.idleMs) ?? true)) return;
      const p = partAt(a.cursor.x);
      if (p) plans.note(keyOf(p), fracIn(p, a.cursor.x), STEP.pointer, 2);
      if (++samples % 8 === 0) apply();
    },
  });
  // standing a while where nobody moved her says that spot is fine
  let stayX: number | null = null, stayMin = 0;
  const stays = setInterval(() => {
    const x = body.x(), span = body.span();
    if (x === null || !span) { stayX = null; return; }
    stayMin = stayX !== null && Math.abs(x - stayX) < 0.01 ? stayMin + 1 : 0;
    stayX = x;
    const p = partAt(span.x + x * span.w);
    if (stayMin >= 5 && p) plans.note(keyOf(p), fracIn(p, span.x + x * span.w), STEP.stayMinute, 2);
    agents?.workmap.flush();
  }, 60_000);
  stays.unref();
  return {
    foreground: () => inFront,
    currentLook: () => look,
    stop: () => { stopLooks(); clearInterval(stays); },
  };
}
