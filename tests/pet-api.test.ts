import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_FILE, apiAccess, startApi } from '../core/pet/api.ts';

const servers: Array<{ close(): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function setup() {
  const said: string[] = [];
  const runtimeChanges: unknown[] = [];
  const runtime = {
    model: { provider: 'local', protocol: 'openai-responses-compat', apiUrl: 'http://127.0.0.1/v1', model: 'fixture-model', keyConfigured: true },
    executor: { provider: 'codex', sandboxMode: 'workspace-write', networkAccess: 'deny', taskDirectory: 'drafts', description: 'Codex CLI' },
    apply: { model: { requiresRestart: false as const, message: '后续请求生效' }, executor: { requiresRestart: true, message: '重启后生效' } },
  };
  const access = { port: 0, token: 'x'.repeat(48) };
  const server = await startApi(access, {
    status: () => ({ name: '灵犀', paused: false, body: { connected: true, x: 0.5 }, feeling: 'rested' }),
    behind: () => null,
    settings: () => ({ name: '灵犀', user: '小王' }),
    runtimeSettings: () => runtime,
    saveRuntimeSettings: (change) => { runtimeChanges.push(change); return runtime; },
    asks: () => [{ id: 'ask-1', question: '喝什么?', options: ['茶', '咖啡'], at: 1 }],
    memory: () => ({ available: true, episodes: [{ id: 1, title: '喝水', summary: '说了半天喝水', at: '2026-10-28T12:00:00.000Z', importance: 1 }] }),
    history: () => ({ available: true, lines: [{ who: 'person', kind: 'said', text: '在吗' }] }),
    historySince: (after) => ({ available: true, cursor: after + 1, lines: [] }),
    tasks: () => ({ open: [], done: [] }),
    noteTask: (id, note) => id === 'task-1' && note === '靠右',
    cancelTask: (id) => id === 'task-1',
    recoverTask: (id, action) => id === 'task-unknown' && action === 'resume',
    say: async (t) => { said.push(t); return true; },
    answer: async (q, t) => { said.push(`${q}=${t}`); return true; },
    revoke: (kind) => ({ revoked: kind === 'ok', behind: null }),
    save: (change) => ({ name: change.name ?? '灵犀', user: change.user ?? '哥' }),
  });
  servers.push(server);
  const port = (server.address() as { port: number }).port;
  const ask = (path: string, init: RequestInit & { token?: string } = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init, headers: { 'x-lingxi-token': init.token ?? access.token, 'content-type': 'application/json' },
  });
  return { ask, said, runtimeChanges };
}

describe("the brain's local API", () => {
  it('reports an invalid persisted port without replacing the saved token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-api-access-'));
    const file = join(dir, API_FILE);
    writeFileSync(file, JSON.stringify({ port: 99999, token: 'x'.repeat(48) }));
    expect(() => apiAccess(dir)).toThrow('Invalid port');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ port: 99999, token: 'x'.repeat(48) });
  });
  it('answers only with the token', async () => {
    const { ask } = await setup();
    expect((await ask('/lingxi/status', { token: 'nope' })).status).toBe(401);
    const r = await ask('/lingxi/status');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ name: '灵犀', body: { connected: true } });
    expect((await ask('/lingxi/status', { token: 'é'.repeat(48) })).status).toBe(401);
  });

  it('passes what the person says and answers on to her', async () => {
    const { ask, said } = await setup();
    expect(await (await ask('/lingxi/say', { method: 'POST', body: JSON.stringify({ text: ' 在吗 ' }) })).json()).toEqual({ delivered: true });
    await ask('/lingxi/answer', { method: 'POST', body: JSON.stringify({ question: '喝什么?', text: '茶' }) });
    expect(said).toEqual(['在吗', '喝什么?=茶']);
    expect((await ask('/lingxi/say', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('lists the questions waiting for an answer, only with the token', async () => {
    const { ask } = await setup();
    expect((await ask('/lingxi/asks', { token: 'nope' })).status).toBe(401);
    const r = await ask('/lingxi/asks');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([{ id: 'ask-1', question: '喝什么?', options: ['茶', '咖啡'], at: 1 }]);
  });

  it('takes a rule back and answers the state after it', async () => {
    const { ask } = await setup();
    const r = await ask('/lingxi/revoke', { method: 'POST', body: JSON.stringify({ kind: 'ok' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ revoked: true, behind: null });
    expect((await ask('/lingxi/revoke', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('writes the name and what she calls the person, and refuses an empty one', async () => {
    const { ask } = await setup();
    const r = await ask('/lingxi/settings', { method: 'POST', body: JSON.stringify({ name: '灵犀', user: '哥' }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: '灵犀', user: '哥' });
    expect((await ask('/lingxi/settings', { method: 'POST', body: JSON.stringify({ name: '  ' }) })).status).toBe(400);
    expect((await ask('/lingxi/settings', { method: 'POST', body: '{}' })).status).toBe(400);
  });

  it('reads model and executor settings without returning secrets and keeps empty-key updates explicit', async () => {
    const { ask, runtimeChanges } = await setup();
    expect((await ask('/lingxi/runtime-settings', { token: 'nope' })).status).toBe(401);
    const read = await ask('/lingxi/runtime-settings');
    expect(await read.json()).toMatchObject({
      model: { protocol: 'openai-responses-compat', apiUrl: 'http://127.0.0.1/v1', model: 'fixture-model', keyConfigured: true },
      executor: { provider: 'codex', sandboxMode: 'workspace-write', networkAccess: 'deny' },
    });
    const changed = await ask('/lingxi/runtime-settings', { method: 'POST', body: JSON.stringify({
      model: { apiUrl: 'http://127.0.0.1/new/v1', model: 'next-model', apiKey: 'must-not-return-this' },
      executor: { provider: 'codex', sandboxMode: 'read-only', networkAccess: 'deny' },
    }) });
    expect(changed.status).toBe(200);
    expect(JSON.stringify(await changed.json())).not.toContain('must-not-return-this');
    expect(runtimeChanges[0]).toMatchObject({ model: { apiKey: 'must-not-return-this' }, executor: { sandboxMode: 'read-only' } });
    const keepKey = await ask('/lingxi/runtime-settings', { method: 'POST', body: JSON.stringify({ model: { apiKey: '' } }) });
    expect(keepKey.status).toBe(200);
    expect(runtimeChanges[1]).toEqual({ model: { apiKey: '' } });
  });

  it('hands over what she remembers lately, only with the token', async () => {
    const { ask } = await setup();
    expect((await ask('/lingxi/memory', { token: 'nope' })).status).toBe(401);
    const r = await ask('/lingxi/memory');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ available: true, episodes: [{ title: '喝水' }] });
  });

  it('hands over recent shared history without creating another transcript', async () => {
    const { ask } = await setup();
    expect((await ask('/lingxi/history', { token: 'nope' })).status).toBe(401);
    expect(await (await ask('/lingxi/history')).json()).toEqual({ available: true, lines: [{ who: 'person', kind: 'said', text: '在吗' }] });
  });

  it('validates incremental history cursors and requires the token', async () => {
    const { ask } = await setup();
    expect((await ask('/lingxi/history-since?after=4', { token: 'nope' })).status).toBe(401);
    expect(await (await ask('/lingxi/history-since?after=4')).json()).toEqual({ available: true, cursor: 5, lines: [] });
    for (const query of ['', '?after=-1', '?after=1.2', '?after=9007199254740992']) {
      expect((await ask(`/lingxi/history-since${query}`)).status).toBe(400);
    }
  });

  it('allows the UI to add a clarification or request cancellation by task id', async () => {
    const { ask } = await setup();
    expect(await (await ask('/lingxi/tasks')).json()).toEqual({ open: [], done: [] });
    expect(await (await ask('/lingxi/task-note', { method: 'POST', body: JSON.stringify({ id: 'task-1', note: '靠右' }) })).json()).toEqual({ updated: true });
    expect(await (await ask('/lingxi/task-cancel', { method: 'POST', body: JSON.stringify({ id: 'task-1' }) })).json()).toEqual({ cancelling: true });
    expect((await ask('/lingxi/task-note', { method: 'POST', body: JSON.stringify({ id: 'task-1' }) })).status).toBe(400);
    expect(await (await ask('/lingxi/task-recover', { method: 'POST', body: JSON.stringify({ id: 'task-unknown', action: 'resume' }) })).json()).toEqual({ recovered: true });
    expect((await ask('/lingxi/task-recover', { method: 'POST', body: JSON.stringify({ id: 'task-unknown', action: 'maybe' }) })).status).toBe(400);
  });

  it('keeps its port and token in the data directory, the same each start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-api-'));
    const first = apiAccess(dir);
    expect(first.token).toHaveLength(48);
    expect(apiAccess(dir)).toEqual(first);
    expect(JSON.parse(readFileSync(join(dir, API_FILE), 'utf8'))).toEqual(first);
  });
});
