/** Lingxi-owned persona context and the existing memory services; no framework host or base class. */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope, EventStoreReader, FrontEventSource, Logger, ToolDef } from './contracts.ts';
import type { Agents } from './agents/roles.ts';
import { EventMemory, personMessageText } from './memory/events.ts';
import { RecallScore } from './memory/recall-score.ts';
import { Hints } from './memory/hints.ts';
import { DIG_PROMPT } from './memory/recall.ts';
import { MemoryGraph } from './memory/graph.ts';
import { GraphRecall } from './memory/graph-recall.ts';
import { MemoryVectors } from './memory/vectors.ts';
import { EMBED_MODEL, Embedder } from './memory/embed.ts';
import { WorkspaceFiles, type GitAuthor } from './workspace-tools.ts';
export const MEMORY_SESSION = 'memory';

/** The workspace file that goes into the prefix as her notes on the person. */
export const PARTNER_FILE = 'PARTNER.md';
/** The workspace directory for details about the person that PARTNER.md leaves out; she reads them when needed. */
export const PARTNER_DIR = 'partner';
/** Heads the partner segment: the segment is the whole file on every request, so its length is paid each time. */
export const PARTNER_NOTE = `${PARTNER_FILE} in your workspace, below, is read in full on every request. Keep it a short, distilled portrait `
  + `of the person: merge or drop what is outdated. Put stories, logs and longer notes in files under ${PARTNER_DIR}/ and read them `
  + 'when needed.';
/** The workspace directory for what she has set aside; the prefix listing shows it as one line. */
export const ARCHIVE_DIR = 'archive';
/** Goes into the prefix right before the workspace listing, where the file names are all she sees of her files. */
export const MEMORY_NOTE = [
  'How you keep your workspace:',
  '- One subject per file, named for what it holds, specific enough that the name alone tells you whether to open it '
    + '(partner/food-likes-and-dislikes.md, not partner/notes2.md).',
  '- Before starting a file, look for one on the same subject with glob_files or grep_files and change that one. '
    + 'When a fact changes, rewrite it where it stands; delete what is no longer true.',
  '- Anything tied to a time has its date in the name: a running log one file per month (log/2026-10.md), one day\'s events by the day.',
  `- Keep older notes as dated files under ${ARCHIVE_DIR}/. Read the source and use write_file to keep current notes focused. `
    + `${ARCHIVE_DIR}/ shows below as one line, and grep_files still searches it.`,
].join('\n');
/** Commits of Lingxi's own writes. */
export const AUTHOR_LINGXI: GitAuthor = { name: 'lingxi', email: 'lingxi@persona.local' };
/** Commits of the roles behind the front: the control center and the code agents. */
export const AUTHOR_BACKGROUND: GitAuthor = { name: 'background', email: 'background@persona.local' };
/** Commits the app makes on its own: the snapshot at start. */
export const AUTHOR_APP: GitAuthor = { name: 'lingxi-pet', email: 'app@persona.local' };
/** Tags made by `snapshot`: the workspace as each version of the app first found it. */
export const SNAPSHOT_TAG = (version: string) => `start-${version}`;

/**
 * Puts the partner notes where this Persona reads them. Top-level entries whose names differ from `PARTNER.md` or
 * `partner/` only in letter case (possible on a case-sensitive file system) are merged in: such a file is renamed to
 * PARTNER.md, or appended to it under a line naming it when PARTNER.md exists; such a directory's entries move into
 * partner/. A file named `partner` moves into the directory as `partner/partner`. partner/ exists afterwards.
 * Returns whether anything moved.
 */
export function arrangePartner(dir: string): boolean {
  let moved = false;
  for (const name of [PARTNER_FILE, PARTNER_DIR]) {
    try { if (lstatSync(join(dir, name)).isSymbolicLink()) throw new Error('Partner notes must stay inside the workspace'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const names = () => readdirSync(dir);
  for (const name of names()) {
    if (name === PARTNER_FILE || name.toLowerCase() !== PARTNER_FILE.toLowerCase() || !lstatSync(join(dir, name)).isFile()) continue;
    if (names().includes(PARTNER_FILE)) {
      appendFileSync(join(dir, PARTNER_FILE), `

--- merged from ${name} ---
${readFileSync(join(dir, name), 'utf8')}`, 'utf8');
      unlinkSync(join(dir, name));
    } else {
      renameSync(join(dir, name), join(dir, PARTNER_FILE));
    }
    moved = true;
  }
  const target = join(dir, PARTNER_DIR);
  if (names().includes(PARTNER_DIR) && lstatSync(target).isFile()) {
    const held = join(dir, `${PARTNER_DIR}.moving`);
    renameSync(target, held);
    mkdirSync(target);
    renameSync(held, join(target, PARTNER_DIR));
    moved = true;
  }
  for (const name of names()) {
    if (name === PARTNER_DIR || name.toLowerCase() !== PARTNER_DIR || !lstatSync(join(dir, name)).isDirectory()) continue;
    if (!names().includes(PARTNER_DIR)) {
      renameSync(join(dir, name), target);
    } else {
      for (const entry of readdirSync(join(dir, name))) {
        const free = existsSync(join(target, entry)) ? `${name}-${entry}` : entry;
        renameSync(join(dir, name, entry), join(target, free));
      }
      rmdirSync(join(dir, name));
    }
    moved = true;
  }
  mkdirSync(target, { recursive: true });
  return moved;
}

const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** A gap between exchanges this long is told to the front: what comes after it is often a new matter. */
export const GAP_NOTE_MS = 30 * 60_000;
/** Lines this recent belong to the delivery being made, not to the exchange before it. */
const FRESH_MS = 60_000;

/** The line telling the front how long it has been since the last exchange, or null when it has not been long. */
export function gapNote(gapMs: number, lastAt: number): string | null {
  if (gapMs < GAP_NOTE_MS) return null;
  const min = Math.round(gapMs / 60_000);
  const span = min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${Math.round(min / 1440)} days`;
  const at = new Date(lastAt);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = min >= 12 * 60 ? `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ` : '';
  return `[system] About ${span} since the last exchange (${day}${hhmm}). What comes now may have nothing to do with what was said before it.`;
}

/**
 * What the front is told about the line between what it does itself and what lasts, which the roles behind it run.
 * Model text, so English.
 */
export const ROLES_NOTE = [
  '## What you do yourself, and what goes to the back',
  'When the person talks to you, answer first: your pet_say comes before anything else you do that turn, with any motion in '
    + 'it, so they hear you at once; what takes longer (handing something on, changing a setting, looking things up) comes '
    + 'after, and you tell them in a word that it is under way. If you say you are handing work to the back, call '
    + 'delegate_task in that same turn before ending it; a promise or pet_say alone is not a handoff.',
  'Everything in the moment is yours: talking, and moving as you talk, including keeping at a motion for a while ("run '
    + 'about for a few minutes" is <run 3m> in what you say; your body works out how and tells you how it went). What lasts is '
    + 'not yours to set in passing: your habits and rhythm, how you keep out of their way, reminders, routines and your own '
    + 'rules all live in the back of your mind, which changes you yourself.',
  'So when what the person says means you should be different from now on, not only now, do what you can at once and '
    + 'hand the change on with delegate_task: their words as they said them, and what was going on. Do not work out what they really meant or '
    + 'how it should be done, and do not promise how it will be: the back reads that, with the screen and the records in view, '
    + 'and you will feel the change. "Stop blocking my typing", "talk less while I work", "stop wandering about", "remind me '
    + 'to…", "you keep doing X": a quick natural reply (your body already shies away from where they work), and hand it on. Most of what they '
    + 'say is just talk and needs none of this.',
  'Being in their way is never fixed by turning yourself down: do not fall quiet, stay put or stop moving about over it. '
    + 'They want you to keep them company, only not over where they work, and your body already keeps off that. When they '
    + 'do want you quieter or less lively, that is a change in the back like any other, and it comes back to you.',
  'Keep what they asked in your own notes as well, so you remember it next time too.',
  'The work behind you is yours: think of it as the back of your own mind, learning and tidying while you chat (learning not '
    + 'to get in their way, getting the hang of a routine). When you hand something on, give it a few words of your own '
    + '(as_i_see_it). Lines on what you are working on reach you as it changes; when the person asks what you are up to, answer '
    + 'from them, in your own voice, without asking the back again.',
  'When background work finishes, do not read its result note aloud or repeat its details. If the outcome changes something '
    + 'relevant to what the person asked or is doing, briefly tell them in your own words, like a friend would; otherwise say '
    + 'nothing. Do not dump percentages, file names, rules or tool details.',
  'Your moves run on their own while you talk; how one ended reaches you later as a [moved] line.',
].join('\n');

/** The reminder's first line: it says how she talks from now on, over whatever she said before. Model text, so English. */
export const NOW_REMINDER = '[reminder: how you talk now. Where your earlier lines in this conversation talk differently, talk this way from now on]';
/** Files her prefix holds in their latest version; a read of one is only a copy. */
const PREFIX_FILES = ['CONSTITUTION.md', 'PARTNER.md'];
export const PREFIX_COPY_NOTE = '[This file is also in your system prefix, always in its latest version. This copy was read now and may grow old; where they differ, the prefix is right.]';

/** The 说话方式 section of a self-description: the lines under that heading, up to the next heading or rule. */
export function speakingStyle(constitution: string): string {
  const lines = constitution.replace(/\r/g, '').split('\n');
  const at = lines.findIndex((l) => /^#+\s*说话方式\s*$/.test(l));
  if (at < 0) return '';
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#+\s/.test(l) || /^---+\s*$/.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

export interface PersonaOptions {
  memoryDir: string;
  dataDir?: string;
  modelsDir?: string;
  log?: Logger;
  ask?(system: string, text: string, image?: Uint8Array): Promise<string>;
  front?(): FrontEventSource | null;
  ioTools?(): ToolDef[];
}

const quietLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export class LingxiPersona {
  readonly memoryDir: string;
  readonly workspace: WorkspaceFiles;
  agents: Agents | null = null;
  eventMemory: EventMemory | null = null;
  memoryGraph: MemoryGraph | null = null;
  graphRecall: GraphRecall | null = null;
  memoryVectors: MemoryVectors | null = null;
  private store: EventStoreReader | null = null;
  private liveContext: (() => string) | null = null;
  private environment: (() => string) | null = null;
  private hints: Hints | null = null;
  private embedder: Promise<Embedder | null> | null = null;
  private embedderLoaded: Embedder | null = null;
  private lastEventCursor = 0;
  private lastInteractionAt: number | null = null;
  private gap = '';
  private memoryHint = '';
  private ownWake: { text: string; said: string[] } | null = null;
  private ownCounted = false;
  private proactive = { day: '', count: 0 };
  private closed = false;
  private readonly log: Logger;

  constructor(private readonly options: PersonaOptions) {
    this.memoryDir = options.memoryDir;
    this.log = options.log ?? quietLog;
    this.workspace = new WorkspaceFiles(this.memoryDir, this.log);
    if (options.dataDir) this.openMemory(options.dataDir);
  }

  setStore(store: EventStoreReader): void {
    this.store = store;
    this.eventMemory?.attachStore(store);
  }
  setAgents(agents: Agents): void {
    this.agents = agents;
    if (this.eventMemory && this.options.dataDir) {
      this.eventMemory.scorer?.close();
      try { this.eventMemory.scorer = new RecallScore(this.options.dataDir, agents.judgments); }
      catch (error) { this.log.warn('Recall scoring unavailable', { error }); this.eventMemory.scorer = null; }
    }
  }
  setLiveContext(read: () => string): void { this.liveContext = read; }
  setEnvironment(read: () => string): void { this.environment = read; }

  /** Loads only an already installed sentence model. Installation stays in the existing ModelSlot UI. */
  loadEmbedder(): Promise<Embedder | null> {
    if (!this.embedder) {
      const dir = this.options.modelsDir;
      if (!dir || !EMBED_MODEL.files.every((file) => existsSync(join(dir, file.name)))) return Promise.resolve(null);
      this.embedder = Embedder.load(dir).then((model) => { this.embedderLoaded = model; return model; })
        .catch((error) => { this.log.warn('Sentence model unavailable; word recall remains active', { error }); this.embedder = null; return null; });
    }
    return this.embedder;
  }

  openMemory(dataDir: string): EventMemory {
    if (this.eventMemory) return this.eventMemory;
    const memory = new EventMemory(dataDir);
    this.eventMemory = memory;
    if (this.store) memory.attachStore(this.store);
    try {
      const graph = new MemoryGraph(dataDir);
      this.memoryGraph = graph;
      this.memoryVectors = new MemoryVectors(graph, () => this.loadEmbedder(), () => this.embedderLoaded);
      this.graphRecall = new GraphRecall(graph, memory, Date.now, this.memoryVectors);
      memory.onLine = (line) => graph.addLine(line);
      memory.onCard = (card) => graph.addCard(card);
      memory.onCardDropped = (id) => graph.dropCard(id);
      memory.sync();
      for (let batch = memory.linesAfter(graph.fedLine); batch.length; batch = memory.linesAfter(graph.fedLine)) {
        for (const line of batch) graph.addLine(line);
      }
      for (let batch = memory.cardsAfter(graph.fedCard); batch.length; batch = memory.cardsAfter(graph.fedCard)) {
        for (const card of batch) graph.addCard(card);
      }
      graph.sweep();
    } catch (error) { this.log.warn('Memory graph unavailable; text recall remains active', { error }); }
    try { memory.scorer = new RecallScore(dataDir, this.agents?.judgments ?? null); }
    catch (error) { this.log.warn('Recall scoring unavailable', { error }); }
    this.hints = new Hints(memory, {
      expand: async (text) => (await this.askModel(DIG_PROMPT, text)).split('\n').map((line) => line.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean),
      late: (text) => { this.options.front?.()?.enqueue({ type: 'memory.hint', text, trigger: 'piggyback' }); },
    });
    return memory;
  }

  askModel(system: string, text: string): Promise<string> {
    if (!this.options.ask) return Promise.reject(new Error('Memory model is not configured'));
    return this.options.ask(system, text);
  }
  askImage(system: string, text: string, image: Uint8Array): Promise<string> {
    if (!this.options.ask) return Promise.reject(new Error('Memory model is not configured'));
    return this.options.ask(system, text, image);
  }
  petTool(name: string): ToolDef | undefined { return this.options.ioTools?.().find((tool) => tool.name === name); }
  noteOwn(text: string, kind: string): void {
    this.options.front?.()?.enqueue({ type: kind, text, trigger: kind === 'rhythm' ? 'preempt' : 'piggyback' });
  }
  topicsToday(): string[] { return this.eventMemory?.episodesSince(startOfToday()).map((episode) => episode.title) ?? []; }
  spokenToday(): number { return this.proactive.day === dayOf(Date.now()) ? this.proactive.count : 0; }
  lastInteraction(): number | null { return this.lastInteractionAt; }
  gitAvailable(): boolean { return this.workspace.gitAvailable(); }
  readConstitution(): string {
    const file = this.workspace.path('CONSTITUTION.md');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  }
  async saveConstitution(value: string): Promise<void> {
    if (!value.trim()) throw new Error('角色设定不能为空');
    if (value.length > 12_000) throw new Error('角色设定不能超过 12000 个字符');
    const file = this.workspace.path('CONSTITUTION.md');
    writeFileSync(`${file}.tmp`, value.replace(/\r\n/g, '\n'), 'utf8');
    renameSync(`${file}.tmp`, file);
    this.workspace.commit('Update character settings', AUTHOR_APP);
  }
  snapshot(version: string): void {
    this.workspace.snapshot(version);
    try { if (arrangePartner(this.memoryDir)) this.workspace.commit('Arrange partner notes', AUTHOR_APP); }
    catch (error) { this.log.warn('Partner notes could not be arranged', { error }); }
  }

  fileTools(): ToolDef[] {
    return this.workspace.tools().map((tool) => tool.name !== 'read_file' ? tool : { ...tool, handler: async (args, context) => {
      const result = await tool.handler(args, context);
      const path = String(args.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
      return typeof result === 'string' && PREFIX_FILES.includes(path) ? `${result}\n\n${PREFIX_COPY_NOTE}` : result;
    } });
  }

  frontTools(ioTools = this.options.ioTools?.() ?? []): ToolDef[] {
    const recall = this.graphRecall?.tool() ?? this.eventMemory?.recallTool();
    const tools = [...this.fileTools(), ...ioTools, ...(this.agents?.frontTools() ?? []), ...(recall ? [recall] : [])];
    const busNames = new Set(this.agents?.frontTools().map((tool) => tool.name) ?? []);
    return tools.map((tool) => {
      const speech = tool.name === 'pet_say' || tool.name === 'pet_ask';
      return { ...tool, ...(speech && this.graphRecall ? { parameters: withUsed(tool.parameters) } : {}), handler: async (raw, context) => {
        const { used, ...args } = raw;
        if (speech) {
          if (Array.isArray(used) && this.graphRecall) {
            try {
              this.eventMemory?.sync();
              const cue = this.eventMemory?.lastLine('person');
              this.graphRecall.used(used.map(String), cue ? this.memoryGraph?.nodeByRef(`line:${cue.id}`)?.id ?? null : null);
            } catch (error) { this.log.warn('Memory use feedback failed', { error }); }
          }
          const text = String(args.script ?? args.question ?? '');
          this.eventMemory?.scorer?.onPetSaid(text.replace(/【[^】]*】/g, ''));
          if (this.ownWake) {
            this.ownWake.said.push(text);
            if (!this.ownCounted) {
              const day = dayOf(Date.now());
              this.proactive = { day, count: (this.proactive.day === day ? this.proactive.count : 0) + 1 };
              this.ownCounted = true;
            }
          }
        }
        const result = await tool.handler(speech ? args : raw, context);
        if (!busNames.has(tool.name) && tool.tags.some((tag) => tag === 'act' || tag === 'write')) {
          try { this.agents?.ledger.append({ role: 'front', actor: 'front', op: 'action', summary: `${tool.name} ${JSON.stringify(raw)}`,
            result: typeof result !== 'string' && result.failed ? 'fail' : 'ok' }); }
          catch (error) { this.log.warn('Front action audit failed; tool result retained', { error }); }
        }
        return result;
      } };
    });
  }

  /** New input is observed once; delivery confirmation stays with the front agent/application. */
  async onEvents(events: EventEnvelope[]): Promise<void> {
    const fresh = events.filter((event) => event.cursor > this.lastEventCursor);
    if (!fresh.length) return;
    this.lastEventCursor = Math.max(...fresh.map((event) => event.cursor));
    try { this.eventMemory?.sync(); } catch (error) { this.log.warn('Memory sync unavailable for this input', { error }); }
    const now = Date.now();
    let last = this.lastInteractionAt;
    if (last === null) last = this.eventMemory?.lastLineBefore(now - FRESH_MS) ?? null;
    this.gap = last === null ? '' : gapNote(now - last, last) ?? '';
    const external = fresh.filter((event) => event.origin === 'external');
    if (external.length) {
      this.onTurnEnded(true);
      this.lastInteractionAt = now;
    } else {
      const wake = fresh.find((event) => event.type === 'rhythm');
      if (wake) { this.ownWake = { text: wake.text, said: [] }; this.ownCounted = false; }
    }
    const heard = fresh.filter((event) => event.origin === 'external' && ['pet.message', 'pet.answer', 'desktop-pet.message', 'desktop-pet.speech'].includes(event.type))
      .map((event) => personMessageText(event as unknown as Record<string, unknown>));
    for (const text of heard) { this.eventMemory?.scorer?.onPersonSaid(text); this.graphRecall?.heard(text); }
    if (heard.length) {
      try { this.memoryHint = this.graphRecall ? await this.graphRecall.comesToMind(heard.join(' ')) ?? '' : this.hints?.for(heard.join(' ')) ?? ''; }
      catch (error) { this.log.warn('Relevant memory unavailable for this input', { error }); }
    }
  }

  private recentBodyFacts(): string {
    if (!this.store) return '';
    const latest = this.store.latestCursor();
    const actions = new Map<string, { action: string; state: string; started?: string; ended?: string }>();
    const interactions = new Map<string, { kind: string; state: string; at: string; x?: number; from?: number }>();
    // Keep the existing recent body window; raw drag frames stay out of conversation history.
    for (const event of this.store.range({ fromCursor: Math.max(1, latest - 119), toCursor: latest })) {
      const meta = event.meta ?? {};
      if (event.type === 'pet.action' && typeof meta.actionId === 'string') {
        const old = actions.get(meta.actionId) ?? { action: String(meta.action ?? 'body action'), state: 'unknown' };
        const state = String(meta.state ?? 'unknown');
        actions.set(meta.actionId, { ...old, state, ...(state === 'started' ? { started: event.ts } : { ended: event.ts }) });
      }
      if (event.type === 'pet.interaction' && typeof meta.interactionId === 'string') interactions.set(meta.interactionId, {
        kind: String(meta.kind ?? 'body interaction'), state: String(meta.state ?? 'unknown'), at: String(meta.at ?? event.ts),
        ...(typeof meta.x === 'number' ? { x: meta.x } : {}), ...(typeof meta.from === 'number' ? { from: meta.from } : {}),
      });
    }
    const lines = [
      ...[...actions].map(([id, item]) => `- pet action: ${item.action}; actionId=${id}; state=${item.state}; started=${item.started ?? 'unknown'}; ended=${item.ended ?? 'unknown'}`),
      ...[...interactions].map(([id, item]) => `- user interaction: ${item.kind}; interactionId=${id}; state=${item.state}; at=${item.at}${item.from === undefined ? '' : `; from=${item.from}`}${item.x === undefined ? '' : `; position=${item.x}`}`),
    ];
    return lines.length ? `[recent body facts; use as context, do not quote mechanically]\n${lines.join('\n')}` : '';
  }

  async context(): Promise<{ system: string; head: string; tail: string }> {
    try { this.eventMemory?.sync(); } catch (error) { this.log.warn('Memory sync unavailable for this context', { error }); }
    const constitution = this.readConstitution();
    const partner = this.workspace.path(PARTNER_FILE);
    const notes = existsSync(partner) ? readFileSync(partner, 'utf8') : '';
    const files = this.workspace.files();
    const listing = [...files.filter((file) => !file.startsWith(`${ARCHIVE_DIR}/`) && !file.startsWith('blobs/')),
      ...(files.some((file) => file.startsWith(`${ARCHIVE_DIR}/`)) ? [`${ARCHIVE_DIR}/ (archived files; search with glob_files or grep_files)`] : [])];
    const system = [constitution || 'You are Lingxi, a desktop companion.', `${PARTNER_NOTE}\n\n${notes || '(No partner notes yet.)'}`,
      MEMORY_NOTE, `[memory workspace]\n${listing.join('\n')}`, this.environment?.(), this.agents ? ROLES_NOTE : ''].filter(Boolean).join('\n\n');
    const style = speakingStyle(constitution);
    const quiet = this.agents?.drainQuiet() ?? [];
    const tail = [`[current time: ${new Date().toISOString()}]`, style && `${NOW_REMINDER}\n${style}`, this.liveContext?.(),
      this.agents?.permissionContext(), this.agents?.behind(), quiet.length && `[daily layer]\n${quiet.join('\n')}`,
      this.recentBodyFacts(), this.gap, this.memoryHint].filter(Boolean).join('\n\n');
    return { system, head: '', tail };
  }

  onTurnEnded(interruptedByPerson = false): void {
    const wake = this.ownWake;
    this.ownWake = null;
    if (wake) {
      try { this.agents?.judgments.record({ kind: 'proactive-speak', judge: 'front-provider', input: { wake: wake.text }, output: { spoke: wake.said.length > 0, said: wake.said, interruptedByPerson } }); }
      catch (error) { this.log.warn('Proactive speech audit failed', { error }); }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.eventMemory?.close();
    this.memoryGraph?.close();
  }
}

function withUsed(parameters: ToolDef['parameters']): ToolDef['parameters'] {
  return { ...parameters, properties: { ...(parameters.properties as Record<string, unknown> ?? {}), used: {
    type: 'array', items: { type: 'string' }, description: 'Hidden memory marks (#m12) this line draws on; omit when none. Never shown or spoken.',
  } } };
}
