import { describe, expect, it } from 'vitest';
import { FeiyuBackend, wavDuration } from '../src/feiyu.ts';
import { wav } from './fakes.ts';

describe('HTTP job backend with a local transport fake', () => {
  it('submits, polls, and downloads only the known same-origin audio route', async () => {
    const paths: string[] = [], payloads: unknown[] = []; let poll = 0;
    const backend = new FeiyuBackend({ baseUrl: 'http://voice.invalid', apiKey: 'test-key', pollMs: 1,
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname; paths.push(path);
        if (init?.body) payloads.push(JSON.parse(String(init.body)));
        if (path === '/v1/speech') return Response.json({ id: 'a'.repeat(32) });
        if (path.endsWith('/audio')) return new Response(Uint8Array.from(wav()).buffer);
        return Response.json({ status: ++poll === 1 ? 'running' : 'success', audio_url: 'http://elsewhere.invalid/private' });
      } });
    const result = await backend.synthesize('短句。', new AbortController().signal);
    expect(result.durationMs).toBe(10); expect(result.marks).toBeUndefined();
    expect(payloads).toEqual([{ voice: 'feiyu', style: 'cute', text: '短句。' }]);
    expect(paths).toEqual(['/v1/speech', `/v1/jobs/${'a'.repeat(32)}`, `/v1/jobs/${'a'.repeat(32)}`, `/v1/jobs/${'a'.repeat(32)}/audio`]);
  });
  it('reports an unavailable service without retrying a submitted job', async () => {
    const backend = new FeiyuBackend({ baseUrl: 'http://voice.invalid', apiKey: 'test-key', fetch: async () => { throw new Error('Connection refused'); } });
    await expect(backend.synthesize('一句。', new AbortController().signal)).rejects.toThrow('Connection refused');
  });
  it('rejects failed jobs, invalid identifiers, and oversized or malformed audio', async () => {
    for (const mode of ['job-failed', 'bad-id', 'too-large', 'bad-audio']) {
      const backend = new FeiyuBackend({ baseUrl: 'http://voice.invalid', apiKey: 'test-key', maxAudioBytes: mode === 'too-large' ? 20 : 1000, fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/speech') return Response.json({ id: mode === 'bad-id' ? '../other' : 'b'.repeat(32) });
        if (path.endsWith('/audio')) return new Response(Uint8Array.from(mode === 'bad-audio' ? [0] : wav()).buffer);
        return Response.json({ status: mode === 'job-failed' ? 'failed' : 'success' });
      } });
      await expect(backend.synthesize('测试。', new AbortController().signal), mode).rejects.toThrow();
    }
    expect(() => wavDuration(wav().subarray(0, 50))).toThrow('Truncated WAV');
  });
  it('bounds job polling and does not claim remote inference was cancelled', async () => {
    const backend = new FeiyuBackend({ baseUrl: 'http://voice.invalid', apiKey: 'test-key', pollMs: 2, jobTimeoutMs: 20, fetch: async url => Response.json(new URL(String(url)).pathname === '/v1/speech' ? { id: 'c'.repeat(32) } : { status: 'queued' }) });
    await expect(backend.synthesize('等待。', new AbortController().signal)).rejects.toThrow();
  });
});
