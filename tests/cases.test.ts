import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cases, caseIdOf } from '../core/agents/cases.ts';
import { PBINS, PlanBook } from '../core/daily/plans.ts';
import { WORKAREA_KIND, tooWide, workareaKind, workareaSections } from '../core/daily/workarea-case.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'cases-'));
/** A settle as the app does it, the case's window spanning the whole screen. */
const settleInto = (plans: PlanBook) => (c: { id: string; key: string }, keepOut: Array<[number, number]>, free: Array<[number, number]>, confidence: number) => {
  plans.settle(c.key, { keepOut, free, caseId: c.id, confidence });
  return `settled: keep out ${keepOut.map(([a, b]) => `${Math.round(a * 100)}–${Math.round(b * 100)}%`).join(', ')}`;
};
const answer = (over: Record<string, unknown> = {}) => ({
  segments: [{ from: 0, to: 12, what: 'conversation list' }, { from: 12, to: 100, what: 'chat' }],
  work: [{ from: 30, to: 70, what: 'input box' }],
  verdict: 'zone_wrong', keep_out: [[30, 70]], free: [[0, 30], [70, 100]], moves_mean: 'go_there', mode: 'Claude, chat page',
  same_mode_as_before: null, why: 'The input box spans 30–70%; the red reaches far past it into empty space.', confidence: 0.85, ...over,
});

describe('cases for the control center', () => {
  it('renders the question, the facts, the pictures and the answer asked for, and finds the case from the task body', () => {
    const c = new Cases(dir());
    c.register(WORKAREA_KIND, workareaKind(settleInto(new PlanBook(dir()))));
    const s = c.open({ kind: WORKAREA_KIND, key: 'k', question: 'Where may it walk?', sections: [{ title: 'Facts', lines: ['one'] }],
      images: [{ label: 'bottom', legend: 'red: kept out', jpeg: new Uint8Array([1, 2, 3]) }] });
    const text = c.render(s);
    expect(caseIdOf(text)).toBe(s.id);
    for (const part of ['Question: Where may it walk?', '## Facts', '- one', '1. bottom: red: kept out', 'case_decide', '"keep_out"', '(never decided before)']) expect(text).toContain(part);
    expect(c.images(c.get(s.id)!)[0]!.jpeg).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a vague or malformed answer and says what is wrong', () => {
    const c = new Cases(dir());
    c.register(WORKAREA_KIND, workareaKind(settleInto(new PlanBook(dir()))));
    const s = c.open({ kind: WORKAREA_KIND, key: 'k', question: 'q', sections: [], images: [] });
    expect(c.decide(s.id, answer({ verdict: 'maybe' })).text).toMatch(/verdict/);
    expect(c.decide(s.id, answer({ keep_out: [[70, 30]] })).text).toMatch(/keep_out/);
    expect(c.decide(s.id, answer({ why: 'looks ok' })).text).toMatch(/why/);
    expect(c.decide(s.id, answer()).ok).toBe(true);
  });

  it('settles the plan on a sure answer: the rules no longer move it, and the next case carries the history', () => {
    const plans = new PlanBook(dir());
    const c = new Cases(dir());
    c.register(WORKAREA_KIND, workareaKind(settleInto(plans)));
    const key = '2|claude.exe@0+50#3';
    // the rules had it kept out of nearly everything
    for (let i = 0; i < 20; i++) plans.note(key, 0.5, 3, 30);
    const s = c.open({ kind: WORKAREA_KIND, key, question: 'q', sections: [], images: [] });
    expect(c.decide(s.id, answer()).text).toMatch(/^settled/);
    const blocked = plans.blocked(key, new Array(PBINS).fill(1), 0.02);
    expect(blocked.slice(0, Math.floor(0.3 * PBINS)).some(Boolean)).toBe(false);
    expect(blocked.slice(Math.ceil(0.3 * PBINS), Math.floor(0.7 * PBINS)).every(Boolean)).toBe(true);
    // what the rules learn later does not move it
    plans.note(key, 0.1, 3, 5);
    expect(plans.blocked(key, null, 0.02)[Math.floor(0.1 * PBINS)]).toBe(false);
    const next = c.render(c.open({ kind: WORKAREA_KIND, key, question: 'q', sections: [], images: [] }));
    expect(next).toContain('[zone_wrong; mode Claude, chat page; confidence 0.85] keep out 30–70%');
  });

  it('only keeps an unsure answer, without changing anything', () => {
    const plans = new PlanBook(dir());
    const c = new Cases(dir());
    c.register(WORKAREA_KIND, workareaKind(settleInto(plans)));
    const s = c.open({ kind: WORKAREA_KIND, key: 'k#1', question: 'q', sections: [], images: [] });
    expect(c.decide(s.id, answer({ confidence: 0.4 })).text).toMatch(/^kept only/);
    expect(plans.settledFor('k#1')).toBeNull();
  });
});

const W = 2560;

describe('the facts of a work-area case', () => {
  it('puts every position in percent and tells walking from standing', () => {
    const lines = workareaSections({
      why: 'moved 3 times', display: { x: 0, width: W },
      stretches: [{ app: 'claude.exe', title: 'Claude', from: 0, to: W, found: 'claude.exe: input at 12–89%' }],
      zones: [[320, 2280]], basis: ['rules'], pet: { x: 160, doing: 'walking' },
      moves: [{ at: Date.now() - 5000, kind: 'drop', from: 1280, to: 1229, moving: true, stillSec: 0 }],
      cursor: { x: 1280, y: 1400 }, caret: { x: 640, width: 2 }, idleMs: 2000, inFront: 'claude.exe',
    }).flatMap((s) => [s.title, ...s.lines]).join('\n');
    for (const part of ['0%–100%: claude.exe', '13%–89%', 'stands at 6%', 'drop from 50% to 48%; it was walking', 'typing caret at 25%']) expect(lines).toContain(part);
  });
});
