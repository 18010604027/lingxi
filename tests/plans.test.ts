import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HALF_DAYS, PBINS, PlanBook, STEP, binOf, combineWorkareaZones, mergeNarrow, planKey, spansOf, subtractSpans, takenStep } from '../core/daily/plans.ts';
import { CONTENT } from '../core/daily/scene.ts';
import { repeatedRemovalFactor } from '../core/daily/placement.ts';

const book = () => new PlanBook(mkdtempSync(join(tmpdir(), 'plans-')));
const blank = new Array(PBINS).fill(0);
const at = (frac: number) => binOf(frac);
const DAY = 86_400_000;

describe('plans per part and mode', () => {
  it('opens a directly placed spot through detected keep-out, while keeping the live caret blocked', () => {
    expect(combineWorkareaZones([[100, 900]], [[100, 900]], [0.95], [[450, 550]], 100, [[390, 610]]))
      .toEqual([[100, 390], [450, 550], [610, 900]]);
    expect(subtractSpans([[0, 100]], [[20, 30], [40, 80]])).toEqual([[0, 20], [30, 40], [80, 100]]);
  });

  it('lets a direct hand placement update the selected template even when the control center settled it', () => {
    const b = book();
    b.settle('p#1', { keepOut: [[0.2, 0.8]], free: [[0, 0.2], [0.8, 1]], caseId: 'case-1', confidence: 0.9 });
    b.noteFree('p#1', 0.5, 2);
    expect(b.blocked('p#1', blank, CONTENT).slice(at(0.46), at(0.54)).every((v) => !v)).toBe(true);
    expect(b.blocked('p#1', blank, CONTENT)[at(0.3)]).toBe(true);
  });

  it('keeps out of what has content in this look, and walks the blank', () => {
    const b = book(), content = blank.map((_, i) => (i >= at(0.3) && i < at(0.6) ? 0.1 : 0));
    const blocked = b.blocked('p#1', content, CONTENT);
    expect(blocked[at(0.45)]).toBe(true);
    expect(blocked[at(0.1)]).toBe(false);
    expect(spansOf(blocked, 0, 1000)).toEqual([[Math.round(at(0.3) / PBINS * 1000), Math.round(at(0.6) / PBINS * 1000)]]);
  });

  it('learns from the hand: where it was picked up while walking turns blank into kept out; where it was put down turns content into free', () => {
    const b = book();
    b.note('p#1', 0.8, takenStep({ kind: 'drop', moving: true, stillSec: 0 }));
    expect(b.blocked('p#1', blank, CONTENT)[at(0.8)]).toBe(true);
    const busy = blank.map(() => 0.1);
    for (let i = 0; i < 2; i++) b.note('p#1', 0.2, STEP.putDown);
    expect(b.blocked('p#1', busy, CONTENT)[at(0.2)]).toBe(false);
  });

  it('needs repeated same-layout removal evidence, but one landing in a blank area adds free evidence', () => {
    const b = book(), t0 = Date.now(), layout = 'part#mode-1';
    const move = (at: number) => ({ kind: 'drop' as const, from: 1280, to: 256, moving: false, stillSec: 30, at, layout });
    const first = move(t0);
    const f1 = repeatedRemovalFactor(first, [first], layout, 2560, 120);
    if (f1) b.note(layout, 0.5, takenStep(first) * f1);
    expect(b.blocked(layout, blank, CONTENT)[at(0.5)]).toBe(false);
    const second = move(t0 + 60_000), f2 = repeatedRemovalFactor(second, [first, second], layout, 2560, 120);
    b.note(layout, 0.5, takenStep(second) * f2);
    expect(b.blocked(layout, blank, CONTENT)[at(0.5)]).toBe(false);
    const third = move(t0 + 120_000), f3 = repeatedRemovalFactor(third, [first, second, third], layout, 2560, 120);
    b.note(layout, 0.5, takenStep(third) * f3);
    expect(b.blocked(layout, blank, CONTENT)[at(0.5)]).toBe(true);
    const occupied = blank.map(() => 0.1);
    expect(b.blocked('part#mode-2', occupied, CONTENT, t0)[at(0.1)]).toBe(true);
    b.note('part#mode-2', 0.1, STEP.putDown, 3, t0);
    expect(b.blocked('part#mode-2', occupied, CONTENT, t0)[at(0.1)]).toBe(false);
  });

  it('a throw from where it stood long counts least', () => {
    expect(takenStep({ kind: 'throw', moving: false, stillSec: 900 })).toBeLessThan(takenStep({ kind: 'drop', moving: false, stillSec: 30 }));
    expect(takenStep({ kind: 'drop', moving: true, stillSec: 0 })).toBe(STEP.takenWalking);
  });

  it('keeps each part and mode to itself: what was learnt in one window does not reach another, nor another layout of it', () => {
    const b = book();
    b.note(planKey('2|claude.exe@0+25', 1), 0.5, 3);
    expect(b.blocked(planKey('2|claude.exe@0+25', 1), blank, CONTENT)[at(0.5)]).toBe(true);
    expect(b.blocked(planKey('2|claude.exe@0+25', 2), blank, CONTENT)[at(0.5)]).toBe(false);
    expect(b.blocked(planKey('2|code.exe@25+25', 1), blank, CONTENT)[at(0.5)]).toBe(false);
  });

  it('lets what was learnt fade, and clamps it so a few moves by hand can always turn a bin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    const t0 = Date.now();
    const b = new PlanBook(dir);
    for (let i = 0; i < 20; i++) b.note('p#1', 0.5, 3, 3, t0);
    expect(b.learnt('p#1')[at(0.5)]).toBeCloseTo(3, 3);
    for (let i = 0; i < 3; i++) b.note('p#1', 0.5, STEP.putDown, 3, t0);
    expect(b.blocked('p#1', blank, CONTENT, t0)[at(0.5)]).toBe(false);
    const later = new PlanBook(dir);
    b.note('p#2', 0.5, 2, 3, t0);
    expect(later.blocked('p#2', blank, CONTENT, t0 + 3 * HALF_DAYS * DAY)[at(0.5)]).toBe(false);
  });

  it('holds a settled plan as decided, whatever the content and what is learnt later', () => {
    const b = book();
    b.settle('p#1', { keepOut: [[0.4, 0.7]], free: [[0, 0.4], [0.7, 1]], caseId: 'case-1', confidence: 0.9 });
    b.note('p#1', 0.1, 3);
    const blocked = b.blocked('p#1', blank.map(() => 0.5), CONTENT);
    expect(blocked[at(0.1)]).toBe(false);
    expect(blocked[at(0.5)]).toBe(true);
    expect(b.settledFor('p#1')?.caseId).toBe('case-1');
  });

  it('keeps each settled version and can restore the preceding decision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plans-'));
    const b = new PlanBook(dir);
    b.settle('p#1', { keepOut: [[0.2, 0.4]], free: [[0, 0.2], [0.4, 1]], caseId: 'case-1', confidence: 0.9 });
    b.settle('p#1', { keepOut: [[0.5, 0.7]], free: [[0, 0.5], [0.7, 1]], caseId: 'case-2', confidence: 0.95 });
    expect(b.settledHistory('p#1').map((item) => item.caseId)).toEqual(['case-1', 'case-2']);
    expect(b.rollbackSettled('p#1')?.caseId).toBe('case-1');
    expect(b.settledFor('p#1')?.caseId).toBe('case-1');
    expect(b.settledHistory('p#1').map((item) => item.caseId)).toEqual(['case-1', 'case-2']);
    expect(b.rollbackSettled('p#1')).toBeNull();
    b.close();
    const reopened = new PlanBook(dir);
    expect(reopened.settledFor('p#1')?.caseId).toBe('case-1');
    expect(reopened.settledHistory('p#1').map((item) => item.caseId)).toEqual(['case-1', 'case-2']);
    reopened.close();
  });
});

describe('gaps too narrow to stand in', () => {
  it('joins stretches with a gap under the width, and leaves wider gaps open', () => {
    expect(mergeNarrow([[1493, 1707], [853, 1333]], 180)).toEqual([[853, 1707]]);
    expect(mergeNarrow([[0, 100], [400, 500]], 180)).toEqual([[0, 100], [400, 500]]);
  });
});

describe('current window detections over a mode plan', () => {
  it('overlays certain input/window rectangles but leaves low-confidence middle guesses to the template', () => {
    expect(combineWorkareaZones([[0, 100]], [[300, 500], [700, 900]], [0.95, 0.3], [[520, 540]], 40))
      .toEqual([[0, 100], [300, 540]]);
  });
});
