import { Annotation, END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCheckpointSaver } from '../core/runtime/sqlite-checkpoint-saver.ts';
import { FrontInputJournal } from '../core/runtime/front-input-journal.ts';
import { reconcileFrontInput } from '../core/runtime/front-input-reconcile.ts';

describe('experimental front input checkpoint boundary', () => {
  it('checkpoints a batch before the model and resumes without adding it twice', async () => {
    const State = Annotation.Root({
      batches: Annotation<Array<{ id: string; fingerprint: string }>>({ reducer: (old, next) => old.concat(next), default: () => [] }),
    });
    const model = vi.fn(async () => ({}));
    const graph = new StateGraph(State).addNode('model', model).addEdge(START, 'model').addEdge('model', END)
      .compile({ checkpointer: new MemorySaver(), interruptBefore: ['model'] });
    const config = { configurable: { thread_id: 'input-boundary' }, durability: 'sync' as const };
    await graph.invoke({ batches: [{ id: 'batch-1', fingerprint: 'content-1' }] }, config);
    const saved = await graph.getState(config);
    expect(saved.values.batches).toEqual([{ id: 'batch-1', fingerprint: 'content-1' }]);
    expect(saved.next).toContain('model');
    expect(model).not.toHaveBeenCalled();
    await graph.invoke(null, config);
    expect(model).toHaveBeenCalledOnce();
    expect((await graph.getState(config)).values.batches).toEqual([{ id: 'batch-1', fingerprint: 'content-1' }]);
  });
  it('reconciles a persisted graph checkpoint after reopening both databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-graph-'));
    const state = Annotation.Root({
      batches: Annotation<Array<{ id: string; fingerprint: string; records: unknown[] }>>({ reducer: (old, next) => old.concat(next), default: () => [] }),
    });
    const model = vi.fn(async () => ({}));
    let saver = new SqliteCheckpointSaver(join(dir, 'graph.sqlite'));
    let journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    const makeGraph = () => new StateGraph(state).addNode('model', model).addEdge(START, 'model').addEdge('model', END)
      .compile({ checkpointer: saver, interruptBefore: ['model'] });
    let graph = makeGraph();
    const config = { configurable: { thread_id: 'thread' }, durability: 'sync' as const };
    const batch = { threadId: 'thread', batchId: 'b1', cursors: [1], records: [{ text: 'hello' }] };
    try {
      const prepared = journal.prepare(batch);
      await graph.invoke({ batches: [{ id: batch.batchId, fingerprint: prepared.fingerprint, records: batch.records }] }, config);
      expect(model).not.toHaveBeenCalled();
      saver.close(); journal.close();
      saver = new SqliteCheckpointSaver(join(dir, 'graph.sqlite'));
      journal = new FrontInputJournal(join(dir, 'input.sqlite')); graph = makeGraph();
      const port = {
        read: async (_thread: string, id: string) => (await graph.getState(config)).values.batches?.find((item: any) => item.id === id)?.fingerprint,
        write: async () => { throw new Error('already checkpointed: must not write twice'); },
      };
      expect((await reconcileFrontInput(journal, port, batch)).state).toBe('accepted');
      await graph.invoke(null, config);
      expect(model).toHaveBeenCalledOnce();
      expect((await graph.getState(config)).values.batches).toHaveLength(1);
    } finally { saver.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
