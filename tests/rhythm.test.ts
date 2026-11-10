import { describe, expect, it } from 'vitest';
import { Rhythm, RHYTHM_DEFAULTS, type GlanceResult, type RhythmHooks } from '../core/rhythm.ts';
import { nextAfter } from '../core/daily/reminders.ts';
import { lineOf } from '../core/memory/events.ts';

const at = (h: number, m = 0) => new Date(2026, 9, 26, h, m);

function rhythm(over: Partial<RhythmHooks> & { glanced?: GlanceResult } = {}) {
  const woke: string[] = [], notes: string[] = [], counts: string[] = [];
  const r = new Rhythm({
    glance: async () => over.glanced ?? { jpeg: new Uint8Array([1]), foreground: 'paper.pdf - Acrobat', foregroundApp: 'Acrobat.exe', windows: [{ title: 'paper.pdf - Acrobat', foreground: true }, { title: 'VS Code', foreground: false }] },
    see: async () => '在看一篇关于日志异常检测的论文。',
    note: (t) => notes.push(t), wake: (t) => woke.push(t),
    topicsToday: () => ['设定每小时喝水提醒', '刷题疲劳与开题进度'], spokenToday: () => 2,
    count: (o) => counts.push(o), now: () => at(14, 32), random: () => 0.5,
    ...over,
  });
  return { r, woke, notes, counts };
}

describe('Rhythm', () => {
  it('looks up every 40–70 minutes inside its waking hours, and sleeps until a little after they start', () => {
    const s = RHYTHM_DEFAULTS.schedule;
    expect(nextAfter(s, at(14, 0), () => 0.5)).toEqual(at(14, 55));
    // 23:00 + 55 min runs past 23:30: next look tomorrow a little after 09:00
    expect(nextAfter(s, at(23, 0), () => 0.5)).toEqual(new Date(2026, 9, 27, 9, 10));
    expect(nextAfter(s, at(3, 0), () => 0.5)).toEqual(at(9, 10));
  });

  it('glances, keeps what it saw, and wakes the front with the moment', async () => {
    const { r, woke, notes, counts } = rhythm();
    expect(await r.beat()).toBe('woke');
    expect(notes).toEqual(['[glance 14:32] 在看一篇关于日志异常检测的论文。']);
    expect(woke[0]).toContain('On their screen: 在看一篇关于日志异常检测的论文。');
    expect(woke[0]).toContain('* paper.pdf - Acrobat\n- VS Code');
    expect(woke[0]).toContain('Talked about today: 设定每小时喝水提醒; 刷题疲劳与开题进度.');
    expect(woke[0]).toContain(`You have spoken on your own 2 times today; keep it to about ${RHYTHM_DEFAULTS.params.dailySpeaking} a day.`);
    expect(counts).toEqual(['woke']);
  });

  it('lets the moment pass when the screen is locked or nobody is there, without waking anyone', async () => {
    for (const away of ['locked', 'idle'] as const) {
      const { r, woke, counts } = rhythm({ glanced: { away, idleMs: 900_000 } });
      expect(await r.beat()).toBe(`away-${away}`);
      expect(woke).toEqual([]);
      expect(counts).toEqual([`away-${away}`]);
    }
  });

  it('sometimes does not look up at all, as often as its settings say', async () => {
    const { r, woke } = rhythm({ random: () => 0.1 });
    expect(await r.beat()).toBe('skipped');
    expect(await r.beat({ skipChance: 0, dailySpeaking: 3 })).toBe('woke');
    expect(woke[0]).toContain('keep it to about 3 a day');
  });

  it('still wakes the front when the picture cannot be read, with the window titles', async () => {
    const { r, woke, notes } = rhythm({ see: async () => { throw new Error('no vision'); } });
    expect(await r.beat()).toBe('woke');
    expect(notes).toEqual([]);
    expect(woke[0]).toContain('You could not see their screen this time.');
    expect(woke[0]).toContain('* paper.pdf - Acrobat');
  });
});

describe('a glance in the event log', () => {
  it('becomes a line of the pet’s own', () => {
    expect(lineOf({ type: 'glance', origin: 'internal', ts: '2026-10-26T14:32:00+08:00', text: '[glance 14:32] 在看论文。' }))
      .toEqual({ ts: '2026-10-26T14:32:00+08:00', who: 'pet', kind: 'glance', text: '在看论文。' });
  });
});
