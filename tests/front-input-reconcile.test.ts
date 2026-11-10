import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrontInputJournal } from '../core/runtime/front-input-journal.ts';
import { reconcileFrontInput, reconcileFrontInputs } from '../core/runtime/front-input-reconcile.ts';

describe('front input checkpoint reconciliation', () => {
  it('writes an absent batch once and accepts it only after readback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-reconcile-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    const saved = new Map<string, string>(); let writes = 0;
    const graph = { read: async (_t: string, b: string) => saved.get(b), write: async (input: any) => { writes++; saved.set(input.batch.batchId, input.fingerprint); } };
    try {
      const batch = { threadId: 't', batchId: 'b', cursors: [1], records: [{ text: 'x' }] };
      expect((await reconcileFrontInput(journal, graph, batch)).state).toBe('accepted');
      expect(writes).toBe(1);
      expect((await reconcileFrontInput(journal, graph, batch)).state).toBe('accepted');
      expect(writes).toBe(1);
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('stops when an accepted batch has disappeared or checkpoint identity conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-reconcile-fail-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    try {
      const batch = { threadId: 't', batchId: 'b', cursors: [1], records: [{ text: 'x' }] };
      const prepared = journal.prepare(batch); journal.accept('t', 'b', prepared.fingerprint);
      await expect(reconcileFrontInput(journal, { read: async () => undefined, write: async () => {} }, batch)).rejects.toThrow('missing');
      const other = new FrontInputJournal(join(dir, 'other.sqlite'));
      try { await expect(reconcileFrontInput(other, { read: async () => 'wrong', write: async () => {} }, { ...batch, batchId: 'new' })).rejects.toThrow('mismatch'); }
      finally { other.close(); }
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts a checkpoint committed before a lost acknowledgement without writing it twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-lost-ack-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    const saved = new Map<string, string>(); let writes = 0;
    const graph = { read: async (_t: string, id: string) => saved.get(id), write: async (input: any) => {
      writes++; saved.set(input.batch.batchId, input.fingerprint);
      if (writes === 1) throw new Error('process exited after checkpoint commit');
    } };
    try {
      const batch = { threadId: 't', batchId: 'b', cursors: [1], records: [{ text: 'x' }] };
      await expect(reconcileFrontInput(journal, graph, batch)).rejects.toThrow('after checkpoint commit');
      expect(journal.get('t', 'b')?.state).toBe('prepared');
      expect((await reconcileFrontInput(journal, graph, batch)).state).toBe('accepted');
      expect(writes).toBe(1);
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('never advances the watermark across a required cursor without an accepted input owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-input-watermark-'));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    const saved = new Map<string, string>();
    const graph = { read: async (_t: string, id: string) => saved.get(id), write: async (input: any) => { saved.set(input.batch.batchId, input.fingerprint); } };
    let current = 0;
    const watermark = { current: () => current, advance: async (cursor: number) => { current = cursor; } };
    const cursors = { latest: () => 3, requiresInput: () => true };
    try {
      for (const [id, cursor] of [['a', 1], ['c', 3]] as const) {
        const batch = { threadId: 't', batchId: id, cursors: [cursor], records: [{ text: id }] };
        const prepared = journal.prepare(batch);
        saved.set(id, prepared.fingerprint);
      }
      expect(await reconcileFrontInputs(journal, graph, cursors, watermark, 't')).toEqual({ accepted: 1, watermark: 1 });
      expect(current).toBe(1);
      expect(journal.get('t', 'c')?.state).toBe('prepared');

      const middle = { threadId: 't', batchId: 'b', cursors: [2], records: [{ text: 'b' }] };
      const prepared = journal.prepare(middle);
      saved.set('b', prepared.fingerprint);
      expect(await reconcileFrontInputs(journal, graph, cursors, watermark, 't')).toEqual({ accepted: 2, watermark: 3 });
      expect(current).toBe(3);
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['before-commit', 'after-commit'] as const)('recovers a watermark interruption %s without restaging the batch', async (stage) => {
    const dir = mkdtempSync(join(tmpdir(), `lingxi-input-watermark-${stage}-`));
    const journal = new FrontInputJournal(join(dir, 'input.sqlite'));
    const saved = new Map<string, string>(); let writes = 0; let current = 0; let interrupted = false;
    const graph = { read: async (_t: string, id: string) => saved.get(id), write: async (input: any) => { writes++; saved.set(input.batch.batchId, input.fingerprint); } };
    const watermark = { current: () => current, advance: async (cursor: number) => {
      if (!interrupted && stage === 'before-commit') { interrupted = true; throw new Error('exit before watermark commit'); }
      current = cursor;
      if (!interrupted && stage === 'after-commit') { interrupted = true; throw new Error('exit after watermark commit'); }
    } };
    const cursors = { latest: () => 1, requiresInput: () => true };
    try {
      const batch = { threadId: 't', batchId: 'b', cursors: [1], records: [{ text: 'x' }] };
      journal.prepare(batch);
      await expect(reconcileFrontInputs(journal, graph, cursors, watermark, 't')).rejects.toThrow('watermark commit');
      expect(journal.get('t', 'b')?.state).toBe('accepted');
      expect(await reconcileFrontInputs(journal, graph, cursors, watermark, 't')).toEqual({ accepted: stage === 'before-commit' ? 1 : 0, watermark: 1 });
      expect(writes).toBe(1);
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
