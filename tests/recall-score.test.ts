import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Judgments } from '../core/learning/judgments.ts';
import { RecallScore, type Features } from '../core/memory/recall-score.ts';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-26T12:00:00Z');
const open = (now = () => T0) => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-'));
  const judgments = new Judgments(join(dir, 'judgments'));
  return { dir, judgments, score: new RecallScore(dir, judgments, now) };
};
const f = (o: Partial<Features>): Features => ({ coverage: 0, lineMatch: 0, cardMatch: 0, hitLines: 0, hitCards: 0, ageDays: 0, importance: 0, activation: 0, usedBefore: 0, ...o });
const rows = (dir: string) => readFileSync(join(dir, 'judgments', 'recall.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('accessibility (ACT-R base level)', () => {
  it('fades with time and rises with each use', () => {
    let now = T0;
    const { score } = open(() => now);
    const happened = T0 - DAY;
    const fresh = score.activation(1, happened).activation;
    now = T0 + 30 * DAY;
    const old = score.activation(1, happened).activation;
    expect(old).toBeLessThan(fresh);
    // used now (a reply drew on it): more accessible than the same block left alone
    score.recorded('喝水', 'test', [{ block: 1, features: f({}) }], [{ block: 1, text: '提醒喝水 每天八杯 喝水提醒' }]);
    score.onPetSaid('你之前说每天要喝八杯水，喝水提醒我记着呢');
    const after = score.activation(1, happened);
    expect(after.usedBefore).toBe(1);
    expect(after.activation).toBeGreaterThan(old);
  });
});

describe('the formula', () => {
  it('covering more of the query beats one word matched many times', () => {
    const { score } = open();
    const ranked = score.rank([
      { block: 1, features: f({ coverage: 1 / 3, lineMatch: 9, hitLines: 6 }) },
      { block: 2, features: f({ coverage: 1, lineMatch: 5, hitLines: 2 }) },
    ]);
    expect(ranked[0]!.block).toBe(2);
  });

  it('between equal matches, the more accessible and the more important come first', () => {
    const { score } = open();
    const same = { coverage: 1, lineMatch: 4 };
    expect(score.rank([{ block: 1, features: f({ ...same, activation: -1 }) }, { block: 2, features: f({ ...same, activation: 1 }) }])[0]!.block).toBe(2);
    expect(score.rank([{ block: 1, features: f({ ...same, importance: 2 }) }, { block: 2, features: f({ ...same, importance: 9 }) }])[0]!.block).toBe(2);
  });

  it('a strong match is not buried by accessibility alone', () => {
    const { score } = open();
    const ranked = score.rank([
      { block: 1, features: f({ coverage: 0.2, lineMatch: 1, activation: 1.5 }) },
      { block: 2, features: f({ coverage: 1, lineMatch: 8, activation: -1.5 }) },
    ]);
    expect(ranked[0]!.block).toBe(2);
  });

  it('takes its constants from data/recall-weights.json when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recall-'));
    writeFileSync(join(dir, 'recall-weights.json'), JSON.stringify({ base: 0 }));
    const score = new RecallScore(dir, null, () => T0);
    const same = { coverage: 1, lineMatch: 4 };
    const ranked = score.rank([{ block: 1, features: f({ ...same, activation: -3 }) }, { block: 2, features: f({ ...same, activation: 3 }) }]);
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score);
  });
});

describe('the record and its labels', () => {
  it('a reply drawing on what was shown labels it used; the person correcting it labels it wrong', () => {
    const { dir, score } = open();
    score.recorded('喝水', 'recall-tool', [{ block: 1, features: f({ coverage: 1 }) }, { block: 2, features: f({}) }],
      [{ block: 1, text: '每天八杯水 喝水提醒 下午三点' }, { block: 2, text: '周末去爬山 天气不错' }]);
    score.onPetSaid('记得呀，下午三点提醒你喝水，每天八杯');
    score.onPersonSaid('不对，是四点');
    const r = rows(dir);
    expect(r[0]).toMatchObject({ type: 'judgment', kind: 'recall', output: { shown: [1, 2] } });
    expect(r[0].input.candidates).toHaveLength(2);
    expect(r[1]).toMatchObject({ type: 'label', label: { used: [1], notUsed: [2] }, agrees: true, source: 'rule' });
    expect(r[2]).toMatchObject({ type: 'label', label: { corrected: true }, agrees: false, source: 'person' });
  });

  it('a confirmation labels it right', () => {
    const { dir, score } = open();
    score.recorded('爬山', 'recall-tool', [{ block: 2, features: f({}) }], [{ block: 2, text: '周末去爬山 天气不错 香山' }]);
    score.onPetSaid('上周末你去香山爬山了吧，天气不错');
    score.onPersonSaid('对，香山');
    expect(rows(dir).at(-1)).toMatchObject({ label: { confirmed: true }, agrees: true, source: 'person' });
  });

  it('a search nobody drew on is labelled unused after a while, and strengthens nothing', () => {
    let now = T0;
    const { dir, score } = open(() => now);
    score.recorded('喝水', 'recall-tool', [{ block: 1, features: f({}) }], [{ block: 1, text: '每天八杯水 喝水提醒' }]);
    now += 11 * 60_000;
    score.onPetSaid('今天天气真好');
    expect(rows(dir).at(-1)).toMatchObject({ type: 'label', label: { used: [] }, agrees: false, source: 'rule' });
    expect(score.activation(1, T0).usedBefore).toBe(0);
  });
});
