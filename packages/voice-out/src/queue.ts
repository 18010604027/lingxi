import { randomUUID } from 'node:crypto';
import { abortable, deadline, deferred } from './async.ts';
import { OutputGuard, type OutputPermit } from './output-guard.ts';
import { splitSentences } from './sentences.ts';
import type { AudioClip, AudioPlayer, HeardReceipt, OutputDevices, Playback, Sentence, SpeechBackend, SpeechHandle, SpeechResult, SpeechState } from './types.ts';

export interface VoiceQueueOptions {
  backend: SpeechBackend;
  player: AudioPlayer;
  devices: OutputDevices;
  prefetch?: number;
  synthesisTimeoutMs?: number;
}
interface Request {
  id: string; text: string; sentences: Sentence[]; controller: AbortController; state: SpeechState;
  result: ReturnType<typeof deferred<SpeechResult>>; permission: ReturnType<typeof deferred<OutputPermit>>;
  completed: number; sentenceIndex: number | null; playedMs: number; clip: AudioClip | null; playback: Playback | null;
}

export class VoiceQueue {
  private readonly guard: OutputGuard;
  private readonly queue: Request[] = [];
  private active: Request | null = null;
  private pumping = false;
  private stopped = false;
  private readonly prefetch: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: VoiceQueueOptions) {
    this.prefetch = options.prefetch ?? 2; this.timeoutMs = options.synthesisTimeoutMs ?? 60_000;
    if (!Number.isInteger(this.prefetch) || this.prefetch < 1 || !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('Invalid voice queue limits');
    this.guard = new OutputGuard(options.devices);
    this.guard.subscribe(() => {
      if (this.active && this.active.state.kind !== 'queued') this.active.controller.abort('device-changed');
    });
  }

  enqueue(text: string): SpeechHandle {
    if (this.stopped) throw new Error('Voice queue stopped');
    const request: Request = { id: randomUUID(), text, sentences: splitSentences(text), controller: new AbortController(), state: { kind: 'queued' }, result: deferred(), permission: deferred(), completed: 0, sentenceIndex: null, playedMs: 0, clip: null, playback: null };
    this.queue.push(request);
    queueMicrotask(() => { void this.pump(); });
    return {
      id: request.id, get state() { return request.state; }, done: request.result.promise,
      confirm: async id => {
        if (request.state.kind !== 'confirmation-required' || request.state.challenge?.id !== id || request.controller.signal.aborted) return false;
        const permit = await this.guard.confirm(id, request.id);
        if (!permit || request.controller.signal.aborted) return false;
        request.permission.resolve(permit); return true;
      },
      interrupt: () => {
        request.controller.abort('interrupted');
        const index = this.queue.indexOf(request);
        if (index >= 0) {
          this.queue.splice(index, 1); request.state = { kind: 'finished' };
          request.result.resolve({ kind: 'interrupted', reason: 'interrupted', heard: this.receipt(request) });
        }
        return request.result.promise;
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const requests = [...this.queue, ...(this.active ? [this.active] : [])];
    for (const request of requests) request.controller.abort('stopped');
    await Promise.all(requests.map(r => r.result.promise));
    this.guard.stop();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const request = this.queue.shift()!;
        this.active = request;
        let kind: SpeechResult['kind'] = 'completed', reason: string | undefined;
        try { await this.run(request); }
        catch (error) {
          kind = request.controller.signal.aborted ? 'interrupted' : 'failed';
          reason = String(request.controller.signal.aborted ? request.controller.signal.reason : error instanceof Error ? error.message : error);
        } finally {
          if (request.playback) {
            try { request.playedMs = (await request.playback.stop()).playedMs; }
            catch { kind = 'failed'; reason = 'Player did not confirm that playback stopped'; }
          }
          const heard = this.receipt(request);
          request.controller.abort('finished');
          this.guard.forget(request.id); request.state = { kind: 'finished' };
          request.result.resolve({ kind, reason, heard });
          this.active = null;
        }
      }
    } finally { this.pumping = false; }
  }

  private async run(request: Request): Promise<void> {
    const signal = request.controller.signal;
    signal.throwIfAborted();
    if (!request.sentences.length) return;
    const decision = await this.guard.request(request.id);
    if (decision.kind === 'unavailable') throw new Error('No verified output endpoint');
    let permit: OutputPermit;
    if (decision.kind === 'confirmation-required') {
      request.state = { kind: 'confirmation-required', challenge: decision.challenge };
      permit = await abortable(request.permission.promise, signal);
    } else permit = decision.permit;
    const jobs = new Map<number, Promise<{ clip: AudioClip } | { error: unknown }>>();
    let scheduled = 0;
    const fill = (index: number) => {
      while (!signal.aborted && scheduled < Math.min(request.sentences.length, index + this.prefetch)) {
        const sentence = request.sentences[scheduled]!;
        const leading = Array.from(sentence.text).length - Array.from(sentence.text.trimStart()).length;
        jobs.set(scheduled++, deadline(s => this.options.backend.synthesize(sentence.text.trim(), s), signal, this.timeoutMs)
          .then(clip => ({ clip: { ...clip, marks: clip.marks?.map(mark => ({ ...mark, endCharacter: mark.endCharacter + leading })) } }), error => ({ error })));
      }
    };
    for (let index = 0; index < request.sentences.length; index++) {
      signal.throwIfAborted();
      if (!await this.guard.valid(permit)) { request.controller.abort('device-changed'); signal.throwIfAborted(); }
      request.state = { kind: 'synthesizing' }; fill(index);
      const result = await abortable(jobs.get(index)!, signal);
      jobs.delete(index);
      if ('error' in result) throw result.error;
      signal.throwIfAborted();
      if (!await this.guard.valid(permit)) { request.controller.abort('device-changed'); signal.throwIfAborted(); }
      request.clip = result.clip; request.sentenceIndex = index; request.playedMs = 0;
      request.state = { kind: 'playing' };
      const playback = this.options.player.start(result.clip, permit.endpoint.id, ms => {
        if (request.sentenceIndex === index && request.state.kind === 'playing' && !signal.aborted) request.playedMs = ms;
      });
      request.playback = playback;
      await abortable(playback.finished, signal);
      request.playback = null; request.completed++; request.sentenceIndex = null;
      request.playedMs = 0; request.clip = null;
    }
  }

  private receipt(request: Request): HeardReceipt {
    const completedCharacters = request.completed ? request.sentences[request.completed - 1]!.endCharacter : 0;
    const sentence = request.sentenceIndex === null ? null : request.sentences[request.sentenceIndex];
    const partialCharacters = !sentence ? 0 : request.clip?.marks
      ? Math.min(Array.from(sentence.text).length, Math.max(0, ...request.clip.marks.filter(m => m.atMs <= request.playedMs).map(m => m.endCharacter)))
      : request.playedMs > 0 ? null : 0;
    const confirmedCharacters = completedCharacters + (partialCharacters ?? 0);
    return { completedSentences: request.completed, sentenceIndex: request.sentenceIndex, playedMs: request.playedMs, partialCharacters, confirmedCharacters, confirmedText: Array.from(request.text).slice(0, confirmedCharacters).join('') };
  }
}
