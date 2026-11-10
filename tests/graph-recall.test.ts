import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventMemory } from '../core/memory/events.ts';
import { MemoryGraph, type CardIn } from '../core/memory/graph.ts';
import { ASSOCIATED, DIRECT, GraphRecall, pageRank } from '../core/memory/graph-recall.ts';

const at = '2026-10-27T10:00:00.000+08:00';
const dir = () => mkdtempSync(join(tmpdir(), 'recall-'));
const card = (id: number, title: string, items: Array<[string, string]>): CardIn => ({
  id, block: id, title, summary: `${title}的经过`, importance: 3, fromLine: 0, toLine: -1, start: at,
  items: items.map(([subject, text]) => ({ kind: 'fact', subject, text, when: null, lines: [] })),
});

describe('personalized PageRank', () => {
  it('keeps most weight at the start and passes the rest along the stronger relation', async () => {
    const adj = new Map([[1, [{ id: 2, weight: 0.9 }, { id: 3, weight: 0.1 }]], [2, [{ id: 1, weight: 0.9 }]], [3, [{ id: 1, weight: 0.1 }]]]);
    const r = new Map(pageRank(new Map([[1, 1]]), adj));
    expect(r.get(1)!).toBeGreaterThan(r.get(2)!);
    expect(r.get(2)!).toBeGreaterThan(r.get(3)!);
  });
});

describe('recall through the graph', () => {
  it('finds a fact by its words and brings up, by association, a fact that shares no word with the query', async () => {
    const g = new MemoryGraph(dir());
    g.addCard(card(1, '妈妈生日', [['妈妈', '妈妈下周过生日'], ['蛋糕', '想订一个芒果蛋糕']]));
    const found = new GraphRecall(g).search('生日');
    const direct = found.filter((r) => r.via === 'direct').map((r) => r.node.text);
    const assoc = found.filter((r) => r.via === 'association').map((r) => r.node.text);
    expect(direct).toContain('妈妈下周过生日');
    expect(assoc).toContain('想订一个芒果蛋糕');
    expect(found.some((r) => r.node.kind === 'entity')).toBe(false);
  });

  it('never lets association push out a direct match, and lets a deeper dig add more', async () => {
    const g = new MemoryGraph(dir());
    for (let i = 1; i <= 12; i++) g.addCard(card(i, `猫咖第${i}次`, [['猫咖', `第${i}次去猫咖`], [`朋友${i}`, `和朋友${i}一起`]]));
    const r = new GraphRecall(g);
    const shallow = r.search('猫咖', 1);
    expect(shallow.filter((x) => x.via === 'direct')).toHaveLength(DIRECT);
    expect(shallow.filter((x) => x.via === 'association').length).toBeLessThanOrEqual(ASSOCIATED);
    expect(shallow.slice(0, DIRECT).every((x) => x.via === 'direct')).toBe(true);
    expect(r.search('猫咖', 3).length).toBeGreaterThan(shallow.length);
  });

  it('shows a line with the lines around it, the person and the pet told apart', async () => {
    const data = dir();
    mkdirSync(join(data, 'runs', 'r1'), { recursive: true });
    const file = join(data, 'runs', 'r1', 'events.jsonl');
    appendFileSync(file, JSON.stringify({ cursor: 1, type: 'desktop-pet.message', origin: 'external', ts: at, text: '周末想去猫咖', meta: { text: '周末想去猫咖' } }) + '\n');
    appendFileSync(file, JSON.stringify({ cursor: 2, type: 'desktop-pet.self', origin: 'external', ts: at, text: '好呀', meta: { kind: 'say' } }) + '\n');
    const mem = new EventMemory(data);
    const g = new MemoryGraph(data);
    mem.onLine = (l) => g.addLine(l);
    const out = await new GraphRecall(g, mem).recall('猫咖');
    expect(out).toContain('» 10-27 10:00 person: 周末想去猫咖');
    expect(out).toContain('you: 好呀');
  });

  it('says so when nothing matches', async () => {
    expect(await new GraphRecall(new MemoryGraph(dir())).recall('不存在的东西')).toBe('[none] nothing found');
  });
});

describe('only what is used is drawn closer', () => {
  const setup = () => {
    let now = Date.parse(at) + 86_400_000;
    const g = new MemoryGraph(dir());
    g.addCard(card(1, '妈妈生日', [['妈妈', '妈妈下周过生日'], ['蛋糕', '想订一个芒果蛋糕']]));
    const r = new GraphRecall(g, null, () => now);
    const birthday = g.nodeByRef('card:1:item:0')!.id, cake = g.nodeByRef('card:1:item:1')!.id;
    const cue = g.node('piece', 'line:99', '我妈生日快到了', at);
    return { g, r, birthday, cake, cue, later: (ms: number) => { now += ms; } };
  };
  const markOf = (out: string, text: string) => /#(m\d+)/.exec(out.split('\n').find((l) => l.includes(text))!)![1]!;

  it('marks what it shows, and showing alone draws nothing closer', async () => {
    const { g, r, birthday, cake } = setup();
    const out = await r.recall('生日');
    expect(out).toMatch(/#m\d+ \[fact /);
    expect(g.weight(birthday, cake, 'corecall')).toBe(0);
  });

  it('draws the used ones and what the person said closer, and again when the person carries on', async () => {
    const { g, r, birthday, cue } = setup();
    const out = await r.recall('生日');
    expect(r.used([`#${markOf(out, '妈妈下周过生日')}`, '#m999'], cue)).toEqual([birthday]);
    const once = g.weight(birthday, cue, 'corecall');
    expect(once).toBeGreaterThan(0);
    r.heard('对，她喜欢芒果');
    expect(g.weight(birthday, cue, 'corecall')).toBeGreaterThan(once);
  });

  it('does not strengthen again when the person wants the topic dropped, or comes back too late', async () => {
    const a = setup();
    a.r.used([markOf(await a.r.recall('生日'), '妈妈下周过生日')], a.cue);
    const once = a.g.weight(a.birthday, a.cue, 'corecall');
    a.r.heard('别提了，烦死');
    expect(a.g.weight(a.birthday, a.cue, 'corecall')).toBeCloseTo(once);
    const b = setup();
    b.r.used([markOf(await b.r.recall('生日'), '妈妈下周过生日')], b.cue);
    const before = b.g.weight(b.birthday, b.cue, 'corecall');
    b.later(10 * 60_000);
    b.r.heard('嗯嗯');
    expect(b.g.weight(b.birthday, b.cue, 'corecall')).toBeCloseTo(before);
  });

  it('lets a stale mark go unused', async () => {
    const { r, cue, later } = setup();
    const m = markOf(await r.recall('生日'), '妈妈下周过生日');
    later(11 * 60_000);
    expect(r.used([m], cue)).toEqual([]);
  });

  it('brings a direct match to mind on its own, with a mark, and not the same one again soon', async () => {
    const { r } = setup();
    const first = await r.comesToMind('妈妈生日送什么');
    expect(first).toContain('妈妈生日：');
    expect(first).toMatch(/#m\d+/);
    expect(first!.split('\n').length - 1).toBeLessThanOrEqual(2);
    expect((await r.comesToMind('妈妈生日送什么')) ?? '').not.toContain('妈妈生日：');
    expect(await r.comesToMind('嗯')).toBeNull();
  });
});
