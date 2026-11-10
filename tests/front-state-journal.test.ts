import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrontStateJournal } from '../core/runtime/front-state-journal.ts';

describe('durable front state', () => {
  it('records terminal state and turns an interrupted processing row into unknown on reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-front-journal-'));
    const file = join(dir, 'front.sqlite');
    const first = new FrontStateJournal(file);
    first.begin([4, 5]);
    expect(first.read()).toEqual({ state: 'processing', inputCursors: [4, 5], updatedAt: expect.any(String) });
    first.close();

    const recovered = new FrontStateJournal(file);
    expect(recovered.recover()).toBeUndefined();
    expect(recovered.read()).toBeUndefined();
    expect(recovered.recoveryCount()).toBe(1);
    recovered.begin([6]);
    recovered.failed([6], 'provider stopped');
    expect(recovered.read()).toEqual({ state: 'failed', inputCursors: [6], error: 'provider stopped', updatedAt: expect.any(String) });
    recovered.close();

    const nextHost = new FrontStateJournal(file);
    expect(nextHost.recover()).toBeUndefined();
    expect(nextHost.read()).toBeUndefined();
    expect(nextHost.recoveryCount()).toBe(2);
    nextHost.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deduplicates cursors and rejects invalid cursors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-front-journal-invalid-'));
    const journal = new FrontStateJournal(join(dir, 'front.sqlite'));
    try {
      journal.begin([3, 3]);
      expect(journal.read()?.inputCursors).toEqual([3]);
      expect(() => journal.begin([0])).toThrow('invalid input cursor');
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
