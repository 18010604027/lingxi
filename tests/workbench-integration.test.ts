import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Agents } from '../core/agents/roles.ts';
import { behindState } from '../core/behind.ts';
import { startApi } from '../core/pet/api.ts';
import { AIMessage } from '@langchain/core/messages';
import { ScriptedModel } from './fixtures/scripted-model.ts';
import { PetWorld } from '../core/pet/world.ts';
import { EventMemory, historySince } from '../core/memory/events.ts';
import { AppEvents } from '../core/runtime/app-events.ts';
import { bindBodyInput } from '../core/runtime/body-input.ts';

const { call } = createRequire(import.meta.url)('../workbench/bridge.cjs');
const { JSDOM } = createRequire(import.meta.url)('jsdom');

describe('workbench and host task flow', () => {
  it('shows delivered input and completed body speech through the shared history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-workbench-history-'));
    const store = new AppEvents(join(dir, 'events.sqlite'));
    const memory = new EventMemory(dir); memory.attachStore(store);
    expect(historySince(store, 0)).toEqual({ available: true, cursor: 0, lines: [] });
    expect(historySince(store, 4)).toEqual({ available: true, reset: true, cursor: 0, lines: [] });
    const link = Object.assign(new EventEmitter(), { connected: true, x: 0.5, send: () => 1 });
    const behavior = Object.assign(new EventEmitter(), { keptOut: [] });
    const world = new PetWorld({ link: link as never, behavior: behavior as never,
      figure: { moves: { walk: [], run: [] }, words: {}, vocab: {} } as never,
      timezone: 'Asia/Shanghai', userName: () => '朋友', sleep: async () => {} });
    await world.start({ pushEvent: async (event: Record<string, unknown>) => store.push({ origin: 'external', ...event } as never) } as never);
    const access = { port: 0, token: 'h'.repeat(48) };
    const server = await startApi(access, {
      status: () => ({ name: '灵犀', paused: false, body: { connected: true, x: 0.5 }, feeling: '' }),
      behind: () => null, settings: () => ({ name: '灵犀', user: '朋友' }), asks: () => [],
      memory: () => ({ available: true, episodes: [] }),
      history: () => { const cursor = store.latestCursor(); memory.sync(); return { available: true, cursor, lines: memory.recentLines() }; },
      historySince: (after) => historySince(store, after),
      tasks: () => null, noteTask: () => false, cancelTask: () => false, recoverTask: () => false,
      say: (text) => world.typed(text), answer: async () => false,
      revoke: () => ({ revoked: false, behind: null }), save: () => ({ name: '灵犀', user: '朋友' }),
    });
    const dom = new JSDOM('<div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'file:///workbench/index.html' });
    try {
      const actual = server.address();
      if (!actual || typeof actual === 'string') throw new Error('missing test port');
      const local = { ...access, port: actual.port };
      Object.assign(dom.window, { lingxi: { call: (operation: string, body: unknown) => call(local, operation, body) } });
      dom.window.eval(readFileSync(join(process.cwd(), 'workbench/renderer.js'), 'utf8'));
      const waitFor = async (condition: () => boolean) => {
        for (let i = 0; i < 250; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
        throw new Error('workbench did not update');
      };
      await waitFor(() => !!dom.window.document.querySelector('#say-form'));
      bindBodyInput(link as never, () => world);
      link.emit('message', { t: 'typed', text: '周末去猫咖' });
      await waitFor(() => dom.window.document.querySelector('#conversation')!.textContent!.includes('周末去猫咖'));
      const say = world.tools().find((tool) => tool.name === 'pet_say')!;
      await say.handler({ script: '好呀' }, {} as never);
      await new Promise((resolve) => setTimeout(resolve, 20));
      link.emit('message', { t: 'speech', id: 1, state: 'completed' });
      const next = await call(local, 'historySince', { after: 1 });
      expect(next).toMatchObject({ available: true, cursor: 4, lines: [{ who: 'pet', text: '好呀' }] });
      dom.window.document.querySelector('[data-page="memory"]').click();
      await waitFor(() => dom.window.document.body.textContent!.includes('周末去猫咖') && dom.window.document.body.textContent!.includes('好呀'));
      expect(memory.recentLines().map((line) => [line.who, line.text])).toEqual([['person', '周末去猫咖'], ['pet', '好呀']]);
    } finally {
      dom.window.close();
      await world.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      memory.close(); store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('submits input to the host and reads its settled task through the real API and bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-workbench-host-'));
    const received: string[] = [];
    const model = new ScriptedModel([new AIMessage('整理好了')]);
    const agents = new Agents({ dataDir: dir, log: console, front: () => ({ log: console, enqueue: (event) => { received.push(event.text); return true; } }), model: () => model, fileTools: () => [], frameworkControl: true });
    const access = { port: 0, token: 't'.repeat(48) };
    const server = await startApi(access, {
      status: () => ({ name: 'test', paused: false, body: { connected: false, x: 0 }, feeling: '' }),
      behind: () => behindState(agents), settings: () => ({ name: 'test', user: 'person' }), asks: () => [],
      memory: () => ({ available: false, episodes: [] }), history: () => ({ available: false, lines: [] }),
      tasks: () => behindState(agents), noteTask: (id, note) => agents.bus.update(id, note),
      cancelTask: (id) => agents.bus.cancel(id), recoverTask: (id, action) => agents.bus.recover(id, action),
      // The scripted front invokes the same delegate tool as the Persona.
      say: async (text) => {
        const tool = agents.frontTools().find((candidate) => candidate.name === 'delegate_task')!;
        const out = await tool.handler({ task: text }, { role: 'main', log: console as never });
        return typeof out === 'string' && out.startsWith('[delegated]');
      },
      answer: async () => false, revoke: () => ({ revoked: false, behind: null }),
      save: () => ({ name: 'test', user: 'person' }),
    });
    try {
      agents.start();
      const actual = server.address();
      if (!actual || typeof actual === 'string') throw new Error('missing test port');
      const local = { ...access, port: actual.port };
      expect(await call(local, 'say', { text: '整理材料' })).toEqual({ delivered: true });
      await agents.bus.whenIdle();
      const tasks = await call(local, 'tasks');
      expect(tasks.done).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'done', runnerId: 'framework-v1', result: '整理好了', deliveryUnconfirmed: false })]));
      expect(received).toHaveLength(1);
      expect(received[0]).toContain('整理好了');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      agents.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* SQLite may still be closing on Windows. */ }
    }
  });
});
