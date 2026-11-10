import { describe, expect, it } from 'vitest';
import { readActivity } from '../core/runtime/activity.ts';

describe('read-only activity projection', () => {
  it('pages whitelisted facts and does not expose source content', () => {
    const events = [
      { cursor: 1, ts: 'time-1', source: 'pet', type: 'pet.moved', text: 'secret-file-content', meta: { token: 'secret-token' } },
      { cursor: 2, ts: 'time-2', source: 'pet', type: 'pet.output.receipt', text: 'secret-speech', meta: { state: 'completed', outputId: 'm:0', token: 'secret-token' } },
    ];
    const store = { latestCursor: () => 2, range: ({ fromCursor, toCursor }: any) => events.filter((e) => e.cursor >= fromCursor && e.cursor <= toCursor) } as never;
    const first = readActivity(store, undefined, 1);
    expect(first.items).toHaveLength(1); expect(first.hasMore).toBe(true);
    const second = readActivity(store, first.cursor, 1);
    expect(second.items[0]).toMatchObject({ role: 'output', kind: 'output-receipt', state: 'completed', outputId: 'm:0' });
    expect(second.hasMore).toBe(false);
    expect(JSON.stringify([first, second])).not.toContain('secret');
  });
  it('reports missing source positions without advancing over them', () => {
    const store = { latestCursor: () => 2, range: () => [{ cursor: 2, ts: 'x', source: 'pet', type: 'pet.moved' }] } as never;
    const page = readActivity(store);
    expect(page).toMatchObject({ reset: true, hasMore: false, items: [] });
    expect(page.sources[0].status).toBe('partial');
    expect(() => readActivity(store, 'bad')).toThrow('invalid activity cursor');
  });
  it('reports an unreadable source without discarding the prior cursor', () => {
    const first = readActivity({ latestCursor: () => 1, range: () => [{ cursor: 1, ts: 'x', source: 'pet', type: 'pet.moved' }] } as never);
    const failing = { latestCursor: () => 2, range: () => { throw new Error('private disk path'); } } as never;
    const page = readActivity(failing, first.cursor);
    expect(page).toMatchObject({ available: false, cursor: first.cursor, hasMore: false });
    expect(page.sources[0].status).toBe('unavailable');
    expect(JSON.stringify(page)).not.toContain('private disk path');
  });
  it('projects completed playback and petting receipts without leaking event text', () => {
    const events = [
      { cursor: 1, ts: 'time-1', source: 'pet', type: 'pet.action', text: '', meta: { action: 'wave', state: 'completed', actionId: '12345678-1234-1234-1234-123456789abc', clip: 'wave.webm' } },
      { cursor: 2, ts: 'time-2', source: 'pet', type: 'pet.interaction', text: 'private', meta: { kind: 'pet', state: 'started', interactionId: '12345678-1234-1234-1234-123456789def', x: 0.5 } },
    ];
    const store = { latestCursor: () => 2, range: ({ fromCursor, toCursor }: any) => events.filter((event) => event.cursor >= fromCursor && event.cursor <= toCursor) } as never;
    const page = readActivity(store);
    expect(page.items).toMatchObject([
      { kind: 'body-motion', state: 'completed', actionId: '12345678-1234-1234-1234-123456789abc' },
      { kind: 'body-interaction', summary: '正在抚摸身体', state: 'started', interactionId: '12345678-1234-1234-1234-123456789def' },
    ]);
    expect(JSON.stringify(page)).not.toContain('wave.webm');
    expect(JSON.stringify(page)).not.toContain('private');
  });
});
