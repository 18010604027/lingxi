import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventMemory } from '../core/memory/events.ts';
import { COOCCUR_STEP, CORECALL_STEP, DECAY, MemoryGraph, NEXT_WEIGHT, PRUNE, type CardIn } from '../core/memory/graph.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'graph-'));
const at = '2026-10-27T10:00:00.000+08:00';

function line(g: MemoryGraph, id: number, block: number, who: 'person' | 'pet', text = `line ${id}`) {
  return g.addLine({ id, block, who, kind: who === 'person' ? 'said' : 'say', text, ts: at });
}

describe('relation graph', () => {
  it('links a line to the one before it in the same block, not across blocks', () => {
    const g = new MemoryGraph(dir());
    const a = line(g, 1, 1, 'person'), b = line(g, 2, 1, 'pet'), c = line(g, 3, 2, 'person');
    expect(g.weight(a, b, 'next')).toBeCloseTo(NEXT_WEIGHT);
    expect(g.weight(b, c, 'next')).toBe(0);
    expect(line(g, 2, 1, 'pet')).toBe(b);
    expect(g.counts().nodes).toBe(3);
  });

  it('moves the clock on the person’s turns only', () => {
    const g = new MemoryGraph(dir());
    line(g, 1, 1, 'person'); line(g, 2, 1, 'pet'); line(g, 3, 1, 'person');
    expect(g.ticks).toBe(2);
  });

  it('fades associative relations with interaction, and leaves structural ones', () => {
    const g = new MemoryGraph(dir());
    const x = g.node('fact', 'f:1', '喜欢猫', at), y = g.node('entity', 'e:猫', '猫', at), z = g.node('fact', 'f:2', '养了一只猫', at);
    g.link(x, y, 'mentions', 1);
    g.link(x, z, 'corecall', 0.5);
    for (let i = 0; i < 100; i++) g.tick();
    expect(g.weight(x, y, 'mentions')).toBe(1);
    expect(g.weight(x, z, 'corecall')).toBeCloseTo(0.5 * DECAY ** 100);
  });

  it('does not fade while nobody talks: days alone do nothing', () => {
    const g = new MemoryGraph(dir());
    const x = g.node('fact', 'f:1', 'a', at), y = g.node('fact', 'f:2', 'b', at);
    g.link(x, y, 'similar', 0.3);
    expect(g.weight(x, y, 'similar')).toBeCloseTo(0.3);
  });

  it('brings things recalled together closer, from their faded strength, capped at 1', () => {
    const g = new MemoryGraph(dir());
    const ids = ['a', 'b', 'c'].map((r) => g.node('fact', r, r, at));
    g.coRecalled(ids);
    expect(g.weight(ids[0]!, ids[2]!, 'corecall')).toBeCloseTo(CORECALL_STEP);
    for (let i = 0; i < 10; i++) g.tick();
    g.coRecalled([ids[0]!, ids[2]!]);
    expect(g.weight(ids[0]!, ids[2]!, 'corecall')).toBeCloseTo(CORECALL_STEP * DECAY ** 10 + CORECALL_STEP);
    g.link(ids[0]!, ids[1]!, 'corecall', 5);
    expect(g.weight(ids[0]!, ids[1]!, 'corecall')).toBe(1);
  });

  it('sweeps away relations faded under the floor but keeps the nodes', () => {
    const g = new MemoryGraph(dir());
    const x = g.node('fact', 'a', 'a', at), y = g.node('fact', 'b', 'b', at), z = g.node('entity', 'c', 'c', at);
    g.link(x, y, 'corecall', 0.02);
    g.link(x, z, 'source', 1);
    const ticks = Math.ceil(Math.log(PRUNE / 0.02) / Math.log(DECAY)) + 1;
    for (let i = 0; i < ticks; i++) g.tick();
    expect(g.neighbors(x).map((n) => n.kind)).toEqual(['source']);
    expect(g.sweep()).toBe(1);
    expect(g.counts()).toEqual({ nodes: 3, edges: 1 });
    expect(g.strength(x)).toBe(1);
  });
});

describe('event memory feeding the graph', () => {
  it('hands every new line to the graph, and the graph catches up on lines stored before it', () => {
    const data = dir();
    mkdirSync(join(data, 'runs', 'r1'), { recursive: true });
    const file = join(data, 'runs', 'r1', 'events.jsonl');
    const said = (cursor: number, text: string) => appendFileSync(file, JSON.stringify({ cursor, type: 'desktop-pet.message', origin: 'external', ts: at, text, meta: { text } }) + '\n');
    said(1, '周末去猫咖');
    const mem = new EventMemory(data);
    mem.sync();
    const g = new MemoryGraph(data);
    for (const l of mem.linesAfter(g.fedLine)) g.addLine(l);
    mem.onLine = (l) => g.addLine(l);
    said(2, '顺便给妈妈买礼物');
    mem.sync();
    const first = g.nodeByRef('line:1')!, second = g.nodeByRef('line:2')!;
    expect(first.text).toBe('周末去猫咖');
    expect(g.weight(first.id, second.id, 'next')).toBeCloseTo(NEXT_WEIGHT);
    expect(g.fedLine).toBe(2);
    expect(mem.linesAfter(g.fedLine)).toEqual([]);
  });
});

describe('cards in the graph', () => {
  const card = (id: number, items: CardIn['items']): CardIn => ({ id, block: 1, title: '妈妈生日', summary: '他想给妈妈买生日礼物。', importance: 4, fromLine: 1, toLine: 3, start: at, items });

  it('makes a summary, facts and entities, tied to their lines, and lets entities of one card co-occur', () => {
    const g = new MemoryGraph(dir());
    const lines = [1, 2, 3].map((n) => line(g, n, 1, n === 2 ? 'pet' : 'person'));
    const s = g.addCard(card(7, [
      { kind: 'plan', subject: '妈妈', text: '他打算周末给妈妈买礼物', when: '2026-11-01', lines: [1] },
      { kind: 'fact', subject: '猫咖', text: '他想去猫咖', when: null, lines: [3] },
    ]));
    expect(g.getNode(s)).toMatchObject({ kind: 'summary', importance: 4 });
    for (const p of lines) expect(g.weight(s, p, 'source')).toBe(1);
    const plan = g.nodeByRef('card:7:item:0')!, mom = g.nodeByRef('entity:妈妈')!, cafe = g.nodeByRef('entity:猫咖')!;
    expect(plan.text).toBe('他打算周末给妈妈买礼物（2026-11-01）');
    expect(g.weight(plan.id, lines[0]!, 'source')).toBe(1);
    expect(g.weight(plan.id, s, 'source')).toBe(1);
    expect(g.weight(plan.id, mom.id, 'mentions')).toBe(1);
    expect(g.weight(s, cafe.id, 'mentions')).toBe(1);
    expect(g.weight(mom.id, cafe.id, 'cooccur')).toBeCloseTo(COOCCUR_STEP);
    expect(g.addCard(card(7, []))).toBe(s);
    expect(g.fedCard).toBe(7);
  });

  it('shares an entity across cards, and drops a card made again without dropping its entities', () => {
    const g = new MemoryGraph(dir());
    g.addCard(card(1, [{ kind: 'fact', subject: '妈妈', text: 'a', when: null, lines: [] }]));
    g.addCard(card(2, [{ kind: 'fact', subject: '妈妈', text: 'b', when: null, lines: [] }]));
    const mom = g.nodeByRef('entity:妈妈')!;
    expect(g.neighbors(mom.id).filter((n) => n.kind === 'mentions')).toHaveLength(4);
    g.dropCard(1);
    expect(g.nodeByRef('card:1')).toBeNull();
    expect(g.nodeByRef('card:1:item:0')).toBeNull();
    expect(g.nodeByRef('card:2:item:0')).not.toBeNull();
    expect(g.neighbors(mom.id).filter((n) => n.kind === 'mentions')).toHaveLength(2);
  });

  it('gets cards from the event memory as they are stored and as they are dropped', () => {
    const data = dir();
    mkdirSync(join(data, 'runs', 'r1'), { recursive: true });
    const file = join(data, 'runs', 'r1', 'events.jsonl');
    ['周末想给妈妈买礼物', '买什么好呢'].forEach((text, i) => appendFileSync(file, JSON.stringify({ cursor: i + 1, type: 'desktop-pet.message', origin: 'external', ts: at, text, meta: { text } }) + '\n'));
    const mem = new EventMemory(data);
    const g = new MemoryGraph(data);
    mem.onLine = (l) => g.addLine(l);
    mem.onCard = (c) => g.addCard(c);
    mem.onCardDropped = (id) => g.dropCard(id);
    mem.sync();
    const lineRefs = mem.blockLines(1);
    mem.putCards(1, [{ title: '妈妈生日', summary: 's', importance: 3, from: 1, to: 2, lineRefs,
      items: [{ kind: 'plan', subject: '妈妈', text: '买礼物', when: null, lines: [1] }] }], 'done', 'old@1');
    const fact = g.nodeByRef('card:1:item:0')!;
    expect(g.weight(fact.id, g.nodeByRef('line:1')!.id, 'source')).toBe(1);
    mem.forgetOtherVersions('new@2');
    expect(g.nodeByRef('card:1')).toBeNull();
    expect(g.nodeByRef('entity:妈妈')).not.toBeNull();
  });
});
