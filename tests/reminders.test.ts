import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nextAfter, pickLine, ReminderEngine, ReminderStore, scheduleProblem, type Reminder } from '../core/daily/reminders.ts';
import { Ledger } from '../core/ledger/ledger.ts';

const local = (h: number, m = 0, day = 26) => new Date(2026, 9, day, h, m);

describe('schedules', () => {
  it('finds the next time inside the daily window, moving to the next day after it', () => {
    const hourly = { everyMinutes: 60, from: '09:00', to: '21:00' };
    expect(nextAfter(hourly, local(10, 15))).toEqual(local(11));
    expect(nextAfter(hourly, local(11))).toEqual(local(12));
    expect(nextAfter(hourly, local(21, 30))).toEqual(local(9, 0, 27));
    expect(nextAfter(hourly, local(6))).toEqual(local(9));
  });

  it('keeps set times and weekdays', () => {
    // 2026-10-26 is a Monday
    const s = { times: ['18:30', '08:00'], days: [1, 3] };
    expect(nextAfter(s, local(7))).toEqual(local(8));
    expect(nextAfter(s, local(19))).toEqual(local(8, 0, 28));
  });

  it('rejects schedules that cannot run', () => {
    expect(scheduleProblem({})).toMatch(/exactly one/);
    expect(scheduleProblem({ everyMinutes: 1 })).toMatch(/at least 5/);
    expect(scheduleProblem({ times: ['25:00'] })).toMatch(/not a time/);
    expect(scheduleProblem({ everyMinutes: 30, days: [7] })).toMatch(/days/);
    expect(scheduleProblem({ everyMinutes: 30 })).toBeNull();
  });
});

describe('picking a line', () => {
  it('never repeats one of the last few said', () => {
    const r = { lines: ['a', 'b', 'c', 'd'], recent: [0, 1, 2] };
    for (let k = 0; k < 20; k++) expect(pickLine(r, () => k / 20)).toBe(3);
  });

  it('can still pick when there are only two lines', () => {
    expect(pickLine({ lines: ['a', 'b'], recent: [0] }, () => 0.9)).toBe(1);
  });
});

function engine(opts: { engaged?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rem-'));
  let clock = local(10, 59);
  const said: string[] = [];
  const motions: string[] = [];
  const woken: Array<[string, string, string | null]> = [];
  const stale: string[] = [];
  const ledger = new Ledger(join(dir, 'ledger.sqlite'), { now: () => clock, flushMs: 60_000 });
  const e = new ReminderEngine(new ReminderStore(join(dir, 'rem.sqlite')), {
    say: async (l, m) => { said.push(l); motions.push(m); return true; },
    wakeFront: (r, why, suggestion) => woken.push([r.id, why, suggestion]),
    onStale: (r) => stale.push(r.id),
    engaged: () => opts.engaged ?? false,
    ledger, now: () => clock, random: () => 0,
  });
  return { e, said, motions, woken, stale, ledger, at: (d: Date) => { clock = d; } };
}

const water = { title: 'drink water', kind: 'simple' as const, schedule: { everyMinutes: 60, from: '09:00', to: '21:00' }, lines: ['喝口水吧', '该喝水啦', '水杯空了吗'], why: 'fixed and repetitive' };

describe('ReminderEngine', () => {
  it('says a simple reminder without the model and moves to its next time', async () => {
    const { e, said, woken, at, ledger } = engine();
    const r = e.create(water);
    expect(r.nextAt).toBe(local(11).toISOString());
    at(local(11, 0));
    await e.tick();
    await e.tick();
    expect(said).toEqual(['喝口水吧']);
    expect(woken).toEqual([]);
    expect(e.store.get(r.id)!.nextAt).toBe(local(12).toISOString());
    expect(ledger.tallies('0', '9')).toEqual([expect.objectContaining({ actor: `reminder:${r.id}`, outcome: 'said', n: 1 })]);
  });

  it('does the motion the reminder was set up with as it says it, a wave and a hop when it names none', async () => {
    const { e, motions, at } = engine();
    e.create(water);
    e.create({ ...water, title: 'stand up', motion: 'run 3s, spin' });
    at(local(11));
    await e.tick();
    expect(motions.sort()).toEqual(['run 3s, spin', 'wave, jump']);
  });

  it('hands even a simple reminder to the front, with its line as a suggestion, while the person is engaged', async () => {
    const { e, said, woken, at } = engine({ engaged: true });
    const r = e.create(water);
    at(local(11));
    await e.tick();
    expect(said).toEqual([]);
    expect(woken).toEqual([[r.id, 'engaged', '喝口水吧']]);
  });

  it('wakes the front for a smart reminder with its guide', async () => {
    const { e, woken, at } = engine();
    const r = e.create({ title: 'stretch', kind: 'smart', schedule: { times: ['11:00'] }, guide: 'if they have been coding for long, suggest a short stretch', why: 'depends on what they are doing' });
    at(local(11));
    await e.tick();
    expect(woken).toEqual([[r.id, 'smart', null]]);
  });

  it('skips a time that passed long ago instead of saying it late', async () => {
    const { e, said, at, ledger } = engine();
    const r = e.create(water);
    at(local(13, 10));
    await e.tick();
    expect(said).toEqual([]);
    expect(e.store.get(r.id)!.nextAt).toBe(local(14).toISOString());
    expect(ledger.tallies('0', '9')[0]).toMatchObject({ outcome: 'skipped-late' });
  });

  it('asks once for fresh lines when the old ones are worn, and resets when they arrive', async () => {
    const { e, said, stale, at } = engine();
    const r = e.create(water);
    for (let h = 11; h <= 17; h++) { at(local(h)); await e.tick(); }
    expect(said).toHaveLength(7);
    expect(new Set(said.slice(0, 3))).toEqual(new Set(water.lines));
    expect(stale).toEqual([r.id]);
    const fresh = e.update(r.id, { lines: ['多喝水哦', '润润嗓子', '起来接杯水', '喝水时间到'] });
    expect(fresh).toMatchObject({ usesSinceLines: 0, refreshAsked: false, recent: [] });
  });

  it('refuses a simple reminder with too few lines and a schedule that cannot run', () => {
    const { e } = engine();
    expect(() => e.create({ ...water, lines: ['只有一句'] })).toThrow(/at least 3 lines/);
    expect(() => e.create({ ...water, schedule: { everyMinutes: 2 } })).toThrow(/at least 5/);
  });

  it('stays quiet while paused and picks up from now when resumed', async () => {
    const { e, said, at } = engine();
    const r = e.create(water);
    e.update(r.id, { active: false });
    at(local(11));
    await e.tick();
    expect(said).toEqual([]);
    at(local(15, 20));
    expect(e.update(r.id, { active: true }).nextAt).toBe(local(16).toISOString());
  });
});

export type { Reminder };

describe('the rhythm entry', () => {
  it('is made once, cannot be created again or deleted through create, and is tuned by update', async () => {
    const { e, at } = engine();
    const looks: string[] = [];
    const r = e.ensureRhythm({ schedule: { jitter: { minMinutes: 40, maxMinutes: 70 }, from: '09:00', to: '23:30' }, params: { skipChance: 0.2, dailySpeaking: 8 } });
    expect(e.ensureRhythm({ schedule: { everyMinutes: 30 }, params: { skipChance: 0, dailySpeaking: 1 } }).id).toBe(r.id);
    expect(() => e.create({ title: 'x', kind: 'rhythm', schedule: { everyMinutes: 30 }, why: 'x' })).toThrow(/one rhythm/);
    expect(e.update(r.id, { params: { skipChance: 0.3, dailySpeaking: 10 } }).params).toEqual({ skipChance: 0.3, dailySpeaking: 10 });
    expect(() => e.update(r.id, { params: { skipChance: 2, dailySpeaking: 1 } })).toThrow(/skipChance/);
    void looks; void at;
  });

  it('runs the rhythm hook when its entry comes due', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rem-'));
    let clock = local(10, 0);
    const looked: string[] = [];
    const e = new ReminderEngine(new ReminderStore(join(dir, 'rem.sqlite')), {
      say: async () => true, wakeFront: () => {}, onStale: () => {}, rhythm: async (r) => { looked.push(r.id); },
      now: () => clock, random: () => 0,
    });
    const r = e.ensureRhythm({ schedule: { jitter: { minMinutes: 40, maxMinutes: 70 }, from: '09:00', to: '23:30' }, params: { skipChance: 0, dailySpeaking: 8 } });
    expect(r.nextAt).toBe(local(10, 40).toISOString());
    clock = local(10, 41);
    await e.tick();
    expect(looked).toEqual(['rhythm']);
    expect(e.store.get('rhythm')!.nextAt).toBe(local(11, 21).toISOString());
  });
});

