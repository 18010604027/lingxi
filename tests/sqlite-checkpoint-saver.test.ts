import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyCheckpoint } from '@langchain/langgraph';
import { SqliteCheckpointSaver } from '../core/runtime/sqlite-checkpoint-saver.ts';

describe('sqlite checkpoint saver', () => {
  it('reopens checkpoints and preserves ordered pending writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-checkpoint-'));
    const file = join(dir, 'checkpoint.sqlite');
    let saver = new SqliteCheckpointSaver(file);
    const checkpoint = { ...emptyCheckpoint(), id: '0001', channel_values: { batches: ['b1'] } };
    const base = { configurable: { thread_id: 't' } };
    try {
      const written = await saver.put(base, checkpoint, { source: 'input' }, {});
      await saver.putWrites(written, [['batches', ['b1']]], 'task-1', 'path/1');
      saver.close(); saver = new SqliteCheckpointSaver(file);
      const found = await saver.getTuple({ configurable: { thread_id: 't' } });
      expect(found?.checkpoint.id).toBe('0001');
      expect(found?.pendingWrites).toEqual([['task-1', 'batches', ['b1']]]);
      const listed = []; for await (const item of saver.list({ configurable: { thread_id: 't' } })) listed.push(item);
      expect(listed).toHaveLength(1);
      await saver.deleteThread('t');
      expect(await saver.getTuple({ configurable: { thread_id: 't' } })).toBeUndefined();
    } finally { saver.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserves ordinary writes on retry and replaces special writes without collisions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-checkpoint-writes-'));
    const saver = new SqliteCheckpointSaver(join(dir, 'checkpoint.sqlite'));
    try {
      const written = await saver.put({ configurable: { thread_id: 't' } }, { ...emptyCheckpoint(), id: 'c1' }, { source: 'input' }, {});
      await saver.putWrites(written, [['value', 'first']], 'task', 'z');
      await saver.putWrites(written, [['value', 'second']], 'task', 'z');
      await saver.putWrites(written, [['__interrupt__', 'old']], 'task', 'z');
      await saver.putWrites(written, [['__interrupt__', 'new']], 'task', 'z');
      await saver.putWrites(written, [['value', 'earlier']], 'other', 'a');
      expect((await saver.getTuple(written)).pendingWrites).toEqual([
        ['other', 'value', 'earlier'], ['task', '__interrupt__', 'new'], ['task', 'value', 'first'],
      ]);
      await expect(saver.putWrites(written, [['value', 'x']], 'invalid\ud800')).rejects.toThrow('invalid Unicode');
    } finally { saver.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('lists without an implicit limit and applies filter and before before limiting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-checkpoint-list-'));
    const saver = new SqliteCheckpointSaver(join(dir, 'checkpoint.sqlite'));
    try {
      const config = { configurable: { thread_id: 't' } };
      for (let i = 0; i < 102; i++) await saver.put(config, { ...emptyCheckpoint(), id: String(i).padStart(3, '0') }, { kind: i % 2 ? 'odd' : 'even' }, {});
      const all = []; for await (const row of saver.list(config)) all.push(row);
      expect(all).toHaveLength(102);
      const filtered = []; for await (const row of saver.list(config, { before: { configurable: { checkpoint_id: '100' } }, filter: { kind: 'even' }, limit: 2 })) filtered.push(row.checkpoint.id);
      expect(filtered).toEqual(['098', '096']);
    } finally { saver.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses older checkpoint versions instead of silently dropping migration data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-checkpoint-version-'));
    const saver = new SqliteCheckpointSaver(join(dir, 'checkpoint.sqlite'));
    try {
      const config = await saver.put({ configurable: { thread_id: 't' } }, { ...emptyCheckpoint(), v: 3, id: 'old' }, {}, {});
      await expect(saver.getTuple(config)).rejects.toThrow('migration required');
    } finally { saver.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
