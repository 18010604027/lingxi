/**
 * The pet World on the new body: the front's tools to talk and act, carried out by the behaviour system
 * (core/behavior) on the body (body/), and what happens to the body brought back into the front's context. It replaces
 * the old pet package's World; only what the new body has is here (no dressing, figure packs, hover buttons, themes or
 * voice input).
 * - `pet_say`: a script in the bubble, its 【】 and <> markers played by the behaviour system (script.ts);
 * - `pet_act`: actions without speaking, with how long, how many times or where to;
 * - `pet_where`: where she stands, where she may go and where not;
 * - `pet_ask`: a durable question with workbench answer controls and an optional body bubble;
 * - events: a hand picking her up and putting her down, clicks, and how each command ended (`[moved]`); with them, how
 *   she feels when that changed (`[how you feel]`, will.ts `describe`).
 */
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ToolDef, ToolOutcome, TriggerMode, World, WorldHost, WorldWebUiDecl } from '../contracts.ts';
const nowIso = (timezone: string, date: Date = new Date()) => date.toLocaleString('sv-SE', { timeZone: timezone }).replace(' ', 'T');
const shortTime = (timezone: string, date: Date = new Date()) => date.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
import type { Behavior, Command as BodyCommand, CommandEnd } from '../behavior/behavior.ts';
import type { BodyMessage } from '../behavior/body-link.ts';
import type { Daily, InteractionPolicy } from '../behavior/daily.ts';
import type { Figure } from '../behavior/plan.ts';
import { describeFeeling, type FeelingState } from '../behavior/will.ts';
import { describeAction, parseActions, parseScript, vocabTable, type Action, type Beat, type VocabWord } from './script.ts';
import { PET_TEXT, type ModelLanguage } from './text.ts';
import { PET_TOOL_DECLS } from './tools.ts';
import { figureVocab } from './vocab.ts';
import { SharedOutput, type OutputPart, type OutputSnapshot } from './output.ts';

export const PET_ID = 'pet';
/** Clicks this close together are told as one touch. */
const TOUCH_MERGE_MS = 2500;
/** The body types this fast and keeps a bubble this long after (body/body.js). */
const TYPE_MS = 1000 / 30;
const PAUSE_MS = 120;
const PAUSE_AFTER = new Set([...'，。！？、；：,.!?;:…~～']);
const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
};

/** How long the body takes to type `text` and keeps it up after, in ms. */
export function bubbleMs(text: string): { typing: number; hold: number } {
  const chars = Array.from(text);
  const typing = chars.reduce((ms, ch) => ms + (PAUSE_AFTER.has(ch) ? PAUSE_MS : TYPE_MS), 0);
  return { typing, hold: Math.min(12_000, 2500 + 150 * chars.length) };
}

/** What the World needs of the body's end of the link. */
export interface PetLink {
  readonly connected: boolean;
  readonly x: number;
  on(event: 'message', listener: (m: BodyMessage) => void): unknown;
  on(event: 'gone', listener: () => void): unknown;
  send(c: { t: 'say'; text: string; ms?: number; replyId?: string;
    question?: Ask;
    beats?: Array<{ text: string; outputId?: string; hold?: number; actions?: unknown[]; anchors?: Array<{ at: number; actions: unknown[] }> }>; hold?: number }): number;
}

/** A question she asked, with its options, waiting for the person to answer it. */
export interface Ask { id: string; question: string; options: string[]; at: number; requestId?: string }

export interface PetWorldOptions {
  link: PetLink;
  behavior: Pick<Behavior, 'command' | 'keptOut' | 'on'> & { enqueue?: (commands: BodyCommand[], urgency?: 'front' | 'daily') => Promise<CommandEnd[]> };
  daily?: Pick<Daily, 'will' | 'feel' | 'interactionPolicy' | 'setInteractionPolicy'>;
  figure: Figure;
  timezone: string;
  /** What she calls the person, read at each use. */
  userName(): string;
  language?(): ModelLanguage;
  /** For tests: the clock and waiting. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Associates a front-created question with a live backend permission request. */
  onQuestion?(question: Ask, state: 'asked' | 'presented' | 'answered', channel?: 'body' | 'workbench'): void;
}

export class PetWorld {
  readonly id = PET_ID;
  private host: WorldHost | null = null;
  private stopped = false;
  private readonly vocab: VocabWord[];
  /**
   * What the front asks for runs one after another, speech and actions alike, so an action of one call never cuts
   * short the walk of the one before; `speechUntil` is when the speech queued so far is over (epoch ms).
   */
  private queue: Promise<void> = Promise.resolve();
  private speechUntil = 0;
  /** One transport command owns the reply; each text beat keeps its own durable output id. */
  private readonly pendingSpeech = new Map<number, { replyId: string; outputIds: string[] }>();
  private readonly frontActions = new Map<string, number>();
  private output: SharedOutput | null = null;
  private bodyEpoch = 0;
  private readonly answering = new Map<string, Promise<boolean>>();
  /** Commands the front gave with a time or a place, by word: how each ends is told back (`[moved]`). */
  private awaited = new Map<string, number>();
  /** Questions she asked that the person has not answered yet, newest last. */
  private pending: Ask[] = [];
  private clicks: { count: number; x: number; interactionId: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private dropKind: 'thrown' | 'dropped' | null = null;
  private dragInteraction: { id: string; from: number } | null = null;
  private feelingTold = '';
  private stampDay = '';
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PetWorldOptions) {
    this.vocab = figureVocab(opts.figure);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    opts.link.on('message', (m) => this.fromBody(m));
    opts.link.on('gone', () => {
      this.bodyEpoch++;
      for (const pending of this.pendingSpeech.values()) for (const outputId of pending.outputIds) this.recordReceipt(outputId, 'unknown');
      this.pendingSpeech.clear();
    });
    opts.behavior.on('command', (e: CommandEnd) => this.ended(e));
    opts.behavior.on('action', (e: { actionId: string; id: string; clip: string; playbackId: number; interactionId?: string; at: number; state: 'started' | 'completed' | 'interrupted' | 'failed' | 'unknown' }) => {
      void this.recordAction(e);
    });
  }

  private get language(): ModelLanguage { return this.opts.language?.() ?? 'zh'; }
  private get t() { return PET_TEXT[this.language]; }
  private get user(): string { return this.opts.userName(); }

  async start(host: WorldHost): Promise<void> {
    this.stopped = false;
    this.host = host;
    if (!this.output || host.store) {
      this.output = new SharedOutput(host, this.opts.timezone);
      await this.output.recoverBodyReceipts();
      this.pending = this.output.pendingAsks();
    } else this.output.rebind(host);
  }
  outputs(after = 0): OutputSnapshot { return this.output?.snapshot(after) ?? { available: false, cursor: 0, outputs: [], receipts: [] }; }
  async outputReceipt(id: string): Promise<boolean> {
    const accepted = await (this.output?.receipt(id, 'workbench', 'presented') ?? Promise.resolve(false));
    if (accepted) this.questionPresented(id, 'workbench');
    return accepted;
  }
  /** The person typed to her (the DSH page): wakes the front at once. */
  async typed(text: string): Promise<boolean> {
    this.opts.daily?.feel('talked');
    return this.push('pet.message', this.t.typed(this.user, text), 'preempt', { text });
  }

  /** Body-only input route: the newest pending body question consumes the next typed line as its answer. */
  async typedFromBody(text: string): Promise<boolean> {
    const pending = this.pending;
    const latest = pending.at(-1);
    if (latest) return this.answered(latest.question, text, latest.id);
    return this.typed(text);
  }

  /** Actions anchored inside a body reply still enter the same Behavior owner. */
  actionsFromBody(actions: unknown[]): void {
    const parsed = actions.flatMap((raw) => {
      if (typeof raw === 'string') return parseActions([raw], this.vocab).actions;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const value = raw as Record<string, unknown>;
      if (typeof value.id !== 'string' || !this.vocab.some((word) => word.id === value.id)) return [];
      const action: { id: string; seconds?: number; to?: number | 'left' | 'right' | 'center' | 'cursor' } = { id: value.id };
      if (typeof value.seconds === 'number' && Number.isFinite(value.seconds) && value.seconds > 0 && value.seconds <= 3600) action.seconds = value.seconds;
      if ((typeof value.to === 'number' && Number.isFinite(value.to) && value.to >= 0 && value.to <= 1)
        || ['left', 'right', 'center', 'cursor'].includes(String(value.to))) action.to = value.to as typeof action.to;
      return [action];
    });
    if (parsed.length) this.giveRun(parsed.map((action) => typeof action === 'string' ? { id: action } : action));
  }

  /** The person answered a question she asked (`pet_ask`). */
  async answered(question: string, text: string, questionId?: string): Promise<boolean> {
    if (questionId && this.output?.answered(questionId)) return true;
    const answered = this.pending.filter((a) => questionId ? a.id === questionId && a.question === question : a.question === question);
    if (!questionId && !answered.length && this.output?.answeredQuestion(question)) return true;
    if (questionId && !answered.length) return false;
    const id = questionId ?? answered[0]?.id;
    const key = id ?? question;
    const prior = this.answering.get(key);
    if (prior) return prior;
    const delivery = this.deliverAnswer(question, text, answered, id);
    this.answering.set(key, delivery);
    try { return await delivery; } finally { this.answering.delete(key); }
  }

  private async deliverAnswer(question: string, text: string, answered: Ask[], questionId?: string): Promise<boolean> {
    this.opts.daily?.feel('talked');
    const requestId = answered.find((ask) => ask.id === questionId)?.requestId ?? answered[0]?.requestId;
    const delivered = await this.push('pet.answer', this.t.answered(this.user, question, text)
      + (requestId ? `\n[permission requestId: ${requestId}; use this answer as context, then call answer_permission for that request]` : ''),
    'preempt', { question, text, ...(questionId ? { questionId } : {}), ...(requestId ? { requestId } : {}) });
    // A failed delivery must leave the question available; a newly asked copy is a different question.
    if (delivered) {
      for (const ask of answered) this.opts.onQuestion?.(ask, 'answered');
      this.pending = this.pending.filter((a) => !answered.includes(a));
      if (questionId) this.output?.acceptAnswer(questionId);
    }
    return delivered;
  }

  /** Whether the body is there, where it stands, and how she feels. */
  state(): { connected: boolean; x: number; feeling: string; feelingState?: FeelingState } {
    const will = this.opts.daily?.will;
    return { connected: this.opts.link.connected, x: this.opts.link.x, feeling: will?.describe() ?? '',
      ...(will?.drives ? { feelingState: describeFeeling(will.drives) } : {}) };
  }

  /** The questions she asked that the person has not answered, newest last: what the page draws buttons for. */
  pendingAsks(): Ask[] { return [...this.pending]; }

  async stop(): Promise<void> {
    this.stopped = true;
    this.bodyEpoch++;
    await this.queue;
    for (const pending of this.pendingSpeech.values()) for (const outputId of pending.outputIds) await this.output?.receipt(outputId, 'body', 'unknown');
    await this.output?.flush();
    this.host = null;
    this.pendingSpeech.clear();
    if (this.clicks) clearTimeout(this.clicks.timer);
    this.clicks = null;
  }

  envPromptVars(): Record<string, string> {
    return { 'pet.user': this.user, 'pet.name': this.opts.figure.name, 'pet.vocab': vocabTable(this.vocab, this.language) };
  }

  webUi(): WorldWebUiDecl {
    return {
      lamps: [{ label: 'body', state: this.opts.link.connected ? 'online' : 'offline' }],
      promptDocs: [{
        key: `worlds.${PET_ID}.envPrompt`, title: 'pet', description: 'How her body works, for the front', path: ENV_PROMPT_FILES[this.language], role: 'envPrompt',
        vars: [{ name: 'pet.user', description: 'what she calls the person' }, { name: 'pet.name', description: 'her name' },
          { name: 'pet.vocab', description: 'the actions she knows', multiline: true }],
      }],
    };
  }

  tools(): ToolDef[] {
    const handlers: Record<string, ToolDef['handler']> = {
      pet_say: async (args) => this.say(args),
      pet_act: async (args) => this.act(args),
      pet_interaction: async (args) => this.interaction(args),
      pet_where: async () => ({ text: this.where() }),
      pet_ask: async (args) => this.ask(args),
    };
    return PET_TOOL_DECLS.map((d) => ({ ...d, handler: handlers[d.name]! }));
  }

  /* ---------- tools ---------- */

  private interaction(args: Record<string, unknown>): ToolOutcome {
    if (!this.opts.daily) return { text: 'Interaction policy is unavailable.', failed: true };
    const policy: InteractionPolicy = {};
    for (const key of ['click', 'pet', 'landed'] as const) if (typeof args[key] === 'string') policy[key] = args[key] as string;
    if (args.voice === 'quiet' || args.voice === 'consider') policy.voice = args.voice;
    try {
      const current = this.opts.daily.setInteractionPolicy(policy);
      return { text: `Interaction response updated: ${JSON.stringify(current)}.` };
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), failed: true };
    }
  }

  private async say(args: Record<string, unknown>, question?: Omit<Ask, 'id'>): Promise<ToolOutcome> {
    const epoch = this.bodyEpoch;
    const bodyConnected = this.opts.link.connected;
    const script = typeof args.script === 'string' ? args.script : '';
    const { beats, dropped } = parseScript(script, this.vocab);
    if (!beats.some((b) => b.text || b.actions.length || b.anchors.length)) return { text: this.t.sayEmpty, failed: true };
    let parts: OutputPart[] = [];
    let messageId = '';
    let savedQuestion: Ask | undefined;
    try {
      if (!this.output) throw new Error('output host unavailable');
      const saved = await this.output.create(beats.filter((beat) => beat.text).map((beat) => beat.text), question ? 'ask' : 'say', question);
      messageId = saved.messageId;
      savedQuestion = saved.question;
      parts = saved.parts;
      if (saved.question) this.pending = [...this.pending.filter((ask) => question!.requestId
        ? ask.requestId !== question!.requestId : !!ask.requestId || ask.question !== question!.question), saved.question];
    } catch (error) { return { text: `Output could not be saved; nothing was dispatched: ${(error as Error).message}`, failed: true }; }
    if (!bodyConnected || !this.opts.link.connected || epoch !== this.bodyEpoch) {
      const actions = beats.some((beat) => beat.actions.length || beat.anchors.length);
      return { text: `${parts.length ? 'Text saved for the workbench; presentation is unconfirmed. ' : ''}Body is offline or its connection changed; no body speech or actions were dispatched.`, ...(actions || !parts.length ? { failed: true } : {}) };
    }
    const now = this.now();
    const selfSec = beats.reduce((s, b) => { const m = bubbleMs(b.text); return s + (b.actions.length ? 0.5 : 0) + (b.text ? (m.typing + m.hold) / 1000 : 0); }, 0);
    const waitSec = Math.max(0, (this.speechUntil - now) / 1000);
    this.speechUntil = Math.max(now, this.speechUntil) + selfSec * 1000;
    this.queue = this.queue.then(() => this.play(beats, parts, messageId, epoch, savedQuestion)).catch((error) => console.warn('[pet] body output failed', error));
    return { text: `Text saved; body script queued (${Math.round(waitSec)} s ahead, about ${Math.round(selfSec)} s to play). Presentation is not yet confirmed.`
      + (dropped.length ? `\n[parameters] Unknown actions were left out: ${dropped.join(', ')}.` : '') };
  }

  /** Plays a script: each bubble's leading actions, then its text, with the inline actions where typing reaches them. */
  private async play(beats: readonly Beat[], parts: OutputPart[], replyId: string, epoch: number, question?: Ask): Promise<void> {
    if (epoch !== this.bodyEpoch || !this.opts.link.connected) return;
    let partIndex = 0;
    const bodyBeats = beats.map((beat) => {
      const part = beat.text ? parts[partIndex++] : undefined;
      return {
        text: beat.text,
        ...(part ? { outputId: part.id } : {}),
        ...(beat.text ? { hold: bubbleMs(beat.text).hold } : {}),
        ...(beat.actions.length ? { actions: beat.actions } : {}),
        ...(beat.anchors.length ? { anchors: beat.anchors } : {}),
      };
    });
    // One transport item owns the whole reply. The body preserves trails and
    // runs each beat's actions through the existing Behavior bridge.
    const id = this.opts.link.send({ t: 'say', text: bodyBeats.find((beat) => beat.text)?.text ?? '', replyId, beats: bodyBeats,
      ...(question ? { question } : {}) });
    const outputIds = parts.map((part) => part.id);
    if (outputIds.length) {
      this.pendingSpeech.set(id, { replyId, outputIds });
      for (const outputId of outputIds) this.recordReceipt(outputId, 'dispatched');
    }
  }

  /**
   * Hands an action to the behaviour system. The behaviour system serializes playback; speech never waits for it.
   */
  private async doAction(a: Action, _wait: boolean): Promise<void> {
    const c: BodyCommand = typeof a === 'string' ? { id: a } : a;
    this.give(c);
  }

  private act(args: Record<string, unknown>): ToolOutcome {
    const list = Array.isArray(args.actions) ? args.actions : typeof args.actions === 'string' ? [args.actions] : [];
    // "Play something that feels like this" — one random action carrying the tag, when no words were given.
    if (!list.length && typeof args.group === 'string' && args.group.trim()) {
      const tag = args.group.trim().toLowerCase();
      const figure = this.opts.figure;
      const candidates = Object.keys(figure.words).filter((id) => {
        const vocab = figure.vocab?.[id];
        if (!vocab) return false;
        return [...(vocab.mood ?? []), vocab.when ?? '', vocab.about ?? ''].join(' ').toLowerCase().includes(tag);
      });
      if (!candidates.length) return { text: this.t.actNone([]), failed: true };
      list.push(candidates[Math.floor(Math.random() * candidates.length)]!);
    }
    const { actions, dropped } = parseActions(list, this.vocab);
    if (!actions.length) return { text: this.t.actNone(dropped), failed: true };
    if (!this.opts.link.connected) return { text: this.t.notConnected('pet_act', this.user), failed: true };
    const commands = actions.map((a) => typeof a === 'string' ? { id: a } : a);
    this.giveRun(commands);
    return { text: this.t.actReceipt(actions.map((a) => describeAction(this.named(a))), dropped) };
  }

  /** Hands a command to the behaviour system, minding to tell how it ends when it has a time or a place. */
  private give(c: BodyCommand): void { this.giveRun([c]); }

  private giveRun(commands: BodyCommand[]): void {
    const valid = commands.filter((c) => this.opts.link.connected);
    if (!valid.length) return;
    for (const c of valid) {
    if (c.seconds !== undefined || c.to !== undefined) this.awaited.set(c.id, (this.awaited.get(c.id) ?? 0) + 1);
    this.frontActions.set(c.id, (this.frontActions.get(c.id) ?? 0) + 1);
    }
    const run = this.opts.behavior.enqueue
      ? this.opts.behavior.enqueue(valid, 'daily')
      : valid.reduce((p, c) => p.then(() => this.opts.behavior.command(c, 'daily')).then(() => [] as CommandEnd[]), Promise.resolve([] as CommandEnd[]));
    void run.catch((error) => console.warn('[pet] action run failed', error));
  }

  private async recordAction(action: { actionId: string; id: string; clip: string; playbackId: number; interactionId?: string; at: number; state: string }): Promise<void> {
    if (this.stopped) return;
    try { await this.host?.pushEvent({ type: 'pet.action', source: this.id, origin: 'internal',
      ts: new Date(action.at).toISOString(), text: '', meta: { actionId: action.actionId, action: action.id, clip: action.clip,
        playbackId: action.playbackId, ...(action.interactionId ? { interactionId: action.interactionId } : {}), state: action.state } }, { deliver: false }); }
    catch (error) { console.warn('[pet] action result could not be recorded', error); }
  }

  private ended(e: CommandEnd): void {
    const count = this.frontActions.get(e.id) ?? 0;
    const frontAction = count > 0;
    if (count <= 1) this.frontActions.delete(e.id); else this.frontActions.set(e.id, count - 1);
    // Timed moves report all results; plain front actions only report hand interruption or body disconnect.
    const n = this.awaited.get(e.id) ?? 0;
    const unconfirmed = frontAction && e.outcome === 'unknown' && e.by === 'disconnect';
    const handCut = frontAction && e.outcome === 'interrupted' && e.by === 'hand';
    if (n === 0 && !unconfirmed && !handCut) return;
    if (n === 1) this.awaited.delete(e.id); else if (n > 1) this.awaited.set(e.id, n - 1);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const text = this.t.commandEnded({
      word: this.named(e.id) as string, outcome: e.outcome, at: pct(e.x), user: this.user,
      ...(e.adjusted !== undefined ? { adjusted: pct(e.adjusted) } : {}), ...(e.crossed ? { crossed: e.crossed } : {}), ...(e.by ? { by: e.by } : {}),
    });
    if (text) void this.push('pet.moved', `[moved] ${text}`, 'piggyback');
  }

  /** An action with its word as the front writes it (its first name in the model-text language). */
  private named(a: Action): Action {
    const v = this.vocab.find((w) => w.id === (typeof a === 'string' ? a : a.id));
    const name = v?.names[this.language]?.[0] ?? v?.names.zh?.[0];
    if (!name) return a;
    return typeof a === 'string' ? name : { ...a, id: name };
  }

  private async ask(args: Record<string, unknown>): Promise<ToolOutcome> {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) return { text: this.t.askEmpty, failed: true };
    const options = (Array.isArray(args.options) ? args.options : []).filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 3);
    const requestId = typeof args.requestId === 'string' && args.requestId.trim() ? args.requestId.trim() : undefined;
    const ask = { question, options, at: this.now(), ...(requestId ? { requestId } : {}) };
    const said = await this.say({ script: this.t.askBubble(question, options) }, ask);
    if (said.failed) return { ...said, text: said.text.replace('pet_say', 'pet_ask') };
    const saved = this.pending.at(-1);
    if (saved) this.opts.onQuestion?.(saved, 'asked');
    return { text: `Question saved. Your next body reply answers the newest waiting question; older questions remain pending. ${said.text}` };
  }

  /** Where she stands and where she may go, in whole percent of the screen's width. */
  private where(): string {
    if (!this.opts.link.connected) return this.t.layoutUnknown;
    const q = (v: number) => Math.round(v * 100);
    const blocked = this.opts.behavior.keptOut.map(([a, b]) => [q(a), q(b)] as [number, number]).filter(([a, b]) => b > a);
    const free: Array<[number, number]> = [];
    let at = 0;
    for (const [a, b] of [...blocked].sort((x, y) => x[0] - y[0])) { if (a - at >= 4) free.push([at, a]); at = Math.max(at, b); }
    if (100 - at >= 4) free.push([at, 100]);
    return this.t.layout(q(this.opts.link.x), free, blocked);
  }

  /* ---------- events ---------- */

  private fromBody(m: BodyMessage): void {
    if (this.stopped) return;
    if (m.t === 'speech') {
      const pending = this.pendingSpeech.get(m.id);
      if (!pending) return;
      const outputId = m.outputId ?? pending.outputIds[0];
      if (!outputId) return;
      if (m.state === 'paused' || m.state === 'resumed') {
        this.recordReceipt(outputId, m.state);
        return;
      }
      pending.outputIds = pending.outputIds.filter((id) => id !== outputId);
      if (m.state === 'interrupted') {
        for (const remaining of pending.outputIds) this.recordReceipt(remaining, 'interrupted');
        pending.outputIds = [];
      }
      this.recordReceipt(outputId, m.state);
      if (!pending.outputIds.length) this.pendingSpeech.delete(m.id);
      return;
    }
    if (m.t === 'busy' && m.for === 'say') {
      const pending = this.pendingSpeech.get(m.id);
      if (pending) {
        for (const outputId of pending.outputIds) {
          this.recordReceipt(outputId, 'rejected');
        }
        this.pendingSpeech.delete(m.id);
      }
    }
    if (m.t === 'click') {
      if (this.clicks) { this.clicks.count++; return; }
      const interactionId = m.interactionId ?? randomUUID();
      this.clicks = { count: 1, x: m.x, interactionId, timer: setTimeout(() => this.tellClicks(), TOUCH_MERGE_MS) };
      void this.archiveInteraction('click', interactionId, 'started', m.x, { ...(m.position ? { position: m.position } : {}) }, m.startedAt ?? m.at);
    }
    if (m.t === 'pet') {
      void this.archiveInteraction('pet', m.interactionId, m.phase, m.x, { ...(m.position ? { position: m.position } : {}) }, m.at);
    }
    if (m.t === 'grab') {
      this.dragInteraction = { id: m.interactionId ?? randomUUID(), from: m.x };
      void this.archiveInteraction('drag-start', this.dragInteraction.id, 'started', m.x, {}, m.at);
    }
    if (m.t === 'drag-move' && this.dragInteraction?.id === m.interactionId) {
      void this.archiveInteraction('drag-move', m.interactionId, 'moved', m.x, { y: m.y }, m.at);
    }
    if (m.t === 'drop') {
      this.dropKind = Math.hypot(m.vx, m.vy) > 500 ? 'thrown' : 'dropped';
      if (this.dragInteraction) void this.archiveInteraction('drag-end', m.interactionId ?? this.dragInteraction.id, 'released', m.x, { from: this.dragInteraction.from }, m.at);
    }
    if (m.t === 'landed' && this.dropKind) {
      const at = `${Math.round(m.x * 100)}%`;
      const text = this.dropKind === 'thrown' ? this.t.thrown(this.user, at) : this.t.dropped(this.user, at);
      if (this.dragInteraction) void this.archiveInteraction('drag-end', m.interactionId ?? this.dragInteraction.id, 'completed', m.x, { from: this.dragInteraction.from }, m.at);
      this.dragInteraction = null;
      this.dropKind = null;
      void this.push('pet.touch', this.t.touch(text), 'piggyback');
    }
  }

  private recordReceipt(id: string, state: 'dispatched' | 'paused' | 'resumed' | 'completed' | 'interrupted' | 'unknown' | 'rejected'): void {
    if (this.stopped) return;
    void this.output?.receipt(id, 'body', state).then((accepted) => {
      if (accepted && state === 'completed') this.questionPresented(id, 'body');
    }).catch((error) => console.warn('[pet] speech receipt could not be recorded', error));
  }

  private questionPresented(outputId: string, channel: 'body' | 'workbench'): void {
    const snapshot = this.output?.snapshot();
    const receipt = snapshot?.receipts.find((receipt) => receipt.outputId === outputId && receipt.channel === channel);
    if (!receipt || !['completed', 'presented'].includes(receipt.state)) return;
    const part = snapshot?.outputs.find((part) => part.id === outputId);
    const question = this.pending.find((ask) => ask.id === part?.messageId);
    if (question) this.opts.onQuestion?.(question, 'presented', channel);
  }

  private tellClicks(): void {
    const c = this.clicks;
    this.clicks = null;
    if (!c) return;
    void this.archiveInteraction('click', c.interactionId, 'completed', c.x, { count: c.count });
    if (this.opts.daily?.interactionPolicy?.voice === 'consider') {
      void this.push('pet.touch', this.t.touch(this.t.poked(this.user, c.count)), 'debounce', { interactionId: c.interactionId });
    }
  }

  private async archiveInteraction(kind: 'click' | 'pet' | 'drag-start' | 'drag-move' | 'drag-end', interactionId: string, state: string, x: number, extra: Record<string, unknown> = {}, at?: number): Promise<void> {
    try {
      const timestamp = Number.isFinite(at) ? new Date(at!).toISOString() : nowIso(this.opts.timezone);
      await this.host?.pushEvent({ type: 'pet.interaction', source: this.id, origin: 'external', ts: timestamp, text: '',
        meta: { kind, interactionId, state, x, at: timestamp, ...(extra ?? {}) } }, { deliver: false, trigger: 'piggyback' });
    } catch (error) { console.warn('[pet] interaction could not be recorded', error); }
  }

  /** Delivers an event to the front, with how she feels first when that changed. */
  private async push(type: string, text: string, trigger: TriggerMode, meta?: Record<string, unknown>): Promise<boolean> {
    const host = this.host;
    if (!host) return false;
    const feeling = this.opts.daily?.will.describe() ?? '';
    const lines = [text];
    if (feeling && feeling !== this.feelingTold) { this.feelingTold = feeling; lines.unshift(`[how you feel] ${feeling}`); }
    try {
      const saved = await host.pushEvent({ type, source: this.id, senderKey: type, ts: nowIso(this.opts.timezone), text: this.stamp() + lines.join('\n'), ...(meta ? { meta } : {}) }, { trigger });
      // A hidden world is archived by Core without being queued for the front.
      return saved.contextDelivery !== 'archive-only';
    } catch (err) {
      console.warn(`[pet] event not delivered: ${(err as Error).message}`);
      return false;
    }
  }

  /** `[HH:MM] `, and `[MM-DD <weekday> HH:MM] ` for the first event of a day, so the front knows the date. */
  private stamp(now = new Date(this.now())): string {
    const parts = Object.fromEntries(new Intl.DateTimeFormat(this.t.dateLocale, { timeZone: this.opts.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
      .formatToParts(now).map((p) => [p.type, p.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const time = shortTime(this.opts.timezone, now);
    if (day === this.stampDay) return `[${time}] `;
    this.stampDay = day;
    return `[${parts.month}-${parts.day} ${parts.weekday} ${time}] `;
  }
}
