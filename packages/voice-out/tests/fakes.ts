import { deferred } from '../src/async.ts';
import type { AudioClip, AudioPlayer, OutputDevices, OutputEndpoint, SpeechBackend } from '../src/types.ts';

export const clip = (marks?: AudioClip['marks']): AudioClip => ({ wav: new Uint8Array([1]), durationMs: 1000, marks });
export class FakeDevices implements OutputDevices {
  endpoint: OutputEndpoint | null = { id: 'private-output', formFactor: 3, revision: 1 };
  listeners = new Set<() => void>();
  async current() { return this.endpoint; }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  change(id: string, formFactor: number | null) {
    this.endpoint = { id, formFactor, revision: (this.endpoint?.revision ?? 0) + 1 };
    for (const listener of this.listeners) listener();
  }
}
export class FakeBackend implements SpeechBackend {
  calls: Array<{ text: string; signal: AbortSignal; response: ReturnType<typeof deferred<AudioClip>> }> = [];
  synthesize(text: string, signal: AbortSignal) {
    const response = deferred<AudioClip>();
    this.calls.push({ text, signal, response });
    return response.promise;
  }
}
export class FakePlayer implements AudioPlayer {
  plays: Array<{ endpointId: string; progress: (ms: number) => void; completion: ReturnType<typeof deferred<void>>; stopped: boolean; playedMs: number }> = [];
  start(_clip: AudioClip, endpointId: string, progress: (ms: number) => void) {
    const play = { endpointId, progress, completion: deferred<void>(), stopped: false, playedMs: 0 };
    this.plays.push(play);
    return { finished: play.completion.promise, stop: async () => { play.stopped = true; play.completion.resolve(); return { playedMs: play.playedMs }; } };
  }
  advance(index: number, ms: number) { this.plays[index]!.playedMs = ms; this.plays[index]!.progress(ms); }
  finish(index: number) { this.plays[index]!.completion.resolve(); }
}

export function wav(): Uint8Array {
  const data = Buffer.alloc(44 + 160);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(160, 40);
  return data;
}
