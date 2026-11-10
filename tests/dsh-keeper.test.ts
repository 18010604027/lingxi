import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DshBackend } from '../core/agents/dsh.ts';
import { DshKeeper, KEEPER_DEFAULTS, retryDelay, type DshKeeperOptions } from '../core/agents/dsh-keeper.ts';

const fake = fileURLToPath(new URL('./fixtures/fake-acp-keeper.mjs', import.meta.url));
const keepers: DshKeeper[] = [];
afterEach(async () => { await Promise.all(keepers.splice(0).map(k => k.stop())); });
function setup(options: Partial<Omit<DshKeeperOptions, 'backend'>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'keeper-'));
  let mode = '', available = true, starts = 0;
  const keeper = new DshKeeper({
    idleMs: 5000, initialBackoffMs: 5, maxBackoffMs: 20, stableMs: 5000, availabilityPollMs: 20, cancellationPollMs: 5,
    ...options,
    backend: () => available ? new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: directory, cwd: directory, launch: () => { starts++; return { command: process.execPath, args: [fake, mode] }; } }) : null,
  });
  keepers.push(keeper);
  return { keeper, get starts() { return starts; }, mode: (value: string) => { mode = value; }, available: (value: boolean) => { available = value; } };
}
const run = (keeper: DshKeeper, text = 'work') => keeper.run(text, () => false, async () => false);

describe('on-demand DSH process ownership', () => {
  it('starts only on demand, reuses a healthy process, and closes it when idle', async () => {
    const fixture = setup({ idleMs: 60 });
    expect(fixture.starts).toBe(0);
    const first = await run(fixture.keeper, 'first');
    const second = await run(fixture.keeper, 'second');
    expect(first.text.split(':')[0]).toBe(second.text.split(':')[0]); expect(fixture.starts).toBe(1);
    await expect.poll(() => fixture.keeper.status().kind).toBe('idle');
    expect((await run(fixture.keeper, 'third')).text.split(':')[0]).not.toBe(first.text.split(':')[0]);
  });
  it('queues while unavailable, then drains in order when a backend appears', async () => {
    const fixture = setup(); fixture.available(false);
    const first = run(fixture.keeper, 'one'), second = run(fixture.keeper, 'two');
    await expect.poll(() => fixture.keeper.status().kind).toBe('waiting');
    expect(fixture.keeper.status()).toMatchObject({ queued: 2, failures: 0 }); expect(fixture.starts).toBe(0);
    fixture.available(true);
    expect((await first).text).toContain('one'); expect((await second).text).toContain('two'); expect(fixture.starts).toBe(1);
  });
  it('keeps unstarted work through startup crashes and releases it after explicit fuse recovery', async () => {
    const fixture = setup(); fixture.mode('fail-start');
    const result = run(fixture.keeper);
    await expect.poll(() => fixture.keeper.status().kind).toBe('fused');
    expect(fixture.starts).toBe(KEEPER_DEFAULTS.maxFailures);
    expect(fixture.keeper.status()).toMatchObject({ failures: KEEPER_DEFAULTS.maxFailures, queued: 1 });
    fixture.mode(''); fixture.keeper.reset();
    expect((await result).text).toContain('work');
  });
  it('does not replay a crashed in-flight task and still runs the next queued task after recovery', async () => {
    const fixture = setup();
    const crashed = run(fixture.keeper, 'EXIT-PROCESS');
    const check = expect(crashed).rejects.toThrow('outcome is unknown');
    const next = run(fixture.keeper, 'next');
    await check; expect((await next).text).toContain('next'); expect(fixture.starts).toBe(2);
  });
  it('clears consecutive failures only after the process stays alive for the stable period', async () => {
    const fixture = setup({ stableMs: 100, maxFailures: 3 }); fixture.mode('fail-start');
    const result = run(fixture.keeper);
    await expect.poll(() => fixture.keeper.status().failures).toBeGreaterThan(0);
    fixture.mode(''); expect((await result).text).toContain('work');
    await expect.poll(() => fixture.keeper.status().failures).toBe(0);
  });
  it('cancels unavailable queued work and stops a hung startup without leaving a child', async () => {
    const fixture = setup({ startupTimeoutMs: 1000 }); fixture.available(false);
    let cancelled = false;
    const queued = fixture.keeper.run('cancel', () => cancelled, async () => false);
    const check = expect(queued).rejects.toThrow('cancelled before execution'); cancelled = true;
    await check;
    fixture.available(true); fixture.mode('hang-start');
    const hung = run(fixture.keeper), stopped = expect(hung).rejects.toThrow('stopped');
    await expect.poll(() => fixture.keeper.status().kind).toBe('starting');
    await fixture.keeper.stop(); await stopped;
    expect(fixture.keeper.status().kind).toBe('stopped');
  });
  it('uses capped exponential delays from the declared policy', () => {
    expect(retryDelay(1)).toBe(KEEPER_DEFAULTS.initialBackoffMs);
    expect(retryDelay(2)).toBe(KEEPER_DEFAULTS.initialBackoffMs * 2);
    expect(retryDelay(20)).toBe(KEEPER_DEFAULTS.maxBackoffMs);
  });
});
