import { setTimeout as sleep } from 'node:timers/promises';
import type { AudioClip, SpeechBackend } from './types.ts';

export interface FeiyuOptions {
  baseUrl: string; apiKey: string; voice?: string; style?: string;
  pollMs?: number; jobTimeoutMs?: number; requestTimeoutMs?: number; maxAudioBytes?: number;
  fetch?: typeof globalThis.fetch;
}

/** Reads RIFF metadata without deriving word timing from duration. */
export function wavDuration(wav: Uint8Array): number {
  const bytes = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV');
  let rate = 0, dataBytes = 0;
  for (let i = 12; i + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(i + 4), end = i + 8 + size;
    if (end > bytes.length) throw new Error('Truncated WAV');
    const kind = bytes.toString('ascii', i, i + 4);
    if (kind === 'fmt ' && size >= 16) rate = bytes.readUInt32LE(i + 16);
    if (kind === 'data') dataBytes += size;
    i = end + (size % 2);
  }
  if (!rate || !dataBytes) throw new Error('Missing WAV audio');
  return dataBytes / rate * 1000;
}

export class FeiyuBackend implements SpeechBackend {
  private readonly base: URL;
  constructor(private readonly options: FeiyuOptions) {
    this.base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error('Invalid voice service URL');
    if (!options.apiKey) throw new Error('Missing voice service key');
    for (const n of [options.pollMs ?? 250, options.jobTimeoutMs ?? 1_800_000, options.requestTimeoutMs ?? 30_000, options.maxAudioBytes ?? 128 * 1024 ** 2]) if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid voice service limits');
  }
  async synthesize(text: string, signal: AbortSignal): Promise<AudioClip> {
    const length = Array.from(text).length;
    if (!text.trim() || length > 2000) throw new Error('Speech text must contain 1–2000 characters');
    const deadline = AbortSignal.timeout(this.options.jobTimeoutMs ?? 1_800_000);
    const jobSignal = AbortSignal.any([signal, deadline]);
    const submitted = await this.json('/v1/speech', { method: 'POST', body: JSON.stringify({ voice: this.options.voice ?? 'feiyu', style: this.options.style ?? 'cute', text }) }, jobSignal);
    const id = submitted.id;
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid job identifier');
    for (;;) {
      const job = await this.json(`/v1/jobs/${id}`, {}, jobSignal);
      if (job.status === 'success') break;
      if (job.status === 'failed' || job.status === 'interrupted') throw new Error(`Voice job ${job.status}`);
      if (job.status !== 'queued' && job.status !== 'running') throw new Error('Unknown voice job status');
      await sleep(this.options.pollMs ?? 250, undefined, { signal: jobSignal });
    }
    const response = await this.request(`/v1/jobs/${id}/audio`, {}, jobSignal);
    const max = this.options.maxAudioBytes ?? 128 * 1024 ** 2, chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body) throw new Error('Empty voice audio');
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new Error('Voice audio exceeds limit');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    const wav = Buffer.concat(chunks, size);
    return { wav, durationMs: wavDuration(wav) };
  }
  private async json(path: string, init: RequestInit, signal: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(path, init, signal);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid voice response');
    return value as Record<string, unknown>;
  }
  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await (this.options.fetch ?? globalThis.fetch)(new URL(path, this.base), { ...init, redirect: 'error', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Voice service HTTP ${response.status}`); }
    return response;
  }
}
