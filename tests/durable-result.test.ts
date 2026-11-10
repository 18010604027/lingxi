import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { Logger } from '../core/contracts.ts';
import { Agents } from '../core/agents/roles.ts';
import { AppEvents } from '../core/runtime/app-events.ts';
import { createLocalFront } from '../core/runtime/local-app.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
describe('durable background results in the application event source', () => {
  it('keeps one stable result across normal close, reopen and confirmation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-result-'));
    const file = join(dir, 'events.sqlite');
    let store = new AppEvents(file);
    try {
      const event = { type: 'background.result', id: 'task-1', text: 'The work is ready.', trigger: 'preempt' as const };
      expect(store.enqueue(event)).toBe(true); expect(store.enqueue(event)).toBe(true);
      expect(store.pending()).toHaveLength(1);
      store.close(); store = new AppEvents(file);
      const pending = store.pending();
      expect(pending).toEqual([expect.objectContaining({ type: 'background.result', text: event.text, meta: { eventId: 'task-1' } })]);
      store.confirm(pending.map((e) => e.cursor));
      store.close(); store = new AppEvents(file);
      expect(store.pending()).toEqual([]);
      expect(store.enqueue(event)).toBe(true); expect(store.pending()).toEqual([]);
      expect(store.range({})).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists a real task result through the production source and consumes it after reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-result-front-'));
    const options = { log, eventFile: join(dir, 'events.sqlite'), checkpointPath: join(dir, 'front.sqlite'),
      sessionId: 'front', tools: [], context: () => ({ system: 'Be concise.', head: '', tail: '' }) };
    let local = createLocalFront({ ...options, model: new ScriptedModel([]) });
    const control = new ScriptedModel([new AIMessage('整理出三点。')]);
    const agents = new Agents({ dataDir: join(dir, 'agents'), log, model: () => control, frameworkControl: true,
      fileTools: () => [], front: () => local.source });
    try {
      agents.start();
      const task = agents.bus.submit({ to: 'control', from: 'front', body: '整理资料' });
      await agents.bus.whenIdle();
      expect(agents.bus.get(task.id)?.status).toBe('done');
      expect(agents.bus.retryableFrontResults()).toEqual([]);
      expect(local.events.pending()).toHaveLength(1);
      await local.close();
      const model = new ScriptedModel([new AIMessage('后台已经整理好三点了。')]);
      local = createLocalFront({ ...options, model });
      expect(await local.drain()).toBe('后台已经整理好三点了。');
      expect(JSON.stringify(model.requests[0])).toContain('整理出三点。');
      expect(local.events.pending()).toEqual([]);
      expect(local.events.range({})).toEqual([expect.objectContaining({ type: 'background.result', meta: { eventId: task.id } })]);
    } finally { await agents.closeAsync(); await local.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});