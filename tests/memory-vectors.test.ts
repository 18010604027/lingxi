import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BertTokenizer, type Embedder } from '../core/memory/embed.ts';
import { MemoryGraph } from '../core/memory/graph.ts';
import { GraphRecall } from '../core/memory/graph-recall.ts';
import { MemoryVectors, SIMILAR } from '../core/memory/vectors.ts';

const at = '2026-10-20T10:00:00.000+08:00';
const dir = () => mkdtempSync(join(tmpdir(), 'vec-'));

/** A stand-in model: each text maps to a fixed direction, so likeness is set by hand. */
function fake(table: Record<string, number[]>): Embedder {
  const unit = (v: number[]) => { const n = Math.hypot(...v) || 1; return Float32Array.from(v.map((x) => x / n)); };
  return { embed: async (texts: string[]) => texts.map((t) => unit(table[t] ?? [0, 0, 0, 1])) } as unknown as Embedder;
}

describe('BERT tokenizer', () => {
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', '我', '妈', '生', '日', 'hel', '##lo', '!'].join('\n');
  it('splits Han characters, keeps punctuation apart, and pieces words', () => {
    const t = new BertTokenizer(vocab);
    expect(t.encode('我妈 生日 hello!')).toEqual([2, 4, 5, 6, 7, 8, 9, 10, 3]);
    expect(t.encode('猫')).toEqual([2, 1, 3]);
    expect(t.encode('我妈生日', 4)).toEqual([2, 4, 5, 3]);
  });
});

describe('vectors in the graph', () => {
  it('links a new node to the ones it is like, and same-named entities to each other', async () => {
    const g = new MemoryGraph(dir());
    const a = g.node('fact', 'f:a', '妈妈下周过生日', at);
    const b = g.node('fact', 'f:b', '妈妈的生日快到了', at);
    const c = g.node('fact', 'f:c', '他想去猫咖', at);
    const mom = g.node('entity', 'e:妈妈', '妈妈', at), mom2 = g.node('entity', 'e:我妈', '我妈', at);
    const v = new MemoryVectors(g, async () => fake({ 妈妈下周过生日: [1, 0.1, 0, 0], 妈妈的生日快到了: [1, 0.2, 0, 0], 他想去猫咖: [0, 1, 0, 0], 妈妈: [0, 0, 1, 0], 我妈: [0, 0, 1, 0.1] }));
    expect(await v.pass()).toBe(5);
    expect(g.weight(a, b, 'similar')).toBeGreaterThan(0.9 * SIMILAR.scale);
    expect(g.weight(a, c, 'similar')).toBe(0);
    expect(g.weight(mom, mom2, 'similar')).toBeGreaterThan(0.9);
    expect(g.weight(a, mom, 'similar')).toBe(0);
    expect(await v.pass()).toBe(0);
  });

  it('finds a starting point by meaning when the words do not match', async () => {
    const g = new MemoryGraph(dir());
    const cake = g.node('fact', 'f:cake', '想订一个芒果蛋糕', at);
    const e = fake({ 想订一个芒果蛋糕: [1, 0, 0, 0], 甜点: [0.95, 0.3, 0, 0] });
    const v = new MemoryVectors(g, async () => e, () => e);
    await v.pass();
    const r = new GraphRecall(g, null, Date.now, v);
    expect(r.search('甜点').map((x) => x.node.id)).toEqual([]);
    expect(r.search('甜点', 1, await v.query('甜点')).map((x) => x.node.id)).toEqual([cake]);
    expect(await r.recall('甜点')).toContain('芒果蛋糕');
  });

  it('gives no query vector while the model is not loaded, so a reply never waits on a download', async () => {
    const g = new MemoryGraph(dir());
    const v = new MemoryVectors(g, async () => { throw new Error('should not be fetched'); });
    expect(await v.query('甜点')).toBeNull();
  });
});
