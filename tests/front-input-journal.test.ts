import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrontInputJournal } from '../core/runtime/front-input-journal.ts';

describe('front input reconciliation journal', () => {
  it('persists a monotonic graph-output projection cursor and rejects stale advances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-graph-projection-cursor-'));
    const file = join(dir, 'input.sqlite');
    let journal = new FrontInputJournal(file);
    try {
      expect(journal.graphProjectionIndex('thread')).toBe(0);
      journal.advanceGraphProjection('thread', 0, 3);
      expect(() => journal.advanceGraphProjection('thread', 0, 4)).toThrow('cursor changed');
      journal.close(); journal = new FrontInputJournal(file);
      expect(journal.graphProjectionIndex('thread')).toBe(3);
      expect(() => journal.advanceGraphProjection('thread', 4, 5)).toThrow('cursor changed');
      expect(() => journal.advanceGraphProjection('thread', 3, 2)).toThrow('invalid graph projection cursor');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a pre-hook claim unknown after restart unless the exact materialized input was saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-materialization-'));
    const file = join(dir, 'input.sqlite');
    let journal = new FrontInputJournal(file);
    try {
      expect(journal.claimMaterialization('thread', 'batch-1', [4, 5]).state).toBe('materializing');
      journal.close(); journal = new FrontInputJournal(file);
      expect(journal.claimMaterialization('thread', 'batch-1', [4, 5]).state).toBe('unknown');
      expect(() => journal.completeMaterialization({ threadId: 'thread', batchId: 'batch-1', cursors: [4, 5], records: [] }))
        .toThrow('not claimed');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reuses the exact prepared material after a crash before receipt state update', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-materialization-prepared-'));
    const file = join(dir, 'input.sqlite');
    let journal = new FrontInputJournal(file);
    try {
      journal.claimMaterialization('thread', 'batch-1', [4, 5]);
      const saved = journal.prepare({ threadId: 'thread', batchId: 'batch-1', cursors: [4, 5], records: [{ text: 'fixed' }] });
      journal.close(); journal = new FrontInputJournal(file);
      expect(journal.claimMaterialization('thread', 'batch-1', [4, 5])).toMatchObject({ state: 'materialized' });
      expect(journal.get('thread', 'batch-1')).toEqual(saved);
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('saves exact records under a claim before graph checkpointing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-materialization-complete-'));
    const file = join(dir, 'input.sqlite');
    const journal = new FrontInputJournal(file);
    try {
      journal.claimMaterialization('thread', 'batch-1', [4]);
      const input = journal.completeMaterialization({ threadId: 'thread', batchId: 'batch-1', cursors: [4], records: [{ text: 'fixed' }] });
      expect(input.state).toBe('prepared');
      expect(journal.getMaterialization('thread', 'batch-1')?.state).toBe('materialized');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('persists deferred-only graph input without inventing an EventStore cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-materialization-deferred-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    try {
      journal.claimMaterialization('thread', 'deferred-batch', []);
      const input = journal.completeMaterialization({ threadId: 'thread', batchId: 'deferred-batch', cursors: [],
        records: [{ text: 'rendered later' }], deliveryCursors: [9] });
      expect(input.batch.cursors).toEqual([]);
      expect(input.batch.deliveryCursors).toEqual([9]);
      expect(journal.list('thread')).toHaveLength(1);
      expect(journal.getMaterialization('thread', 'deferred-batch')?.state).toBe('materialized');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('reopens prepared input, accepts only the matching checkpoint, and rejects conflicts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-journal-'));
    const file = join(dir, 'input.sqlite');
    let journal = new FrontInputJournal(file);
    try {
      const batch = { threadId: 'thread', batchId: 'batch-1', cursors: [4, 5], records: [{ text: 'hello' }] };
      const prepared = journal.prepare(batch);
      expect(prepared.state).toBe('prepared');
      journal.close(); journal = new FrontInputJournal(file);
      expect(journal.get('thread', 'batch-1')).toMatchObject({ state: 'prepared', fingerprint: prepared.fingerprint });
      journal.accept('thread', 'batch-1', prepared.fingerprint);
      expect(journal.get('thread', 'batch-1')?.state).toBe('accepted');
      expect(() => journal.prepare({ ...batch, records: [{ text: 'changed' }] })).toThrow('identity conflict');
      expect(() => journal.accept('thread', 'batch-1', 'wrong')).toThrow('does not match');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects malformed or duplicate cursors before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-journal-invalid-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    try {
      expect(() => journal.prepare({ threadId: 't', batchId: 'b', cursors: [1, 1], records: [] })).toThrow('invalid');
      expect(() => journal.prepare({ threadId: 't', batchId: 'b', cursors: [0], records: [] })).toThrow('invalid');
      expect(() => journal.prepare({ threadId: 't', batchId: 'b', cursors: [1], records: [{ text: undefined }] })).toThrow('not JSON-safe');
      journal.prepare({ threadId: 't', batchId: 'b', cursors: [1], records: [{ text: 'first' }] });
      expect(() => journal.prepare({ threadId: 't', batchId: 'other', cursors: [1], records: [{ text: 'duplicate cursor' }] }))
        .toThrow('already belongs to another batch');
      expect(() => journal.prepare({ threadId: 'other-thread', batchId: 'b', cursors: [1], records: [{ text: 'duplicate thread cursor' }] }))
        .toThrow('already belongs to another batch or thread');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
