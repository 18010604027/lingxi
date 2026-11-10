import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModeBook, occupied, partKey, readScene, structure, structureDistance, SAME, type Gray } from '../core/daily/scene.ts';
import { PlanBook, planKey } from '../core/daily/plans.ts';

const W = 400, H = 75;
/** A light page: a sidebar divider, an input box with a faint frame, some text lines in it or above, a pet body. */
function page(o: { box?: [number, number, number, number]; text?: number; pet?: number; divider?: number } = {}): Gray {
  const g: Gray = { width: W, height: H, data: new Uint8Array(W * H).fill(250) };
  const set = (x: number, y: number, v: number) => { if (x >= 0 && x < W && y >= 0 && y < H) g.data[y * W + x] = v; };
  if (o.divider !== undefined) for (let y = 0; y < H; y++) set(o.divider, y, 235);
  if (o.box) {
    const [x0, y0, x1, y1] = o.box;
    for (let x = x0; x <= x1; x++) { set(x, y0, 238); set(x, y1, 238); }
    for (let y = y0; y <= y1; y++) { set(x0, y, 238); set(x1, y, 238); }
  }
  // text: short dark strokes scattered along a line, shifted by `text`
  for (let k = 0; k < 40; k++) { const x = 60 + ((k * 7 + (o.text ?? 0) * 13) % 300); for (let y = 8; y < 14; y++) set(x, y + ((o.text ?? 0) % 3), 40); }
  if (o.pet !== undefined) for (let y = 10; y < H; y++) for (let x = o.pet; x < o.pet + 30; x++) set(x, y, (x * 37 + y * 11) % 200);
  return g;
}

describe('the structure of a part', () => {
  const claude = { divider: 43, box: [160, 30, 280, 53] as [number, number, number, number] };

  it('finds the long lines of a light page (a divider, an input box frame) and not the text', () => {
    const s = structure(page(claude), 0, W);
    expect(s.cols.some((c) => Math.abs(c - 43.5 / W) < 0.01)).toBe(true);
    expect(s.rows.length).toBeGreaterThanOrEqual(2);
    expect(structure(page({ text: 0 }), 0, W)).toEqual({ cols: [], rows: [] });
  });

  it('does not change as text moves through the strip', () => {
    expect(structureDistance(structure(page({ ...claude, text: 0 }), 0, W), structure(page({ ...claude, text: 5 }), 0, W))).toBeLessThanOrEqual(SAME);
  });

  it('leaves the pet out when its body is masked, and tells another layout apart', () => {
    const base = structure(page(claude), 0, W);
    const withPet = structure(page({ ...claude, pet: 320 }), 0, W, [[318, 352]]);
    expect(structureDistance(base, withPet)).toBeLessThanOrEqual(SAME);
    const other = structure(page({ divider: 120, box: [20, 10, 380, 60] }), 0, W);
    expect(structureDistance(base, other)).toBeGreaterThan(SAME);
  });
});

describe('modes of a part', () => {
  const r = (y: number, from: number, to: number) => ({ y, from, to });
  const s1 = { cols: [0.108], rows: [r(0.41, 0.4, 0.7), r(0.71, 0.4, 0.7), r(0.98, 0, 1)] };
  const s2 = { cols: [0.02, 0.16, 0.5], rows: [r(0.86, 0.05, 0.95), r(0.91, 0.05, 0.95)] };
  const book = () => new ModeBook(mkdtempSync(join(tmpdir(), 'scene-')));

  it('keys a part by display and geometry, independently of program labels', () => {
    const d = { index: 2, x: 0, y: 0, width: 2560, height: 1440 };
    expect(partKey(d, 'Claude.exe', 0, 2560, { y: 0, height: 1440 })).toBe('2|@0+50^0+50');
    expect(partKey(d, 'Claude.exe', 0, 1280, { y: 720, height: 720 })).toBe('2|@0+25^25+25');
    expect(partKey(d, 'Other.exe', 10, 1290, { y: 720, height: 720 })).toBe('2|@0+25^25+25');
    expect(partKey(d, 'Claude.exe', 0, 1280, { y: 0, height: 1440 })).not.toBe(partKey(d, 'Claude.exe', 0, 1280, { y: 720, height: 720 }));
  });

  it('takes the first look as a mode, and the same layout again as that mode', () => {
    const b = book();
    const first = b.identify('p', s1);
    expect(first.status).toBe('new');
    expect(b.identify('p', { cols: [0.11], rows: [r(0.41, 0.41, 0.69), r(0.98, 0, 1)] })).toMatchObject({ status: 'same', mode: { id: first.mode.id } });
  });

  it('keeps the last mode through a flash, and makes a new mode only when the new layout holds', () => {
    const b = book();
    const m1 = b.identify('p', s1).mode;
    expect(b.identify('p', s2)).toMatchObject({ status: 'flash', mode: { id: m1.id } });
    expect(b.identify('p', s1)).toMatchObject({ status: 'same', mode: { id: m1.id } });
    expect(b.identify('p', s2).status).toBe('flash');
    const held = b.identify('p', s2);
    expect(held.status).toBe('new');
    expect(held.mode.id).not.toBe(m1.id);
    expect(b.modes('p')).toHaveLength(2);
  });

  it('matches synthetic input rectangles by their moving-area edge heights and spans', () => {
    const b = book();
    const part = 'synthetic-chat';
    const base = structure(page({ box: [160, 30, 280, 53] }), 0, W);
    const slightEdgeNoise = structure(page({ box: [162, 31, 282, 54] }), 0, W);
    const tallerInput = structure(page({ box: [160, 15, 280, 53] }), 0, W);
    const first = b.identify(part, base);
    expect(b.identify(part, slightEdgeNoise).status).toBe('same');
    expect(b.identify(part, tallerInput)).toMatchObject({ status: 'flash', mode: { id: first.mode.id } });
    expect(b.identify(part, tallerInput).status).toBe('new');
  });

  it('keeps modes per part: the same layout in another part is that part\'s own', () => {
    const b = book();
    b.identify('a', s1);
    expect(b.identify('b', s1).status).toBe('new');
    expect(b.modes('a')).toHaveLength(1);
  });

  it('reuses a hand-selected legacy plan after labels change, but never for a different image at the same geometry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scene-labels-'));
    const modes = new ModeBook(dir), plans = new PlanBook(dir);
    try {
      const old = modes.identify('1|old.exe@0+50^0+48', s1).mode;
      const oldKey = planKey(old.part, old.id);
      plans.settle(oldKey, { keepOut: [[0, 1]], free: [], caseId: 'old-case', confidence: 1 });
      plans.noteFree(oldKey, 0.5, 2);
      const same = modes.identify('1|@0+50^0+48', s1);
      expect(same).toMatchObject({ status: 'same', mode: { id: old.id, part: old.part } });
      expect(plans.manualFree(planKey(same.mode.part, same.mode.id))[24]).toBe(true);
      expect(modes.identify('1|@0+50^0+48', s2).status).toBe('flash');
      const different = modes.identify('1|@0+50^0+48', s2);
      expect(different.status).toBe('new'); expect(different.mode.id).not.toBe(old.id);
      expect(plans.manualFree(planKey(different.mode.part, different.mode.id)).some(Boolean)).toBe(false);
    } finally { plans.close(); modes.close(); }
  });
});

describe('reading the scene from a look', () => {
  // a 1280×170 band of a 2560×1440 display at half scale; two windows side by side down to y 1392, the taskbar below
  const band = (pet: number | null) => {
    const w = 1280, h = 170, top = 1440 - 340, g = new Uint8Array(w * h).fill(250);
    const set = (x: number, y: number, v: number) => { if (x >= 0 && x < w && y >= 0 && y < h) g[y * w + x] = v; };
    const yOf = (deskY: number) => Math.round((deskY - top) / 2);
    // left window: an input box frame; right window: a toolbar edge across it
    for (let x = 140; x <= 500; x++) { set(x, yOf(1300), 236); set(x, yOf(1360), 236); }
    for (let x = 700; x <= 1260; x++) set(x, yOf(1340), 236);
    // the taskbar: dark, below the windows
    for (let y = yOf(1392); y < h; y++) for (let x = 0; x < w; x++) set(x, y, 30);
    if (pet !== null) for (let y = 60; y < yOf(1392); y++) for (let x = pet; x < pet + 40; x++) set(x, y, (x * 31 + y * 7) % 220);
    return { width: w, height: h, data: g, top };
  };
  const look = (pet: number | null) => ({
    display: { index: 1, x: 0, y: 0, width: 2560, height: 1440, scale: 1 },
    stretches: [
      { from: 0, to: 1280, window: { app: 'Claude.exe', title: 'Claude', rect: { y: 0, height: 1392 } } },
      { from: 1280, to: 2560, window: { app: 'Code.exe', title: 'x.ts', rect: { y: 0, height: 1392 } } },
    ],
    gray: band(pet), pets: pet === null ? [] : [{ x: pet * 2, width: 80 }],
  });

  it('gives each window its own part and mode, leaves the taskbar out, and is not moved by the pet walking across', () => {
    const b = new ModeBook(mkdtempSync(join(tmpdir(), 'scene-')));
    const first = readScene(look(null), b);
    expect(first.map((p) => p.key)).toEqual(['1|@0+25^0+48', '1|@25+25^0+48']);
    expect(first[0]!.structure.rows.length).toBeGreaterThanOrEqual(2);
    expect(first.every((p) => p.seen.status === 'new')).toBe(true);
    const again = readScene(look(300), b);
    expect(again.map((p) => p.seen.status)).toEqual(['same', 'same']);
    expect(again[0]!.seen.mode.id).toBe(first[0]!.seen.mode.id);
  });

  it('keeps out of what has content (icons, text), not of blank stretched with lines (a chart axis, a window edge)', () => {
    const g = look(null).gray;
    const set = (x: number, y: number, v: number) => { g.data[y * g.width + x] = v; };
    // icons and text inside the input box (desk 300–700): short dark strokes
    for (let x = 150; x < 350; x += 6) for (let y = 100; y < 108; y++) set(x, y, 60);
    // a chart axis across the right window: one long line, blank around it
    for (let x = 700; x < 1260; x++) set(x, 90, 120);
    const z = occupied({ ...look(null), gray: g }, 120);
    expect(z.some(([a, b]) => a <= 320 && b >= 680)).toBe(true);
    expect(z.every(([a, b]) => b <= 1300 || a >= 2500)).toBe(true);
  });
});
