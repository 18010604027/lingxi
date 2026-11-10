import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Consolidator, parseCards, promptOf } from '../core/memory/consolidate.ts';
import { EventMemory } from '../core/memory/events.ts';
import { Judgments } from '../core/learning/judgments.ts';

function say(dir: string, cursor: number, ts: string, text: string, pet = false) {
  mkdirSync(join(dir, 'runs', 'r1'), { recursive: true });
  appendFileSync(join(dir, 'runs', 'r1', 'events.jsonl'), `${JSON.stringify(pet
    ? { type: 'desktop-pet.self', origin: 'external', ts, text, cursor, meta: { kind: 'say' } }
    : { type: 'desktop-pet.message', origin: 'external', ts, text, cursor, meta: { text } })}\n`);
}

const ANSWER = JSON.stringify({ episodes: [{
  title: '开题报告的实验部分', summary: '他说开题报告还差实验部分,打算今晚补上。', importance: 4, from: 1, to: 3,
  items: [{ kind: 'plan', subject: '开题', text: '今晚补开题报告的实验部分', when: '2026-10-20', lines: [1, 3] }],
}] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cons-'));
  say(dir, 1, '2026-10-20T09:00:00+08:00', '开题报告还差实验部分');
  say(dir, 2, '2026-10-20T09:01:00+08:00', '那先把实验设计列出来？', true);
  say(dir, 3, '2026-10-20T09:02:00+08:00', '好，今晚弄');
  say(dir, 4, '2026-10-20T15:00:00+08:00', '嗯');
  const memory = new EventMemory(dir);
  memory.sync();
  const asked: string[] = [];
  const judgments = new Judgments(join(dir, 'judgments'));
  const make = (answer = ANSWER, dailyCalls = 40) => new Consolidator({
    memory, cacheFile: join(dir, 'cache.jsonl'), judgments, judge: 'test-model', dailyCalls,
    ask: async (_system, user) => { asked.push(user); return answer; },
    now: () => new Date('2026-10-21T00:00:00+08:00'),
  });
  return { dir, memory, asked, judgments, make };
}

describe('Consolidator', () => {
  it('turns a closed block into cards that recall then shows, and passes over a block with too little talk', async () => {
    const { memory, asked, judgments, make } = setup();
    expect(await make().run()).toBe(2);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBe('1. [10-20 09:00] 他: 开题报告还差实验部分\n2. [10-20 09:01] 我: 那先把实验设计列出来？\n3. [10-20 09:02] 他: 好，今晚弄');
    const out = await memory.recallTool().handler({ query: '开题' }, {} as never);
    expect(out).toContain('[开题报告的实验部分] 他说开题报告还差实验部分,打算今晚补上。\n  plan: 今晚补开题报告的实验部分 (2026-10-20)');
    expect(judgments.cases('episode-cards')).toHaveLength(1);
    // the card's own words find the block even when the lines do not
    expect(memory.search('实验设计')[0]!.episodes.map((e) => e.title)).toEqual(['开题报告的实验部分']);
    expect(await make().run()).toBe(0);
  });

  it('rebuilds the same cards from the cache without asking again', async () => {
    const { memory, asked, make } = setup();
    await make().run();
    const before = JSON.stringify(memory.search('开题'));
    memory.rebuild();
    expect(await make().run()).toBe(2);
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(memory.search('开题'))).toBe(before);
  });

  it('marks a block failed on an answer that is not JSON, and stops at the daily budget', async () => {
    const bad = setup();
    expect(await bad.make('sorry, I cannot').run()).toBe(2);
    expect(bad.memory.search('开题')[0]!.episodes).toEqual([]);
    const capped = setup();
    expect(await capped.make(ANSWER, 0).run()).toBe(0);
    expect(capped.asked).toEqual([]);
  });

  it('does not touch a block that is still going', async () => {
    const { dir, memory, asked } = setup();
    const c = new Consolidator({ memory, cacheFile: join(dir, 'c.jsonl'), ask: async (_s, u) => { asked.push(u); return ANSWER; }, now: () => new Date('2026-10-20T15:10:00+08:00') });
    expect(await c.run()).toBe(1);
    expect(asked).toHaveLength(1);
  });
});

describe('parseCards', () => {
  it('clamps line numbers to the block, defaults bad kinds and drops empty cards', () => {
    const { cards, complete } = parseCards('Here you go: {"episodes":[{"title":"a","summary":"b","importance":9,"from":0,"to":99,"items":[{"kind":"x","text":"t","lines":[50]}]},{"title":"","summary":"x"}]}', 3);
    expect(complete).toBe(true);
    expect(cards).toEqual([{ title: 'a', summary: 'b', importance: 5, from: 1, to: 3, items: [{ kind: 'fact', subject: '', text: 't', when: null, lines: [3] }] }]);
  });

  it('numbers lines with stamps and marks touches', () => {
    expect(promptOf([{ run: 'r', cursor: 1, ts: '2026-10-20T09:00:00+08:00', who: 'person', kind: 'touch', text: '戳了你一下' }]))
      .toBe('1. [10-20 09:00] 他(动作): 戳了你一下');
  });
});

describe('a cut-off answer', () => {
  it('keeps the episodes that were complete before the cut', () => {
    const cut = '{"episodes":[{"title":"甲","summary":"一","importance":2,"from":1,"to":2,"items":[{"kind":"fact","text":"含}括号{的\\"字","lines":[1]}]},{"title":"乙","summary":"写到一半';
    const parsed = parseCards(cut, 3);
    expect(parsed.complete).toBe(false);
    expect(parsed.cards.map((c) => [c.title, c.items[0]?.text])).toEqual([['甲', '含}括号{的"字']]);
    expect(() => parseCards('{"episodes":[{"title":"写到一半', 3)).toThrow();
  });
});

describe('a block whose answer is cut off', () => {
  it('goes on from the line after the last complete card until the block is covered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cons-'));
    for (let i = 1; i <= 6; i++) say(dir, i, `2026-10-20T09:0${i}:00+08:00`, `第${i}句话`);
    const memory = new EventMemory(dir);
    memory.sync();
    const asked: string[] = [];
    const answers = [
      '{"episodes":[{"title":"前半","summary":"一到三","importance":2,"from":1,"to":3,"items":[]},{"title":"被截","summary":"写到',
      '{"episodes":[{"title":"后半","summary":"四到六","importance":3,"from":4,"to":6,"items":[]}]}',
    ];
    const c = new Consolidator({ memory, cacheFile: join(dir, 'c.jsonl'), ask: async (_s, u) => { asked.push(u); return answers[asked.length - 1]!; },
      now: () => new Date('2026-10-21T00:00:00+08:00') });
    expect(await c.run()).toBe(1);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.split('\n')[0]).toBe('(Lines before 4 are already done; cover the lines below.)');
    expect(asked[1]).toContain('4. [10-20 09:04] 他: 第4句话');
    expect(memory.search('第')[0]!.episodes.length + memory.episodes(1).length).toBeGreaterThan(0);
    expect(memory.episodes(1).map((e) => e.title)).toEqual(['前半', '后半']);
  });
});
