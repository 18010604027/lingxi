import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const { call } = createRequire(import.meta.url)('../workbench/bridge.cjs') as {
  call(access: { port: number; token: string }, operation: string, body?: unknown, fetcher?: typeof fetch): Promise<unknown>;
};

describe('standalone workbench bridge', () => {
  it('uses the fixed local endpoint and carries the token outside the renderer', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ delivered: true }), { status: 200 }));
    const access = { port: 4317, token: 'x'.repeat(48) };
    expect(await call(access, 'say', { text: '你好' }, fetcher as typeof fetch)).toEqual({ delivered: true });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4317/lingxi/say', expect.objectContaining({ method: 'POST', redirect: 'error', body: '{"text":"你好"}' }));
  });

  it('encodes the opaque activity cursor only in the fixed route', async () => {
    const fetcher = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    const access = { port: 4317, token: 'x'.repeat(48) };
    await call(access, 'activity', { cursor: 'opaque&next=/other', limit: 10 }, fetcher as typeof fetch);
    expect(fetcher.mock.calls[0]![0]).toBe('http://127.0.0.1:4317/lingxi/activity?cursor=opaque%26next%3D%2Fother&limit=10');
    await expect(call(access, 'activity', { cursor: 5 }, fetcher as typeof fetch)).rejects.toThrow('Invalid activity');
  });

  it('rejects unknown routes and invalid access without making a request', async () => {
    const fetcher = vi.fn();
    await expect(call({ port: 4317, token: 'x'.repeat(48) }, 'http://example.com', {}, fetcher)).rejects.toThrow('Unknown operation');
    await expect(call({ port: 0, token: 'x' }, 'status', {}, fetcher)).rejects.toThrow('Invalid local API access');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('sends only a validated integer cursor to the fixed incremental route', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const access = { port: 4317, token: 'x'.repeat(48) };
    await call(access, 'historySince', { after: 12 }, fetcher as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4317/lingxi/history-since?after=12', expect.anything());
    await expect(call(access, 'historySince', { after: '12&x=1' }, fetcher as typeof fetch)).rejects.toThrow('Invalid cursor');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
