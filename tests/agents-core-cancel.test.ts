import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { FrontInputEvent, Logger, ToolDef } from '../core/contracts.ts';
import { Agents } from '../core/agents/roles.ts';
import { ScriptedModel } from './fixtures/scripted-model.ts';

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };
describe('Agents cancellation through the standard control agent', () => {
  it('passes cancellation to an active tool and retains unknown for possible side effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-agents-cancel-'));
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const received: FrontInputEvent[] = [];
    const tool: ToolDef = { name: 'fixture_read', description: 'Read fixture data', tags: ['read'],
      parameters: { type: 'object', properties: {} }, handler: async (_args, context) => {
        signal = context.signal; started();
        await new Promise<void>((resolve) => context.signal!.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('operation interrupted');
      } };
    const model = new ScriptedModel([new AIMessage({ content: '',
      tool_calls: [{ id: 'read-1', name: 'fixture_read', args: {} }] })]);
    const agents = new Agents({ dataDir: dir, log, model: () => model, frameworkControl: true,
      fileTools: () => [tool], front: () => ({ log, enqueue: (event) => { received.push(event); return true; } }) });
    try {
      agents.start();
      const task = agents.bus.submit({ to: 'control', from: 'front', body: 'perform the fixture lookup' });
      await ready;
      expect(agents.bus.cancel(task.id)).toBe(true);
      await agents.bus.whenIdle();
      expect(signal?.aborted).toBe(true);
      expect(agents.bus.get(task.id)).toMatchObject({ status: 'unknown', result: expect.stringContaining('side effects need review') });
      expect(received).toHaveLength(0);
    } finally { await agents.closeAsync(); rmSync(dir, { recursive: true, force: true }); }
  });
});
