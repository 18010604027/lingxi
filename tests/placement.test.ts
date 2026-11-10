import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { ScriptedModel } from './fixtures/scripted-model.ts';
import { MovedAwayDetector, countsAsMovedAway, inTheWay, repeatedRemovalFactor } from '../core/daily/placement.ts';
import { Agents } from '../core/agents/roles.ts';

describe('MovedAwayDetector', () => {
  it('hands on at the third move inside ten minutes, then keeps quiet for half an hour', () => {
    const d = new MovedAwayDetector();
    const min = 60_000;
    expect([0, 4, 8].map((m) => d.note(m * min))).toEqual([false, false, true]);
    expect(d.note(9 * min)).toBe(false);
    expect([40, 41, 42].map((m) => d.note(m * min))).toEqual([false, false, true]);
    // moves spread out never add up
    const slow = new MovedAwayDetector();
    expect([0, 11, 22, 33].map((m) => slow.note(m * min))).toEqual([false, false, false, false]);
  });
});

describe('a move by hand: in the way, or play', () => {
  const W = 2560;
  it('counts a far move from a spot it had just walked to', () => {
    expect(inTheWay({ from: 1400, to: 300, moving: true, stillSec: 0 }, W)).toEqual({ counts: true, weight: 1 });
    expect(inTheWay({ from: 1400, to: 300, moving: false, stillSec: 40 }, W)).toEqual({ counts: true, weight: 1 });
  });
  it('a short move of a pet standing about is play', () => {
    expect(inTheWay({ from: 1400, to: 1300, moving: false, stillSec: 600 }, W)).toEqual({ counts: false, weight: 0 });
  });
  it('picking it up while it walks cuts the walk short: that counts, near or far, even when where it was is unknown', () => {
    expect(inTheWay({ from: 1400, to: 1300, moving: true, stillSec: 0 }, W)).toEqual({ counts: true, weight: 1 });
    expect(inTheWay({ from: null, to: 1300, moving: true, stillSec: 0 }, W)).toEqual({ counts: true, weight: 0 });
  });
  it('a far move from a spot it had stood on long is half the evidence and not counted', () => {
    expect(inTheWay({ from: 1400, to: 300, moving: false, stillSec: 900 }, W)).toEqual({ counts: false, weight: 0.5 });
  });
  it('standing, without where it came from or went, nothing', () => {
    expect(inTheWay({ from: null, to: 300, moving: false, stillSec: 30 }, W).counts).toBe(false);
  });
  it('requires repeated qualified removals from the same layout and spot, and discounts a play burst', () => {
    const base = { kind: 'drop' as const, from: 1400, to: 300, moving: false, stillSec: 40 };
    const first = { ...base, at: 1_000, layout: 'window#mode-1' };
    const second = { ...base, at: 61_000, layout: 'window#mode-1' };
    const third = { ...base, at: 121_000, layout: 'window#mode-1' };
    expect(repeatedRemovalFactor(first, [first], first.layout, W, 120)).toBe(0);
    expect(repeatedRemovalFactor(second, [first, second], second.layout, W, 120)).toBe(0.5);
    expect(repeatedRemovalFactor(third, [first, second, third], third.layout, W, 120)).toBe(1);
    expect(repeatedRemovalFactor(third, [first, { ...second, layout: 'another-window#mode-1' }, third], third.layout, W, 120)).toBe(0.5);
    const throw1 = { ...base, kind: 'throw' as const, at: 1_000, layout: 'window#mode-1' };
    const throw2 = { ...throw1, at: 20_000 };
    expect(repeatedRemovalFactor(throw2, [throw1, throw2], throw2.layout, W, 120)).toBe(0);
    expect(repeatedRemovalFactor({ ...base, to: 1320, at: 130_000 }, [{ ...base, to: 1320, at: 129_000, layout: 'window#mode-1' }], 'window#mode-1', W, 120)).toBe(0);
  });

  it('counts each qualified far removal toward the global trigger before a spot repeats', () => {
    const detector = new MovedAwayDetector();
    const moves = [0, 60_000, 120_000].map((at, i) => ({
      from: 300 + i * 500, to: 0, moving: false, stillSec: 45, at,
    }));
    expect(moves.map((move) => countsAsMovedAway(move, W))).toEqual([true, true, true]);
    expect(moves.map((move) => detector.note(move.at))).toEqual([false, false, true]);
  });
});

describe('the pet in the way', () => {
  it('goes to the control center, which looks at the screen; the placement tools are gone (workarea cases decide)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'place-agents-'));
    const asked: string[] = [];
    const model = new ScriptedModel([(messages) => {
      asked.push(JSON.stringify(messages));
      return new AIMessage({content:'',tool_calls:[{id:'screen',name:'screen_glance',args:{}}]});
    }, (messages) => { expect(JSON.stringify(messages)).toContain('VS Code'); return new AIMessage('it was play'); }]);
    const agents = new Agents({ dataDir: dir, log: console, model: () => model, fileTools: () => [] });
    agents.screen = async () => 'In front: Code.exe (VS Code)';
    agents.foreground = () => 'Code.exe';
    agents.petX = () => 0.3;
    agents.start();
    const t0 = Date.now();
    for (const m of [0, 1, 2]) agents.noteMovedAway(t0 + m * 60_000);
    await agents.bus.whenIdle();
    expect(asked[0]).toContain('moved the pet away 3 times');
    expect(asked[0]).toContain('it now stands at 30% of its screen width');
    agents.close();
  });
});
