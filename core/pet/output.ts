/** Shared text and channel receipts, derived from the host's durable event log. No channel replays body actions. */
import { randomUUID } from 'node:crypto';
import type { WorldHost } from '../contracts.ts';
const nowIso = (timezone: string, date: Date = new Date()) => date.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');

export interface OutputPart { id: string; messageId: string; index: number; text: string; kind: 'say' | 'ask'; ts: string; cursor: number }
export interface OutputQuestion { id: string; question: string; options: string[]; at: number; requestId?: string }
export type OutputChannel = 'body' | 'workbench';
export type OutputState = 'dispatched' | 'paused' | 'resumed' | 'completed' | 'interrupted' | 'unknown' | 'rejected' | 'presented';
export interface OutputSnapshot {
  available: boolean; cursor: number; reset?: boolean; outputs: OutputPart[];
  receipts: Array<{ channel: string; outputId: string; state: OutputState }>;
}
const terminal = (state: OutputState) => !['dispatched', 'paused', 'resumed'].includes(state);

export class SharedOutput {
  private readonly parts = new Map<string, OutputPart>();
  private readonly receipts = new Map<string, OutputState>();
  private readonly receiptCursors = new Map<string, number>();
  private readonly presented = new Set<string>();
  private readonly questions = new Map<string, OutputQuestion>();
  private readonly answers = new Set<string>();
  private readonly answeredQuestions = new Set<string>();
  private writes: Promise<unknown> = Promise.resolve();
  private cursor = 0;

  constructor(private host: WorldHost, private readonly timezone: string) {
    // Production hosts expose the reader; small World test doubles may only implement pushEvent.
    for (const event of host.store?.range({}) ?? []) this.apply(event as unknown as Record<string, unknown>);
  }
  rebind(host: WorldHost): void { this.host = host; }
  async recoverBodyReceipts(): Promise<void> {
    for (const [key, state] of this.receipts) if (key.startsWith('body:') && ['dispatched', 'paused', 'resumed'].includes(state)) {
      await this.receipt(key.slice('body:'.length), 'body', 'unknown');
    }
  }

  private apply(event: Record<string, unknown>): void {
    const meta = (event.meta ?? {}) as Record<string, unknown>;
    const cursor = Number(event.cursor) || this.cursor;
    this.cursor = Math.max(this.cursor, cursor);
    if (event.type === 'pet.output' && event.origin === 'internal' && Array.isArray(meta.parts)) {
      for (const part of meta.parts as OutputPart[]) this.parts.set(part.id, { ...part, ts: String(event.ts), cursor });
      const question = meta.question as OutputQuestion | undefined;
      if (question) {
        this.answeredQuestions.delete(question.question);
        for (const [id, prior] of this.questions) if (question.requestId
          ? prior.requestId === question.requestId : !prior.requestId && prior.question === question.question) this.questions.delete(id);
        this.questions.set(question.id, question);
      }
    }
    if (event.type === 'pet.output.receipt' && event.origin === 'internal' && typeof meta.outputId === 'string') {
      const key = `${meta.channel}:${meta.outputId}`;
      this.receipts.set(key, meta.state as OutputState);
      this.receiptCursors.set(key, cursor);
      if (meta.firstPresentation === true) this.presented.add(meta.outputId);
    }
    if (event.type === 'pet.answer' && typeof meta.questionId === 'string' && event.contextDelivery !== 'archive-only') {
      this.answers.add(meta.questionId);
      if (typeof meta.question === 'string') this.answeredQuestions.add(meta.question);
      this.questions.delete(meta.questionId);
    }
  }

  private serial<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write);
    this.writes = result.catch(() => undefined);
    return result;
  }

  async create(texts: string[], kind: 'say' | 'ask', question?: Omit<OutputQuestion, 'id'>): Promise<{ messageId: string; parts: OutputPart[]; question?: OutputQuestion }> {
    return this.serial(async () => {
      const messageId = randomUUID();
      const parts = texts.map((text, index) => ({ id: `${messageId}:${index}`, messageId, index, text, kind }));
      const ask = question ? { ...question, id: messageId } : undefined;
      const saved = await this.host.pushEvent({ type: 'pet.output', source: 'pet', origin: 'internal', ts: nowIso(this.timezone),
        text: texts.join('\n'), meta: { messageId, parts, ...(ask ? { question: ask } : {}) } }, { deliver: false });
      this.apply(saved as unknown as Record<string, unknown>);
      return { messageId, parts: parts.map((part) => this.parts.get(part.id)!), ...(ask ? { question: ask } : {}) };
    });
  }

  /** A first presentation and its memory projection are committed in the same event. */
  receipt(outputId: string, channel: OutputChannel, state: OutputState): Promise<boolean> {
    return this.serial(async () => {
      const part = this.parts.get(outputId);
      if (!part) return false;
      const key = `${channel}:${outputId}`;
      const prior = this.receipts.get(key);
      if (prior && (terminal(prior) || prior === state)) return true;
      const firstPresentation = !this.presented.has(outputId) && (state === 'presented' || state === 'completed');
      const saved = await this.host.pushEvent({ type: 'pet.output.receipt', source: 'pet', origin: 'internal', ts: nowIso(this.timezone),
        text: firstPresentation ? part.text : '', meta: { outputId, messageId: part.messageId, channel, state, firstPresentation, kind: part.kind } }, { deliver: false });
      this.apply(saved as unknown as Record<string, unknown>);
      return true;
    });
  }

  snapshot(after = 0): OutputSnapshot {
    return { available: true, cursor: this.cursor, reset: after > this.cursor,
      outputs: [...this.parts.values()].filter((part) => part.cursor > (after > this.cursor ? 0 : after)),
      receipts: [...this.receipts].filter(([key]) => (this.receiptCursors.get(key) ?? 0) > (after > this.cursor ? 0 : after))
        .map(([key, state]) => { const [channel, ...id] = key.split(':'); return { channel, outputId: id.join(':'), state }; }) };
  }
  pendingAsks(): OutputQuestion[] { return [...this.questions.values()]; }
  answered(id: string): boolean { return this.answers.has(id); }
  answeredQuestion(question: string): boolean { return this.answeredQuestions.has(question); }
  acceptAnswer(id: string): void {
    this.answers.add(id);
    const question = this.questions.get(id);
    if (question) this.answeredQuestions.add(question.question);
    this.questions.delete(id);
  }

  /** Wait for durable output and receipt writes before the application closes its event store. */
  async flush(): Promise<void> { await this.writes; }
}
