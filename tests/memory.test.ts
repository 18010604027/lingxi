import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventMemory, lineOf } from '../core/memory/events.ts';
import { matchQuery, terms } from '../core/memory/terms.ts';
import { Judgments } from '../core/learning/judgments.ts';

describe('search terms', () => {
  it('keeps two-character words and new names that a trigram index would miss', () => {
    const t = terms('周末想和阿珍去猫咖，顺便给妈妈买生日礼物');
    for (const w of ['猫咖', '阿珍', '生日', '妈妈']) expect(t).toContain(w);
  });

  it('matches any term, so a pair that never occurs does not sink the query', () => {
    expect(matchQuery('妈妈生日')).toContain(' OR ');
    expect(matchQuery('  ，。 ')).toBeNull();
  });
});

describe('lines from the event log', () => {
  const at = '2026-10-26T10:16:18.445+08:00';
  it('keeps what the person said, answered and touched, and what the pet said', () => {
    expect(lineOf({ type: 'desktop-pet.message', origin: 'external', ts: at, text: '[10:16] [typed] 哥:你可以定时提醒我喝水', meta: { text: '你可以定时提醒我喝水' } }))
      .toEqual({ ts: at, who: 'person', kind: 'said', text: '你可以定时提醒我喝水' });
    expect(lineOf({ type: 'desktop-pet.touch', origin: 'external', ts: at, text: '[10-26 周一 10:14] [touch] 哥把你拎起来甩了出去' }))
      .toMatchObject({ who: 'person', kind: 'touch', text: '哥把你拎起来甩了出去' });
    expect(lineOf({ type: 'desktop-pet.self', origin: 'external', ts: at, text: '好呀，库...', meta: { kind: 'say' } }))
      .toMatchObject({ who: 'pet', kind: 'say', text: '好呀，库...' });
  });

  it('leaves out notices, the pet’s tool activity and its look', () => {
    expect(lineOf({ type: 'notice', origin: 'internal', ts: at, text: '[system] 3 new events.' })).toBeNull();
    expect(lineOf({ type: 'desktop-pet.self', origin: 'external', ts: at, text: '做了:read_file', meta: { kind: 'activity' } })).toBeNull();
    expect(lineOf({ type: 'desktop-pet.figure', origin: 'external', ts: at, text: '[figure] 你现在的样子' })).toBeNull();
  });

  it('reads older pet messages without including the feeling prefix', () => {
    expect(lineOf({ type: 'pet.message', origin: 'external', ts: at, text: '[10:16] [how you feel] rested\n[typed] 小王:周末去猫咖' }))
      .toMatchObject({ who: 'person', kind: 'said', text: '周末去猫咖' });
  });
});

function log(dataDir: string, run: string, events: Array<[number, string, string, Record<string, unknown>?]>) {
  mkdirSync(join(dataDir, 'runs', run), { recursive: true });
  for (const [cursor, ts, text, meta] of events) {
    appendFileSync(join(dataDir, 'runs', run, 'events.jsonl'), `${JSON.stringify({
      type: meta ? 'desktop-pet.self' : 'desktop-pet.message', origin: 'external', ts, text, cursor, run, meta: meta ?? { text },
    })}\n`);
  }
}

describe('EventMemory', () => {
  it('cuts blocks at silences and returns a hit with the lines around it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    log(dir, 'r1', [
      [1, '2026-10-20T09:00:00+08:00', '开题报告还差实验部分'],
      [2, '2026-10-20T09:01:00+08:00', '那先把实验设计列出来？', { kind: 'say' }],
      [3, '2026-10-20T09:02:00+08:00', '好，今晚弄'],
      [4, '2026-10-20T15:00:00+08:00', '下午去打球'],
    ]);
    log(dir, 'r2', [
      [5, '2026-10-26T10:00:00+08:00', '导师让开题补一个对比实验'],
    ]);
    const m = new EventMemory(dir);
    expect(m.sync()).toBe(5);
    const found = m.search('开题实验');
    expect(found).toHaveLength(2);
    const old = found.find((b) => b.start.startsWith('2026-10-20'))!;
    expect(old.lines.map((l) => [l.who, l.text, l.hit])).toEqual([
      ['person', '开题报告还差实验部分', true],
      ['pet', '那先把实验设计列出来？', true],
      ['person', '好，今晚弄', false],
    ]);
    expect(m.search('打球')[0]!.lines.map((l) => l.text)).toEqual(['下午去打球']);
    m.close();
  });

  it('reads only what the log gained since, and rebuilds the same from scratch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    log(dir, 'r1', [[1, '2026-10-20T09:00:00+08:00', '喝水']]);
    const m = new EventMemory(dir);
    expect(m.sync()).toBe(1);
    expect(m.sync()).toBe(0);
    log(dir, 'r1', [[2, '2026-10-20T09:05:00+08:00', '再喝一口水']]);
    expect(m.sync()).toBe(1);
    const before = JSON.stringify(m.search('喝水'));
    expect(m.rebuild()).toBe(2);
    expect(JSON.stringify(m.search('喝水'))).toBe(before);
    m.close();
  });

  it('answers recall with stamped lines, the hits marked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-'));
    log(dir, 'r1', [[1, '2026-10-20T09:00:00+08:00', '周末去猫咖'], [2, '2026-10-20T09:01:00+08:00', '带上阿珍吗', { kind: 'say' }]]);
    const m = new EventMemory(dir);
    expect(await m.recallTool().handler({ query: '猫咖' }, {} as never)).toBe(
      '— 10-20 09:00 to 10-20 09:01\n» 09:00 person: 周末去猫咖\n  09:01 you: 带上阿珍吗');
    expect(await m.recallTool().handler({ query: '火星' }, {} as never)).toBe('[none] nothing found');
    m.close();
  });
});

describe('Judgments', () => {
  it('keeps each judgment with its latest label and counts agreement per judge', () => {
    const j = new Judgments(mkdtempSync(join(tmpdir(), 'judg-')));
    const a = j.record({ kind: 'thread-link', judge: 'deepseek-flash', input: { a: 'ep1', b: 'ep2' }, output: { same: true }, confidence: 0.7 });
    const b = j.record({ kind: 'thread-link', judge: 'deepseek-flash', input: { a: 'ep3', b: 'ep4' }, output: { same: true }, confidence: 0.9 });
    j.record({ kind: 'thread-link', judge: 'rule:sim@1', input: {}, output: { same: false } });
    j.label('thread-link', a, { label: { same: true }, agrees: true, source: 'person' });
    j.label('thread-link', b, { label: { same: true }, agrees: true, source: 'person' });
    j.label('thread-link', b, { label: { same: false }, agrees: false, source: 'later', note: 'split later' });
    const cases = j.cases('thread-link');
    expect(cases).toHaveLength(3);
    expect(cases.find((c) => c.id === b)!.latest).toMatchObject({ agrees: false, source: 'later' });
    expect(j.agreement('thread-link')).toEqual({ labelled: 2, agreed: 1, byJudge: { 'deepseek-flash': { labelled: 2, agreed: 1 } } });
  });

  it('refuses a kind that is not a plain file name', () => {
    const j = new Judgments(mkdtempSync(join(tmpdir(), 'judg-')));
    expect(() => j.record({ kind: '../x', judge: 'p', input: 0, output: 0 })).toThrow(/kebab-case/);
  });
});

describe('recall ranked by the formula, with the record', () => {
  it('ranks the block that covers the query first and writes the search and what was shown to the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-score-'));
    log(dir, 'r1', [
      [1, '2026-10-20T10:00:00.000+08:00', '喝水喝水喝水，今天喝水了吗'],
      [2, '2026-10-24T10:00:00.000+08:00', '下午三点提醒我喝水，每天八杯'],
    ]);
    const { RecallScore } = await import('../core/memory/recall-score.ts');
    const judgments = new Judgments(join(dir, 'judgments'));
    const memory = new EventMemory(dir);
    memory.scorer = new RecallScore(dir, judgments);
    memory.sync();
    const out = String(await memory.recallTool().handler({ query: '提醒喝水 八杯' }, {} as never));
    expect(out.indexOf('八杯')).toBeGreaterThan(-1);
    const recorded = judgments.cases('recall');
    expect(recorded).toHaveLength(1);
    expect((recorded[0]!.input as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
    memory.close();
  });
});
