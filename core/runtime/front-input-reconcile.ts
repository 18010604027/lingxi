/** Experimental input reconciliation. The caller must provide exclusive ownership of the graph thread. */
import type { FrontInputBatch, FrontInputJournal, PreparedFrontInput } from './front-input-journal.ts';

export interface FrontInputCheckpointPort {
  /** Return undefined only when a successful checkpoint read proves this batch is absent. */
  read(threadId: string, batchId: string): Promise<string | undefined>;
  /** Persist the materialized batch before any model or tool execution. */
  write(input: PreparedFrontInput): Promise<void>;
  /** Whether a previously saved graph node must run before another batch can be staged. */
  pending?(threadId: string): Promise<boolean>;
}

export async function reconcileFrontInput(journal: FrontInputJournal, graph: FrontInputCheckpointPort,
  batch: FrontInputBatch): Promise<PreparedFrontInput> {
  const prepared = journal.prepare(batch);
  let fingerprint = await graph.read(batch.threadId, batch.batchId);
  if (fingerprint === undefined) {
    if (prepared.state === 'accepted') throw new Error('accepted front input is missing from checkpoint');
    await graph.write(prepared);
    fingerprint = await graph.read(batch.threadId, batch.batchId);
  }
  if (fingerprint !== prepared.fingerprint) throw new Error('front input checkpoint identity mismatch');
  journal.accept(batch.threadId, batch.batchId, fingerprint);
  return journal.get(batch.threadId, batch.batchId)!;
}

export interface FrontCursorPort {
  latest(): number;
  /** True only when this stored cursor must appear in a front input batch. */
  requiresInput(cursor: number): boolean;
}

export interface FrontWatermarkPort {
  current(): number;
  advance(cursor: number): Promise<void>;
}

/** Reconcile every durable batch first, then advance only over a proven contiguous prefix. */
export async function reconcileFrontInputs(journal: FrontInputJournal, graph: FrontInputCheckpointPort,
  cursors: FrontCursorPort, watermark: FrontWatermarkPort, threadId: string,
  options: { stageMissing?: boolean } = {}): Promise<{ accepted: number; watermark: number }> {
  const batches = journal.list(threadId);
  const latest = cursors.latest();
  let next = watermark.current();
  let accepted = 0;
  const verified = new Set<string>();

  for (const input of batches) {
    if (input.batch.cursors.length === 0) {
      const checkpoint = await graph.read(threadId, input.batch.batchId);
      if (checkpoint === undefined && input.state === 'prepared' && options.stageMissing === false) continue;
      if (checkpoint === undefined && await graph.pending?.(threadId)) break;
      await reconcileFrontInput(journal, graph, input.batch);
      accepted++;
      verified.add(input.batch.batchId);
      if (checkpoint === undefined || await graph.pending?.(threadId)) break;
      continue;
    }
    const last = input.batch.cursors.at(-1)!;
    if (last <= next) {
      // An already-watermarked batch is historical; verify identity but do not restage it.
      if (input.state !== 'accepted') throw new Error('watermarked front input is not accepted');
      const stored = await graph.read(threadId, input.batch.batchId);
      if (stored !== input.fingerprint) throw new Error('watermarked front input does not match checkpoint');
      verified.add(input.batch.batchId);
      continue;
    }
    if (input.batch.cursors[0] <= next && input.state !== 'accepted') {
      throw new Error('partially watermarked front input is not accepted');
    }

    // Do not stage a later batch while an earlier required event lacks ownership.
    let contiguous = true;
    for (let cursor = next + 1; cursor <= last; cursor++) {
      if (!cursors.requiresInput(cursor)) continue;
      if (journal.batchForCursor(threadId, cursor) !== input.batch.batchId) { contiguous = false; break; }
    }
    if (!contiguous) break;

    const checkpoint = await graph.read(threadId, input.batch.batchId);
    if (checkpoint === undefined && input.state === 'prepared' && options.stageMissing === false) break;
    if (checkpoint === undefined && await graph.pending?.(threadId)) break;
    await reconcileFrontInput(journal, graph, input.batch);
    accepted++;
    verified.add(input.batch.batchId);
    next = last;
    // A new checkpoint may now have a pending node. Resume it before staging a later batch.
    if (checkpoint === undefined || await graph.pending?.(threadId)) break;
  }

  // Move only through the prefix whose complete input batches were read back.
  let prefix = watermark.current();
  for (let cursor = prefix + 1; cursor <= latest; cursor++) {
    if (!cursors.requiresInput(cursor)) { prefix = cursor; continue; }
    const batchId = journal.batchForCursor(threadId, cursor);
    const batch = batchId ? journal.get(threadId, batchId) : undefined;
    if (!batchId || !batch || batch.state !== 'accepted' || !verified.has(batchId)) break;
    prefix = cursor;
  }
  if (prefix > watermark.current()) await watermark.advance(prefix);
  return { accepted, watermark: prefix };
}
