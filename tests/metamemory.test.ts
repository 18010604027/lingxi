import { describe, expect, it } from 'vitest';
import { assessMetaMemory, METAMEMORY_THRESHOLDS, type MetaMemoryInput } from '../core/memory/metamemory.ts';

const features = (over: Partial<MetaMemoryInput['candidates'][number]['features']> = {}) => ({
  coverage: 0, lineMatch: 0, cardMatch: 0, hitLines: 0, hitCards: 0, ageDays: 0, importance: 0, activation: 0, usedBefore: 0, ...over,
});
const input = (over: Partial<MetaMemoryInput> = {}): MetaMemoryInput => ({
  candidates: [{ block: 1, score: 4, features: features() }], cards: 0, sources: 0, timespanDays: null, ...over,
});

describe('metamemory', () => {
  it('returns unsupported when retrieval has no candidate', () => {
    const r = assessMetaMemory(input({ candidates: [] }));
    expect(r.state).toBe('unsupported');
    expect(r.hint).toContain('no basis');
  });

  it('returns remembered only when every clear-evidence boundary is met', () => {
    const r = assessMetaMemory(input({
      cards: METAMEMORY_THRESHOLDS.rememberedCards,
      sources: METAMEMORY_THRESHOLDS.rememberedSources,
      candidates: [{ block: 1, score: 8, features: features({ coverage: METAMEMORY_THRESHOLDS.rememberedCoverage, lineMatch: METAMEMORY_THRESHOLDS.rememberedMatch }) }],
    }));
    expect(r.state).toBe('remembered');
  });

  it('returns impression at its lower boundary and keeps the hint tentative', () => {
    const r = assessMetaMemory(input({
      cards: METAMEMORY_THRESHOLDS.impressionCards,
      sources: METAMEMORY_THRESHOLDS.impressionSources,
      candidates: [{ block: 1, score: 2, features: features({ coverage: METAMEMORY_THRESHOLDS.impressionCoverage, lineMatch: METAMEMORY_THRESHOLDS.impressionMatch }) }],
    }));
    expect(r.state).toBe('impression');
    expect(r.hint).toContain('impression');
  });

  it('returns possible when a weak candidate exists without enough support', () => {
    const r = assessMetaMemory(input({ cards: 0, sources: 1, candidates: [{ block: 1, score: 9, features: features({ coverage: 0.9 }) }] }));
    expect(r.state).toBe('possible');
    expect(r.hint).toContain('did not find enough');
  });

  it('does not let an inflated score bypass evidence boundaries', () => {
    const r = assessMetaMemory(input({ candidates: [{ block: 1, score: Number.MAX_VALUE, features: features({ coverage: 0.01, lineMatch: 0, cardMatch: 0 }) }], cards: 4, sources: 4 }));
    expect(r.state).toBe('possible');
  });
});
