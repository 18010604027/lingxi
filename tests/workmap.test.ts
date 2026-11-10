import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkMap, layoutKey, type WindowLook } from '../core/daily/workmap.ts';
import { findBox } from '../core/screen/inputbox.ts';

const display = { index: 2, x: 0, y: 0, width: 2560, height: 1440 };
/** A full-screen window whose look found an input box at 40–70%. */
const look = (confidence = 0.9): WindowLook => ({ app: 'claude.exe', window: { x: 0, y: 0, width: 2560, height: 1440 }, display, zones: [[1024, 1792]], confidence });
const open = () => new WorkMap(join(mkdtempSync(join(tmpdir(), 'workmap-')), 'w.sqlite'));
const covers = (zones: Array<[number, number]>, x: number) => zones.some(([a, b]) => x >= a && x < b);

describe('the work map', () => {
  it('starts from the look when it is sure, and not when it is only a guess', () => {
    const m = open();
    expect(covers(m.zones(look(0.9)), 1400)).toBe(true);
    expect(covers(m.zones(look(0.9)), 300)).toBe(false);
    expect(open().zones(look(0.3))).toEqual([]);
    m.close();
  });

  it('learns where the person moves the pointer along the bottom while working; it only adds', () => {
    const m = open(), l = look(0.9);
    // they work in the box and at a toolbar at 20%, moving the pointer about
    for (let i = 0; i < 40; i++) { m.noteActivity(l, { x: 1100 + (i % 2) * 8, y: 1350 }, 500); m.noteActivity(l, { x: 520 + (i % 2) * 8, y: 1380 }, 500); }
    // up in the page, while away, or with the pointer resting, does not count
    expect(m.noteActivity(l, { x: 2000, y: 200 }, 500)).toBe(false);
    expect(m.noteActivity(l, { x: 2000, y: 1350 }, 60_000)).toBe(false);
    expect(m.noteActivity(l, { x: 2000, y: 1350 }, 500)).toBe(false);
    const z = m.zones(l);
    expect(covers(z, 1100)).toBe(true);
    expect(covers(z, 520)).toBe(true);
    // the rest of the box the look found stays: typing happens wherever the pointer rests
    expect(covers(z, 1700)).toBe(true);
    expect(covers(z, 2300)).toBe(false);
    m.close();
  });

  it('keeps a sure look for the layout when a later look misses', () => {
    const m = open();
    expect(covers(m.zones(look(0.95)), 1400)).toBe(true);
    // the next look could not find the box and guessed the middle, unsure
    const miss: WindowLook = { ...look(0.3), zones: [[640, 1920]] };
    expect(covers(m.zones(miss), 1400)).toBe(true);
    expect(covers(m.zones(miss), 700)).toBe(false);
    m.close();
  });

  it('keeps every move by hand as its own record, and works the evidence out of them by the rule', () => {
    const m = open(), l = look(0.9), now = Date.now();
    // walked to 300 and was moved far away: in the way there
    m.recordTouch(l, { kind: 'throw', from: 300, to: 2400, moving: true, stillSec: 0, at: now });
    expect(covers(m.zones(l), 300)).toBe(true);
    // played with: a short move counts for nothing, either end
    m.recordTouch(l, { kind: 'drop', from: 2000, to: 2100, moving: false, stillSec: 5, at: now });
    expect(covers(m.zones(l), 2000)).toBe(false);
    // put down far from where it was: fine where it landed
    m.recordTouch(l, { kind: 'drop', from: 300, to: 1400, moving: false, stillSec: 30, at: now });
    m.recordTouch(l, { kind: 'drop', from: 300, to: 1400, moving: false, stillSec: 30, at: now });
    expect(covers(m.zones(l), 1400)).toBe(false);
    expect(m.touches()).toHaveLength(4);
    m.close();
  });

  it('a far move from a spot it had stood on long weighs half; old moves fade', () => {
    const m = open(), l = look(0.9), now = Date.now();
    // two such moves are not enough, a third is: half the weight of moves right after walking there
    for (let i = 0; i < 2; i++) m.recordTouch(l, { kind: 'drop', from: 2300, to: 300, moving: false, stillSec: 1800, at: now });
    expect(covers(m.zones(l), 2300)).toBe(false);
    m.recordTouch(l, { kind: 'drop', from: 2300, to: 300, moving: false, stillSec: 1800, at: now });
    expect(covers(m.zones(l), 2300)).toBe(true);
    const n = open();
    n.recordTouch(l, { kind: 'throw', from: 2300, to: 300, moving: true, stillSec: 0, at: now - 120 * 86_400_000 });
    expect(covers(n.zones(l), 2300)).toBe(false);
    m.close(); n.close();
  });

  it('remembers per layout, across opening again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'workmap-'));
    const a = new WorkMap(join(dir, 'w.sqlite'));
    a.recordTouch(look(), { kind: 'throw', from: 300, to: 2400, moving: true, stillSec: 0, at: Date.now() });
    a.close();
    const b = new WorkMap(join(dir, 'w.sqlite'));
    expect(covers(b.zones(look()), 300)).toBe(true);
    // the same program in a half-width window is another layout
    expect(layoutKey({ ...look(), window: { x: 0, y: 0, width: 1280, height: 1440 } })).not.toBe(layoutKey(look()));
    b.close();
  });
});

describe('finding the input box', () => {
  /** A white strip with a light-grey bordered box from `x0` to `x1`, rows `y0`..`y1`, and some text lines above. */
  const strip = (w: number, h: number, box: [number, number, number, number]) => {
    const gray = new Uint8Array(w * h).fill(250);
    const [x0, x1, y0, y1] = box;
    for (let x = x0; x <= x1; x++) { gray[y0 * w + x] = 225; gray[y1 * w + x] = 225; }
    for (let y = y0; y <= y1; y++) { gray[y * w + x0] = 225; gray[y * w + x1] = 225; }
    // a text line above: long, but no sides
    for (let x = Math.round(w * 0.45); x < w * 0.6; x++) gray[10 * w + x] = 120;
    return { width: w, height: h, gray };
  };

  it('finds a faint bordered box, not the text above it', () => {
    const b = findBox(strip(1280, 250, [520, 900, 200, 240]))!;
    expect(b.span[0]).toBeCloseTo(520 / 1280, 2);
    expect(b.span[1]).toBeCloseTo(900 / 1280, 2);
    expect(b.confidence).toBeGreaterThan(0.6);
  });

  it('finds nothing in a blank strip', () => {
    expect(findBox({ width: 640, height: 100, gray: new Uint8Array(64000).fill(250) })).toBeNull();
  });
});
