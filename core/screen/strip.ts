/**
 * Where the person works, as the pet meets it: along the bottom of the display it walks on. What matters there is
 * whichever window shows along that strip, in front or not: a maximized window behind a small one floating higher up
 * still has its input box right where the pet walks, and a window in front that ends higher up is no concern at all.
 * The strip is split by the windows showing along a line just above the floor (topmost first); each stretch is then
 * read on its own: a window that does not fill the width is kept out of where it shows, one that does is looked into
 * for its input box (inputbox.ts). No model.
 */
import type { DeskRect, StripResult, StripWindow } from './types.ts';
import { findBox, WIDE } from './inputbox.ts';

/** The height of the bottom band read, in the system's pixels at a 100% scale. */
export const BAND = 340;
/** The line the pet walks along, this far above the display's bottom (above a taskbar). */
const LINE = 70;

/** A stretch of the bottom where one window shows. */
export interface Stretch { from: number; to: number; window: StripWindow }

export interface StripLook {
  /** The windows along the bottom, as the work map remembers this arrangement by. */
  key: string;
  display: DeskRect & { index: number; scale: number };
  /** The bottom band in desktop coordinates. */
  band: DeskRect;
  stretches: Stretch[];
  /** What to keep out of, in desktop pixels, with how sure each reading is. */
  zones: Array<[number, number]>;
  confidences: number[];
  /** How each zone was found, for the log. */
  how: string[];
  /** The program in front, wherever its window is. */
  foreground: string | null;
  cursor: { x: number; y: number };
  idleMs: number;
  /** The grey bottom band as read (when this was a full look): pixels, and the desktop y of its top row. */
  gray?: { width: number; height: number; data: Uint8Array; top: number } | null;
  /** The pet's own windows on this display, to leave out of what is read from the band. */
  pets?: DeskRect[];
  /** Where typing goes now (a caret or a focused input), when the engine could tell; focus is not proof of typing. */
  inputFocus?: { kind: 'caret' | 'focus'; rect: DeskRect } | null;
}

/** The desktop and the shell, which are not anyone's work. */
const DESKTOP = (w: StripWindow) => w.title === 'Program Manager' || (w.app?.toLowerCase() === 'explorer.exe' && w.title === '');
/** The pet's own windows. */
const PET = (w: StripWindow) => /^(electron|lingxi)(\.exe)?$/i.test(w.app ?? '');

/** The windows showing along the line `y`, left to right, each where it is the topmost there. */
export function stretchesAt(windows: StripWindow[], d: DeskRect, y: number): Stretch[] {
  const cover = windows.filter((w) => !DESKTOP(w) && !PET(w) && w.rect.y <= y && w.rect.y + w.rect.height > y);
  const cuts = [...new Set([d.x, d.x + d.width, ...cover.flatMap((w) => [w.rect.x, w.rect.x + w.rect.width])])]
    .filter((x) => x >= d.x && x <= d.x + d.width).sort((a, b) => a - b);
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i]!, b = cuts[i + 1]!, mid = (a + b) / 2;
    const top = cover.find((w) => w.rect.x <= mid && w.rect.x + w.rect.width > mid);
    if (!top) continue;
    const last = out.at(-1);
    if (last && last.window === top && last.to === a) last.to = b;
    else out.push({ from: a, to: b, window: top });
  }
  return out;
}

/**
 * Whether the pointer is over a window along the bottom, in the part of it that window shows there: activity on the
 * taskbar, the desktop or a window that does not reach the bottom is not work along the bottom (clicks on the taskbar
 * icons once grew a zone across the middle of the screen).
 */
export function overBottomWindow(look: Pick<StripLook, 'stretches'>, cursor: { x: number; y: number }): boolean {
  return look.stretches.some((s) => cursor.x >= s.from && cursor.x < s.to
    && cursor.y >= s.window.rect.y && cursor.y < s.window.rect.y + s.window.rect.height);
}

/** Cuts columns [from, to) of the grey strip out as a strip of its own. */
function columns(strip: NonNullable<StripResult['strip']>, from: number, to: number) {
  const w = Math.max(1, to - from), gray = new Uint8Array(w * strip.height);
  for (let y = 0; y < strip.height; y++) gray.set(strip.gray.subarray(y * strip.width + from, y * strip.width + from + w), y * w);
  return { width: w, height: strip.height, gray };
}

/** What to keep out of along the bottom, from the engine's look at it. */
export function readStrip(r: StripResult): StripLook {
  const d = r.display, scale = d.scale || 1;
  const bandH = Math.min(d.height, Math.round(BAND * scale));
  const band = { x: d.x, y: d.y + d.height - bandH, width: d.width, height: bandH };
  const stretches = stretchesAt(r.windows, d, d.y + d.height - LINE * scale);
  const zones: Array<[number, number]> = [], confidences: number[] = [], how: string[] = [];
  for (const s of stretches) {
    const w = s.window;
    if (w.rect.width < d.width * WIDE) {
      zones.push([s.from, s.to]); confidences.push(0.8); how.push(`${w.app}: window`);
      continue;
    }
    // a window across the width: its input box, read from where it shows
    const px = r.strip ? r.strip.width / d.width : 0;
    const box = r.strip && px ? findBox(columns(r.strip, Math.round((s.from - d.x) * px), Math.round((s.to - d.x) * px))) : null;
    if (box) {
      const pad = d.width * 0.01, span = s.to - s.from;
      zones.push([Math.round(s.from + box.span[0] * span - pad), Math.round(s.from + box.span[1] * span + pad)]);
      confidences.push(box.confidence); how.push(`${w.app}: input`);
    } else {
      const span = s.to - s.from;
      zones.push([Math.round(s.from + span * 0.25), Math.round(s.from + span * 0.75)]); confidences.push(0.3); how.push(`${w.app}: middle`);
    }
  }
  const q = (v: number) => Math.round(((v - d.x) / d.width) * 50);
  const key = `${d.index}|${stretches.map((s) => `${(s.window.app ?? '?').toLowerCase()}@${q(s.from)}-${q(s.to)}`).join(',')}`;
  return { key, display: d, band, stretches, zones, confidences, how, foreground: r.windows.find((w) => w.foreground)?.app ?? null, cursor: r.cursor, idleMs: r.idleMs,
    inputFocus: r.inputFocus ? { kind: r.inputFocus.kind, rect: r.inputFocus.rect } : null,
    gray: r.strip ? { width: r.strip.width, height: r.strip.height, data: r.strip.gray, top: r.strip.top } : null,
    pets: r.windows.filter(PET).map((w) => w.rect) };
}
