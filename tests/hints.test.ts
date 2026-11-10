import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventMemory } from '../core/memory/events.ts';
import { Hints } from '../core/memory/hints.ts';
import { RecallScore } from '../core/memory/recall-score.ts';
import { Judgments } from '../core/learning/judgments.ts';

const NOW = Date.parse('2026-10-27T10:00:00.000+08:00');

function setup(lines: Array<[string, string]>) {
  const dir = mkdtempSync(join(tmpdir(), 'hints-'));
  mkdirSync(join(dir, 'runs', 'r1'), { recursive: true });
  lines.forEach(([ts, text], i) => appendFileSync(join(dir, 'runs', 'r1', 'events.jsonl'),
    `${JSON.stringify({ type: 'desktop-pet.message', origin: 'external', ts, text, cursor: i + 1, run: 'r1', meta: { text } })}\n`));
  const memory = new EventMemory(dir);
  const judgments = new Judgments(join(dir, 'judgments'));
  memory.scorer = new RecallScore(dir, judgments, () => NOW);
  memory.sync();
  return { dir, memory, judgments, hints: new Hints(memory, () => NOW) };
}

describe('what comes to mind on its own', () => {
  it('brings up earlier talk that clearly bears on what is said, and records the search', () => {
    const { memory, judgments, hints } = setup([
      ['2026-10-24T15:00:00.000+08:00', '下午三点提醒我喝水，每天八杯'],
      ['2026-10-25T20:00:00.000+08:00', '周末想去香山爬山'],
    ]);
    const out = hints.for('今天喝水了吗，八杯好难');
    expect(out).toContain('comes to mind');
    expect(out).toContain('八杯');
    expect(out).not.toContain('香山');
    expect(judgments.cases('recall').at(-1)).toMatchObject({ input: { source: 'hint@0' } });
    memory.close();
  });

  it('brings nothing for a word or two, for loose matches, or for the talk going on now', () => {
    const { memory, hints } = setup([
      ['2026-10-24T15:00:00.000+08:00', '下午三点提醒我喝水，每天八杯'],
      ['2026-10-27T09:50:00.000+08:00', '刚才说到猫咖和阿珍'],
    ]);
    expect(hints.for('嗯好')).toBeNull();
    // one term of five is not enough
    expect(hints.for('今天公司开会讨论预算喝水')).toBeNull();
    // ten minutes ago is the conversation itself
    expect(hints.for('猫咖 阿珍')).toBeNull();
    memory.close();
  });

  it('does not bring the same thing up again soon', () => {
    const { memory, hints } = setup([['2026-10-24T15:00:00.000+08:00', '下午三点提醒我喝水，每天八杯']]);
    expect(hints.for('喝水 八杯')).not.toBeNull();
    expect(hints.for('喝水 八杯')).toBeNull();
    memory.close();
  });
});

describe('recalling harder: association, then digging', () => {
  it('tries association when the words speak of the past and a direct match is too weak', () => {
    const { memory, hints } = setup([
      ['2026-10-20T10:00:00.000+08:00', '阿珍说周末一起去猫咖'],
      ['2026-10-21T10:00:00.000+08:00', '猫咖那只橘猫叫团子，超胖'],
    ]);
    // asked about the past: it comes to mind, by direct match or by association
    const out = hints.for('还记得团子那天穿的毛衣颜色和发型吗');
    expect(out).toContain('团子');
    expect(hints.recall.strength('还记得团子吗')).toBe(1);
    expect(hints.recall.strength('团子好胖')).toBe(0);
    memory.close();
  });

  it('digs with cues from the model in the background when nothing else is found, and says it later', async () => {
    const dir = (await import('node:fs')).mkdtempSync(join(tmpdir(), 'hints-dig-'));
    mkdirSync(join(dir, 'runs', 'r1'), { recursive: true });
    appendFileSync(join(dir, 'runs', 'r1', 'events.jsonl'), `${JSON.stringify({ type: 'desktop-pet.message', origin: 'external', ts: '2026-10-22T10:00:00.000+08:00', text: '给妈妈订了蛋糕，周五生日', cursor: 1, run: 'r1', meta: { text: '给妈妈订了蛋糕，周五生日' } })}\n`);
    const memory = new EventMemory(dir);
    memory.scorer = new RecallScore(dir, null, () => NOW);
    memory.sync();
    const late: string[] = [];
    const asked: string[] = [];
    const hints = new Hints(memory, { now: () => NOW, expand: async (said) => { asked.push(said); return ['妈妈', '生日', '蛋糕']; }, late: (t) => late.push(t) });
    expect(hints.for('上次说的那个庆祝安排好了吗')).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1);
    expect(late[0]).toContain('just came to mind');
    expect(late[0]).toContain('蛋糕');
    memory.close();
  });
});
