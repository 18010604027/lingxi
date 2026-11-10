/**
 * Where the pet keeps out of, case by case, as the person meets them 
 * Each case is the bottom of a display as the engine reads it (the windows in stacking order, topmost first, and the
 * grey band) and what the pet should end up keeping out of.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkMap, type WindowLook } from '../core/daily/workmap.ts';
import { readStrip, type StripLook } from '../core/screen/strip.ts';
import type { StripResult, StripWindow } from '../core/screen/types.ts';

const display = { index: 2, x: 0, y: 0, width: 2560, height: 1440, scale: 1 };
const open = () => new WorkMap(join(mkdtempSync(join(tmpdir(), 'situations-')), 'w.sqlite'));
const win = (app: string, x: number, y: number, width: number, height: number, foreground = false): StripWindow => ({ app, title: app, rect: { x, y, width, height }, foreground });
const MAXIMIZED = (app: string, foreground = false) => win(app, 0, 0, 2560, 1392, foreground);

/** The bottom 340 px of the display as grey, at 1280 across, with input boxes drawn at desktop spans `boxes`. */
function band(boxes: Array<[number, number]>) {
  const w = 1280, h = 170, gray = new Uint8Array(w * h).fill(250);
  for (const [a, b] of boxes) {
    const x0 = Math.round(a / 2), x1 = Math.round(b / 2), y0 = 60, y1 = 120;
    for (let x = x0; x <= x1; x++) { gray[y0 * w + x] = 222; gray[y1 * w + x] = 222; }
    for (let y = y0; y <= y1; y++) { gray[y * w + x0] = 222; gray[y * w + x1] = 222; }
  }
  return { width: w, height: h, gray, top: 1100 };
}
const read = (windows: StripWindow[], boxes: Array<[number, number]> = []): StripLook =>
  readStrip({ display, windows, cursor: { x: 0, y: 0 }, idleMs: 0, strip: band(boxes) } satisfies StripResult);
/** What the pet keeps out of, as the app works it out. */
const keepOut = (m: WorkMap, st: StripLook) => {
  const l: WindowLook = { app: null, key: st.key, window: st.band, display: st.display, zones: st.zones, confidences: st.confidences, confidence: Math.max(0, ...st.confidences) };
  return m.zones(l);
};
const covers = (zones: Array<[number, number]>, x: number) => zones.some(([a, b]) => x >= a && x < b);

describe('situations', () => {
  it('a maximized window: only its input box', () => {
    const z = keepOut(open(), read([MAXIMIZED('claude.exe', true)], [[1000, 1840]]));
    expect(covers(z, 1400)).toBe(true);
    expect(covers(z, 600)).toBe(false);
    expect(covers(z, 2200)).toBe(false);
  });

  it('a window in front floating higher up, a maximized one behind: the one behind, whose box is where the pet walks', () => {
    const z = keepOut(open(), read([win('Weixin.exe', 400, 173, 1120, 950, true), MAXIMIZED('claude.exe')], [[1000, 1840]]));
    expect(covers(z, 1400)).toBe(true);
    expect(covers(z, 500)).toBe(false);
  });

  it('only a floating window, the desktop behind it: nothing, the pet walks under it', () => {
    const z = keepOut(open(), read([win('Weixin.exe', 400, 173, 1120, 950, true), win('explorer.exe', 0, 0, 2560, 1440)].map((w, i) => (i ? { ...w, title: 'Program Manager' } : w))));
    expect(z).toEqual([]);
  });

  it('two windows side by side, half each: both stretches', () => {
    const z = keepOut(open(), read([win('Code.exe', 0, 0, 1280, 1392, true), win('chrome.exe', 1280, 0, 1280, 1392)]));
    expect(covers(z, 640)).toBe(true);
    expect(covers(z, 1900)).toBe(true);
  });

  it('a small window in front low down, over a maximized one: the small one where it shows, the big one\'s box where it shows', () => {
    const st = read([win('notepad.exe', 200, 900, 500, 492, true), MAXIMIZED('claude.exe')], [[1000, 1840]]);
    expect(st.stretches.map((s) => s.window.app)).toEqual(['claude.exe', 'notepad.exe', 'claude.exe']);
    const z = keepOut(open(), st);
    expect(covers(z, 450)).toBe(true);
    expect(covers(z, 1400)).toBe(true);
    expect(covers(z, 100)).toBe(false);
  });

  it('the pet\'s own window and the shell do not count', () => {
    const st = read([win('electron.exe', 0, 0, 2560, 1440, false), MAXIMIZED('claude.exe', true)], [[1000, 1840]]);
    expect(st.stretches.every((s) => s.window.app === 'claude.exe')).toBe(true);
  });

  it('something inside the box found as the box (a picture card): the zone does not shrink', () => {
    const m = open();
    keepOut(m, read([MAXIMIZED('claude.exe', true)], [[1000, 1840]]));
    const z = keepOut(m, read([MAXIMIZED('claude.exe', true)], [[1080, 1560]]));
    expect(covers(z, 1700)).toBe(true);
  });

  it('a full-width window shown in another mode: the zones of both do not add up to the whole width', () => {
    const m = open();
    keepOut(m, read([MAXIMIZED('claude.exe', true)], [[320, 1000]]));
    let z: Array<[number, number]> = [];
    for (let i = 0; i < 3; i++) z = keepOut(m, read([MAXIMIZED('claude.exe', true)], [[1200 + i, 2280]]));
    expect(covers(z, 1700)).toBe(true);
    expect(covers(z, 600)).toBe(false);
  });

  it('a look that finds no box after one that did: the earlier one holds', () => {
    const m = open();
    keepOut(m, read([MAXIMIZED('claude.exe', true)], [[1000, 1840]]));
    const z = keepOut(m, read([MAXIMIZED('claude.exe', true)], []));
    expect(covers(z, 1400)).toBe(true);
    expect(covers(z, 700)).toBe(false);
  });

  it('moved far away by hand right after walking to a spot the look missed: kept out of from then on, for that arrangement only', () => {
    const m = open();
    const st = read([MAXIMIZED('claude.exe', true)], [[1000, 1840]]);
    const l: WindowLook = { app: null, key: st.key, window: st.band, display: st.display, zones: st.zones, confidences: st.confidences, confidence: 1 };
    m.recordTouch(l, { kind: 'throw', from: 2300, to: 400, moving: true, stillSec: 0, at: Date.now() });
    expect(covers(keepOut(m, st), 2300)).toBe(true);
    expect(covers(keepOut(m, read([MAXIMIZED('chrome.exe', true)], [[1000, 1840]])), 2300)).toBe(false);
  });
});
