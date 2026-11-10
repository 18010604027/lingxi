/**
 * Looking at the screen without a model (moved from the old pet package's cua/glance.ts and the strip,
 * band and screenshot ops of its engine child). The pixels come from node-screenshots (Apache-2.0), captured off the
 * main thread; the windows, the pointer, the last input and where typing goes come from Win32 (win32.ts). It runs in
 * the brain's own process: no engine child any more. Windows only.
 *
 * - `glance`: one screenshot of the display holding the foreground window, with the windows open, for the pet's own
 *   rhythm; nothing while the session is locked or nobody is at the screen.
 * - `watchStrip`: the bottom of the display the pet is on, read for where the person works (strip.ts).
 * - `bandPicture`: that bottom band in colour, marked, for the control center's work-area cases.
 *

 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as os from './win32.ts';
import { Monitor } from 'node-screenshots';
import { downscale, drawCursor, drawMarks, encodeJpeg, fit } from './image.ts';
import { BAND, readStrip, type StripLook } from './strip.ts';
import type { BandMarks, BandResult, DeskRect, Presence, StripResult } from './types.ts';

/** Programs in the foreground while the session is locked or at the sign-in screen (Windows). */
const LOCK_APPS = new Set(['lockapp.exe', 'logonui.exe']);
/** No input for this long: the person is away, or the screen has gone dark. */
export const AWAY_IDLE_MS = 10 * 60_000;

/** Why nobody is at the screen, or null when someone is. */
export function away(p: Presence): 'locked' | 'idle' | null {
  if (p.foregroundApp && LOCK_APPS.has(p.foregroundApp.toLowerCase())) return 'locked';
  if (p.idleMs < 0 || p.idleMs >= AWAY_IDLE_MS) return 'idle';
  return null;
}

/** A display: `index` counts from 1, left to right and then top to bottom; geometry in physical desktop pixels. */
interface Display extends DeskRect { index: number; primary: boolean; scale: number; monitor: Monitor }

function displays(): Display[] {
  return Monitor.all()
    .map((m) => ({ x: m.x(), y: m.y(), width: m.width(), height: m.height(), primary: m.isPrimary(), scale: m.scaleFactor(), monitor: m }))
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((d, i) => ({ ...d, index: i + 1 }));
}

const holding = (list: Display[], x: number, y: number) => list.find((d) => x >= d.x && y >= d.y && x < d.x + d.width && y < d.y + d.height) ?? null;
const shape = (d: Display) => ({ index: d.index, x: d.x, y: d.y, width: d.width, height: d.height, scale: d.scale });

/** Milliseconds since the person's last input; -1 when none is on record. Ticks wrap at 2^32. */
function idleMs(): number {
  const last = os.lastInputTick();
  return last ? (os.tick() - last) >>> 0 : -1;
}

export async function presence(): Promise<Presence> {
  if (process.platform !== 'win32') return { idleMs: -1, foregroundApp: null, foreground: null };
  const fg = os.windows().find((w) => w.foreground);
  return { idleMs: idleMs(), foregroundApp: fg ? os.processName(fg.pid) : null, foreground: fg?.title ?? null };
}

/** The bottom `band` physical pixels of `d` as RGBA, downscaled to at most `maxWidth` wide. */
async function bottomOf(d: Display, band: number, maxWidth: number): Promise<{ rgba: Uint8Array; width: number; height: number; top: number }> {
  const img = await d.monitor.captureImage();
  // the picture's pixels per desktop pixel, should the two ever differ
  const k = img.width / d.width;
  const bh = Math.min(d.height, Math.round(band));
  const cy = Math.round((d.height - bh) * k), ch = Math.max(1, img.height - cy);
  const raw = await (await img.crop(0, cy, img.width, ch)).toRaw();
  const size = fit(img.width, ch, maxWidth, maxWidth);
  return { rgba: downscale(raw, img.width, ch, size), width: size.width, height: size.height, top: d.y + d.height - bh };
}

/** The display holding `at` (a desktop point), else the primary one. */
function displayFor(list: Display[], at: { x: number; y: number } | null): Display {
  return (at && holding(list, at.x, at.y)) ?? list.find((d) => d.primary) ?? list[0]!;
}

/**
 * The windows along the display holding `at`, the pointer, the last input, where typing goes, and with `band` > 0 the
 * bottom `band` physical pixels in grey: what strip.ts reads.
 */
export async function stripNow(at: { x: number; y: number } | null, band: number, maxWidth: number): Promise<StripResult> {
  const d = displayFor(displays(), at);
  const names = new Map<number, string | null>();
  const windows = os.windows().filter((w) => !w.minimized).map((w) => {
    const x0 = Math.max(w.rect.x, d.x), x1 = Math.min(w.rect.x + w.rect.width, d.x + d.width);
    const y0 = Math.max(w.rect.y, d.y), y1 = Math.min(w.rect.y + w.rect.height, d.y + d.height);
    if (x1 <= x0 || y1 <= y0) return null;
    if (!names.has(w.pid)) names.set(w.pid, os.processName(w.pid));
    return { app: names.get(w.pid) ?? null, title: w.title, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, foreground: w.foreground };
  }).filter((w): w is NonNullable<typeof w> => w !== null);
  let strip: StripResult['strip'] = null;
  if (band > 0) {
    const b = await bottomOf(d, band, maxWidth);
    const gray = new Uint8Array(b.width * b.height);
    for (let p = 0; p < gray.length; p++) gray[p] = (b.rgba[p * 4]! * 77 + b.rgba[p * 4 + 1]! * 150 + b.rgba[p * 4 + 2]! * 29) >> 8;
    strip = { width: b.width, height: b.height, gray, top: b.top };
  }
  return { display: shape(d), windows, cursor: os.cursor(), idleMs: idleMs(), strip, inputFocus: await os.inputFocus() };
}

export interface Glance {
  /** JPEG of the display holding the foreground window, scaled to fit `maxWidth`×`maxHeight`. */
  jpeg: Uint8Array;
  /** The foreground window's title and program, when there is one. */
  foreground: string | null;
  foregroundApp: string | null;
  /** The windows open and not minimized, foreground first, on any display, with their rectangles in that display's physical pixels. */
  windows: Array<{ title: string; display: number | null; foreground: boolean; rect: { x: number; y: number; width: number; height: number } }>;
  /** The display shown, and its size in physical pixels. */
  display: { index: number; width: number; height: number } | null;
}

/**
 * Whether anyone is at the screen, then, if so, a glance at it. Nothing is captured while the session is locked or
 * nobody has touched keyboard or mouse for `AWAY_IDLE_MS`.
 */
export async function glance(opts: { maxWidth?: number; maxHeight?: number; quality?: number } = {}): Promise<Glance | { away: 'locked' | 'idle'; idleMs: number }> {
  const p = await presence();
  const gone = away(p);
  if (gone) return { away: gone, idleMs: p.idleMs };
  const list = displays();
  const all = os.windows();
  const fg = all.find((w) => w.foreground);
  const d = (fg && holding(list, fg.rect.x + fg.rect.width / 2, fg.rect.y + fg.rect.height / 2)) ?? list.find((x) => x.primary) ?? list[0]!;
  const img = await d.monitor.captureImage();
  const size = fit(img.width, img.height, opts.maxWidth ?? 1280, opts.maxHeight ?? 800);
  const rgba = downscale(await img.toRaw(), img.width, img.height, size);
  // screen captures do not hold the pointer: drawn where it is
  const c = os.cursor();
  if (holding(list, c.x, c.y) === d) drawCursor(rgba, size.width, size.height, (c.x - d.x) * (size.width / d.width), (c.y - d.y) * (size.height / d.height));
  const windows = all.filter((w) => !w.minimized && w.title.trim())
    .sort((a, b) => Number(b.foreground) - Number(a.foreground))
    .map((w) => {
      const on = holding(list, w.rect.x + w.rect.width / 2, w.rect.y + w.rect.height / 2);
      return { title: w.title, display: on?.index ?? null, foreground: w.foreground,
        rect: on ? { x: w.rect.x - on.x, y: w.rect.y - on.y, width: w.rect.width, height: w.rect.height } : w.rect };
    });
  return { jpeg: encodeJpeg(rgba, size.width, size.height, opts.quality ?? 70), foreground: p.foreground, foregroundApp: p.foregroundApp,
    windows, display: { index: d.index, width: d.width, height: d.height } };
}

/**
 * Watches the bottom of the display the pet is on (`at()`, a desktop point on it) for where the person works, without
 * a model. Every `everyMs` a cheap check (the windows and their stacking, the pointer, how long since their last input)
 * goes to `onSample`; when the windows showing along the bottom changed and stayed so for two checks, or every
 * `refreshMs`, a fresh look (strip.ts) goes to `onLook` first. Unsure readings are kept in `samplesDir`, if given, for
 * improving the reading. Returns a function that stops it.
 */
export function watchStrip(opts: {
  at: () => { x: number; y: number } | null; everyMs?: number; refreshMs?: number;
  onLook: (a: StripLook) => void; onSample: (a: StripLook) => void; samplesDir?: string;
}): () => void {
  if (process.platform !== 'win32') return () => {};
  const everyMs = opts.everyMs ?? 1500, refreshMs = opts.refreshMs ?? 30_000;
  let stopped = false, busy = false, lastKey = '', seenKey = '', lastLookAt = 0;
  let current: StripLook | null = null;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const at = opts.at();
      const cheap = readStrip(await stripNow(at, 0, 0));
      // what shows along the bottom must hold for two checks running: a window flashing up is not a change of work
      const steady = cheap.key === seenKey;
      seenKey = cheap.key;
      if ((cheap.key !== lastKey && steady) || Date.now() - lastLookAt > refreshMs) {
        const raw = await stripNow(at, Math.round(BAND * (cheap.display.scale || 1)), 1280);
        const full = readStrip(raw);
        lastKey = full.key; lastLookAt = Date.now(); current = full;
        // every full look is kept now (newest only), with where the pet was: the mode threshold is calibrated on them
        if (opts.samplesDir && raw.strip) keepSample(opts.samplesDir, raw, full);
        opts.onLook(full);
      }
      if (current) opts.onSample({ ...current, cursor: cheap.cursor, idleMs: cheap.idleMs });
    } catch (err) {
      console.warn('[screen] a look failed', err);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}

/** Readings kept for improving the reading later: the grey band as JPEG and what was found, newest only. */
const SAMPLES_KEPT = 200;
function keepSample(dir: string, raw: StripResult, look: StripLook): void {
  try {
    mkdirSync(dir, { recursive: true });
    const { width, height, gray } = raw.strip!;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < gray.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i]!; rgba[i * 4 + 3] = 255; }
    const name = `${Date.now()}-strip`;
    writeFileSync(join(dir, `${name}.jpg`), encodeJpeg(rgba, width, height, 80));
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ display: raw.display, stripTop: raw.strip!.top,
      stretches: look.stretches.map((s) => ({ from: s.from, to: s.to, app: s.window.app, title: s.window.title, rect: s.window.rect })), zones: look.zones, how: look.how, confidences: look.confidences,
      pets: look.pets ?? [] }));
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - SAMPLES_KEPT))) {
      rmSync(join(dir, f), { force: true });
      rmSync(join(dir, f.replace(/\.json$/, '.jpg')), { force: true });
    }
  } catch { /* a sample not kept loses nothing */ }
}

/**
 * The bottom band of the display holding `at`, in colour, marked for the model to read positions off (ticks every
 * 10%, kept-out stretches in red, spots as coloured lines; image.ts `drawMarks`). Null when nobody is at the screen.
 */
export async function bandPicture(at: { x: number; y: number } | null, marks: BandMarks, opts: { maxWidth?: number; quality?: number } = {}): Promise<BandResult | null> {
  if (process.platform !== 'win32' || away(await presence())) return null;
  const d = displayFor(displays(), at);
  const b = await bottomOf(d, Math.round(BAND * (d.scale || 1)), opts.maxWidth ?? 1600);
  // desktop pixels to the picture's
  const px = (x: number) => ((x - d.x) / d.width) * b.width;
  drawMarks(b.rgba, b.width, b.height, {
    zones: marks.zones.map(([a, z]) => [px(a), px(z)] as [number, number]),
    points: marks.points.map((p) => ({ x: px(p.x), color: p.color })),
  });
  return { jpeg: encodeJpeg(b.rgba, b.width, b.height, opts.quality ?? 80), width: b.width, height: b.height, display: shape(d) };
}
