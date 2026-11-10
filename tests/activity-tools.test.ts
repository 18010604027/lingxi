import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readToolActivity } from '../core/runtime/activity-tools.ts';
import { readCombinedActivity } from '../core/runtime/activity.ts';

describe('safe tool activity reader', () => {
  it('waits for complete lines and detects rotation without leaking args or receipts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-activity-tools-'));
    const file = join(dir, 'toolcalls.jsonl');
    try {
      const row = JSON.stringify({ run: 'run1', tool: 'pet_act', call: 'call-1', ts: '2026-01-01', args: { token: 'secret' }, receipt: 'private-file' });
      writeFileSync(file, row.slice(0, 20));
      const half = readToolActivity(file, 'run1', undefined, 10);
      expect(half.items).toEqual([]); expect(half.cursor.offset).toBe(0);
      appendFileSync(file, row.slice(20) + '\n');
      const full = readToolActivity(file, 'run1', half.cursor, 10);
      expect(full.items).toEqual([expect.objectContaining({ summary: '身体动作', callId: 'call-1', state: 'returned' })]);
      expect(JSON.stringify(full)).not.toMatch(/secret|private-file/);
      renameSync(file, join(dir, 'old.jsonl')); writeFileSync(file, row + '\n');
      expect(readToolActivity(file, 'run1', full.cursor, 10)).toMatchObject({ reset: true, status: 'partial' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('advances event and tool cursors independently across limited pages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lingxi-activity-combined-'));
    const file = join(dir, 'toolcalls.jsonl');
    try {
      writeFileSync(file, JSON.stringify({ run: 'r', tool: 'pet_act', call: 'c1', ts: '2026-01-01T00:00:00Z', args: { token: 'hidden' } }) + '\n');
      const store = { latestCursor: () => 1, range: ({ fromCursor, toCursor }: any) => fromCursor <= 1 && toCursor >= 1 ? [{ cursor: 1, ts: '2026-01-01T00:00:00Z', source: 'pet', type: 'pet.action', meta: { action: 'walk', state: 'submitted', actionId: '12345678-1234-1234-1234-123456789abc' } }] : [] } as never;
      const first = readCombinedActivity(store, { file, runId: 'r' }, undefined, 1);
      expect(first.items[0]).toMatchObject({ kind: 'body-motion', summary: '走路', state: 'submitted' });
      expect(first.hasMore).toBe(true);
      const next = readCombinedActivity(store, { file, runId: 'r' }, first.cursor, 1);
      expect(next.items[0]).toMatchObject({ kind: 'tool', callId: 'c1' });
      expect(next.hasMore).toBe(false); expect(JSON.stringify(next)).not.toContain('hidden');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('projects an unconfirmed body action instead of dropping its disconnect state', () => {
    const store = { latestCursor: () => 1, range: () => [{ cursor: 1, ts: '2026-01-01T00:00:00Z', source: 'pet', type: 'pet.action', meta: { action: 'walk', state: 'unknown', actionId: '12345678-1234-1234-1234-123456789abc' } }] } as never;
    const page = readCombinedActivity(store, { file: join(tmpdir(), 'missing-toolcalls.jsonl'), runId: 'r' }, undefined, 10);
    expect(page.items[0]).toMatchObject({ kind: 'body-motion', summary: '走路', state: 'unknown', actionId: '12345678-1234-1234-1234-123456789abc' });
  });
  it('projects an action start from the next event cursor without a chat delivery', () => {
    const events: Array<Record<string, unknown>> = [];
    const store = {
      latestCursor: () => events.length,
      range: ({ fromCursor, toCursor }: { fromCursor: number; toCursor: number }) => events.filter((event) => Number(event.cursor) >= fromCursor && Number(event.cursor) <= toCursor),
    } as never;
    const options = { file: join(tmpdir(), 'missing-toolcalls.jsonl'), runId: 'r' };
    const initial = readCombinedActivity(store, options);
    events.push({ cursor: 1, ts: '2026-01-01T00:00:01Z', source: 'pet', type: 'pet.action', origin: 'internal', contextDelivery: 'archive-only', meta: { action: 'run', state: 'started', actionId: '12345678-1234-1234-1234-123456789abc' } });
    const started = readCombinedActivity(store, options, initial.cursor);
    expect(started.items).toEqual([expect.objectContaining({ kind: 'body-motion', summary: '跑步', state: 'started', actionId: '12345678-1234-1234-1234-123456789abc' })]);
    expect(started.cursor).not.toBe(initial.cursor);
  });
});
