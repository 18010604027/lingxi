import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DshBackend, overlay } from '../core/agents/dsh.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
let backends: DshBackend[] = [];
afterEach(async () => { await Promise.all(backends.map((b) => b.close())); backends = []; });

function backend() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-'));
  const strays: string[] = [];
  const b = new DshBackend({
    install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir,
    launch: () => ({ command: process.execPath, args: [FAKE] }),
    log: (m) => strays.push(m),
  });
  backends.push(b);
  return { b, strays };
}

describe('DshBackend', () => {
  it('runs a task as a session and returns the agent messages, skipping log lines on stdout', async () => {
    const { b, strays } = backend();
    const out = await b.run('tidy the notes', () => false, async () => false);
    expect(out).toEqual({ text: 'got: tidy the notes', sessionId: 's1', stopReason: 'end_turn', resumed: false });
    expect(strays).toContain('[dsh] [plugin] a log line on stdout');
    // one process serves later tasks
    expect((await b.run('again', () => false, async () => false)).sessionId).toBe('s2');
  });

  it('continues a session it is given, and starts a new one when that session is gone', async () => {
    const { b, strays } = backend();
    const first = await b.run('one', () => false, async () => false);
    expect(await b.run('two', () => false, async () => false, first.sessionId)).toMatchObject({ sessionId: first.sessionId, resumed: true });
    expect(await b.run('three', () => false, async () => false, 'gone')).toMatchObject({ sessionId: 's2', resumed: false });
    expect(strays.some((m) => m.includes('could not resume session gone'))).toBe(true);
  });

  it('passes a permission request to the person and answers with their choice', async () => {
    const { b } = backend();
    const asks: string[] = [];
    expect((await b.run('ASK-PERMISSION', () => false, async (a) => { asks.push(a.title); return true; })).text).toBe('permission: yes');
    expect((await b.run('ASK-PERMISSION', () => false, async () => false)).text).toBe('permission: no');
    expect((await b.run('ASK-PERMISSION', () => false, async () => { throw new Error('front gone'); })).text).toBe('permission: no');
    expect(asks).toEqual(['write']);
  });

  it('cancels the session once the task must stop', async () => {
    const { b } = backend();
    let stop = false;
    setTimeout(() => { stop = true; }, 300);
    const out = await b.run('WAIT-CANCEL', () => stop, async () => false);
    expect(out).toMatchObject({ text: 'started; ', stopReason: 'cancelled' });
  });

  it('writes an overlay that sets the persona, the model route, a session store of its own and the write sandbox', () => {
    const yml = overlay({ provider: 'deepseek-account', model: 'deepseek-flash' }, 'C:\\pet\\data\\dsh-sessions', 'C:\\pet\\workspace\\control');
    expect(yml).toContain('- id: system-prompt');
    expect(yml).toContain('    provider: "deepseek-account"\n    model: "deepseek-flash"');
    expect(yml).toContain('- id: session-persistence-jsonl');
    expect(yml).toContain('    root: "C:/pet/data/dsh-sessions"');
    expect(yml).toContain('- id: sandbox-policy');
    expect(yml).toContain('    mode: workspace-write\n    workspaceRoot: "C:/pet/workspace/control"');
  });
});

describe('stored DSH sessions', () => {
  it('are deleted once untouched for the retention period, and kept while recent', async () => {
    const { mkdirSync, writeFileSync, utimesSync, existsSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'dsh-prune-'));
    const b = new DshBackend({ install: { exe: 'unused', cli: 'unused' }, dataDir: dir, cwd: dir });
    const old = join(b.sessionsRoot(), '--ws--', 'old');
    const fresh = join(b.sessionsRoot(), '--ws--', 'fresh');
    for (const d of [old, fresh]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'session.jsonl.zstd'), 'x'); }
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(old, 'session.jsonl.zstd'), longAgo, longAgo);
    utimesSync(old, longAgo, longAgo);
    expect(b.pruneSessions(30)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
