import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrontToolJournal } from '../core/runtime/front-tool-journal.ts';

describe('front tool execution journal', () => {
  it('preserves completed receipts and makes unfinished executions unknown across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-tool-journal-'));
    const file = join(dir, 'journal.sqlite');
    let journal = new FrontToolJournal(file);
    try {
      expect(journal.begin('thread', 'done', 'act', { b: 2, a: 1 })).toEqual({ state: 'started' });
      journal.complete('thread', 'done', { text: 'executed', failed: false });
      expect(journal.begin('thread', 'pending', 'act', { a: 1 })).toEqual({ state: 'started' });
      journal.close();
      journal = new FrontToolJournal(file);
      expect(journal.begin('thread', 'done', 'act', { a: 1, b: 2 })).toEqual({ state: 'completed', receipt: { text: 'executed', failed: false } });
      expect(journal.begin('thread', 'pending', 'act', { a: 1 })).toEqual({ state: 'unknown' });
      expect(() => journal.begin('thread', 'done', 'act', { a: 3 })).toThrow('identity conflicts');
      expect(() => journal.complete('thread', 'done', { text: 'again', failed: false })).toThrow('not awaiting');
      expect(journal.begin('other-thread', 'pending', 'act', { a: 1 })).toEqual({ state: 'started' });
    } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
