import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { behindState } from '../core/behind.ts';
import { TaskBus } from '../core/agents/bus.ts';
import { Ledger } from '../core/ledger/ledger.ts';
import { Cases } from '../core/agents/cases.ts';
import { PermissionRules } from '../core/agents/permission-rules.ts';
import type { Agents } from '../core/agents/roles.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'behind-'));
  const ledger = new Ledger(join(dir, 'ledger.sqlite'));
  const fail = async () => { throw new Error('fixture failure'); };
  const bus = new TaskBus(join(dir, 'bus.sqlite'), { ledger, runners: { control: fail, coder: fail } });
  const cases = new Cases(join(dir, 'cases'));
  const permissionRules = new PermissionRules(dir);
  return { ledger, bus, cases, permissionRules, agents: { ledger, bus, cases, permissionRules, pendingPermissions: () => [] } as unknown as Agents };
}

describe('what goes on behind the pet', () => {
  it('exposes original task notes for review when execution fails', async () => {
    const { agents, bus } = setup();
    const task = bus.submit({ to: 'control', from: 'front', body: 'work' });
    bus.update(task.id, '补充要求');
    // The fixture runner fails without asserting the note was read.
    bus.start();
    await bus.whenIdle();
    expect(behindState(agents).done).toEqual([expect.objectContaining({ status: 'failed', notesToReview: ['补充要求'] })]);
    await bus.closeAsync();
  });
  it('lists the work under way, what just finished, the cases with their decisions, and recent decisions', () => {
    const { ledger, bus, cases, permissionRules, agents } = setup();
    bus.submit({ to: 'control', from: 'front', body: '学着跟他的手走\n细节', label: '学着跟他的手走' });
    bus.submit({ to: 'control', from: 'daily', body: 'internal judgement', label: 'internal:workarea' });
    const c = cases.open({ kind: 'workarea', key: 'k', question: 'Where may it walk?', sections: [], images: [] });
    cases.decide(c.id, { verdict: 'zone_wrong' });
    ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: 'settled the Claude window', why: 'the input box is 41–70%' });
    permissionRules.add('code agent · write · D:/elsewhere', 'write {"path":"D:/elsewhere/notes.md"}');
    const st = behindState(agents);
    expect(st.permissions).toEqual([]);
    expect(st.open).toEqual([expect.objectContaining({ to: 'control', from: 'front', what: '学着跟他的手走', status: 'queued', runnerId: 'legacy-v1', codeProvider: null })]);
    expect(st.open[0]!.notesToReview).toEqual([]);
    expect(st.done).toEqual([]);
    expect(st.cases).toEqual([expect.objectContaining({ id: c.id, question: 'Where may it walk?', decided: expect.objectContaining({ verdict: 'zone_wrong' }) })]);
    expect(st.rules).toEqual([expect.objectContaining({ kind: 'code agent · write · D:/elsewhere' })]);
    expect(st.decisions).toEqual([expect.objectContaining({ role: 'control', summary: 'settled the Claude window', why: 'the input box is 41–70%' })]);
  });
  it('keeps long recovery details intact in the background projection', async () => {
    const { agents, bus } = setup();
    const task = bus.submit({ to: 'control', from: 'front', body: 'work' });
    bus.start();
    await bus.whenIdle();
    const detail = `${'中断原因 '.repeat(180)}末尾证据`;
    (bus as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare("UPDATE task SET status = 'unknown', result = ? WHERE id = ?").run(detail, task.id);
    expect(behindState(agents).open.find((item) => item.id === task.id)?.result).toBe(detail);
    await bus.closeAsync();
  });

  it('hides legacy daily tasks only when their case source is a real workarea case', async () => {
    const { agents, bus, cases } = setup();
    const c = cases.open({ kind: 'workarea', key: 'window#mode-1', question: 'Where may it walk?', sections: [], images: [] });
    const legacyOpen = bus.submit({ to: 'control', from: 'daily', body: cases.render(c), label: 'where the pet may walk' });
    const legacyDone = bus.submit({ to: 'control', from: 'daily', body: cases.render(c), label: 'where the pet may walk' });
    const titleOnlyUserTask = bus.submit({ to: 'control', from: 'front', body: '请帮我处理一个任务', label: 'where the pet may walk' });
    const titleOnlyDailyTask = bus.submit({ to: 'control', from: 'daily', body: 'ordinary daily note without a case reference', label: 'where the pet may walk' });
    const missingCase = bus.submit({ to: 'control', from: 'daily', body: '[case case-missing] not a stored workarea case', label: 'workarea follow-up' });
    (bus as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).db
      .prepare("UPDATE task SET status = 'done' WHERE id = ?").run(legacyDone.id);

    const st = behindState(agents);
    expect(st.open.map((task) => task.id)).toContain(titleOnlyUserTask.id);
    expect(st.open.map((task) => task.id)).toContain(titleOnlyDailyTask.id);
    expect(st.open.map((task) => task.id)).toContain(missingCase.id);
    expect(st.open.map((task) => task.id)).not.toContain(legacyOpen.id);
    expect(st.done.map((task) => task.id)).not.toContain(legacyDone.id);
    expect(st.cases.map((item) => item.id)).toContain(c.id);
    await bus.closeAsync();
    cases.close();
  });
});
