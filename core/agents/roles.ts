/**
 * The roles behind the front: the control center and the code agents, each run as a isolated LangChain task when the task bus
 * hands it a task. The front (its main session) talks to them only through the bus, with the tools in
 * `FRONT_TOOL_DECLS`; results come back as an internal event, which wakes it. The result of a task the control center
 * gave a code agent goes back to the control center as a new task under the same incident. Why it is built this way
 * is noted with the code (A1).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DescribeText, SessionDecl, ToolDef, Logger, FrontEventSource } from '../contracts.ts';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Cases, caseIdOf, isInternalWorkareaCaseTask, type CaseInput, type StoredCase } from './cases.ts';
import { WORKAREA_KIND, workareaKind } from '../daily/workarea-case.ts';
import { Ledger, toText } from '../ledger/ledger.ts';
import { TaskBus, UncertainTaskError, isInternalTask, type ConfirmedTaskSuccess, type RunControl, type Task, type Worker } from './bus.ts';
import type { DshBackend, PermissionAsk } from './dsh.ts';
import { DshKeeper } from './dsh-keeper.ts';
import { CodeAgentKeeper, unsupportedPolicy } from './code-agent-keeper.ts';
import type { CodeAgentAdapter, CodePermissionRequest, CodeRunRef, CodeTask } from './code-agent.ts';
import { PermissionRules, permissionKind } from './permission-rules.ts';
import { PetToolServer } from './mcp.ts';
import { Playbook } from './playbook.ts';
import { describeReminder, ReminderEngine, ReminderStore, type Reminder, type Schedule } from '../daily/reminders.ts';
import { RHYTHM_DEFAULTS } from '../rhythm.ts';
import { WorkMap, type WindowLook } from '../daily/workmap.ts';
import { MovedAwayDetector } from '../daily/placement.ts';
import { Judgments } from '../learning/judgments.ts';
import { DSH_MODEL } from './dsh.ts';
import { runControl } from '../runtime/control-runner.ts';

/** Session ids of the two fork roles, as the Persona declares them. */
export const SESSION: Record<Worker, string> = { control: 'control', coder: 'coder' };
/** Where each fork role may write in the workspace; reading is open to all. */
export const WRITABLE: Record<Worker, string> = { control: 'control/', coder: 'control/drafts/' };
/** Ledger rows a runner is shown of its incident: enough to pick up the thread, few enough to stay cheap. */
const HISTORY_ROWS = 30;
const DAY_MS = 86_400_000;
/** Longest a task of the control center or a code agent runs before it is stopped. */
/** How long an approval DSH asks for waits for the person before it is refused. */
const PERMISSION_WAIT_MS = 120_000;
/** An interaction this recent means the person is with the pet, so a reminder is said in context by the front. */
const ENGAGED_MS = 5 * 60_000;

const PROMPT: Record<Worker, string> = {
  control: [
    'You are the control center behind a desktop pet. You sleep until a task arrives and stop when it is handled.',
    'Tasks come from the front (the pet that talks with the person) or come back from code agents you dispatched.',
    'Before deciding anything, work out what the person wants: the pet relays their words as said; read them for the outcome '
      + 'they are after, not the literal words, with what came before and the screen when it is about the screen. Record that '
      + 'reading in one line with record_decision, then choose the way.',
    'Handle what is in front of you now yourself. When something should be done by a script or a small model from now on, '
      + 'give it to a code agent with dispatch_code_task and do not wait for it: its result comes back to you as a new task.',
    'Record each real decision with record_decision. Use tell_front only for what the person should hear before you finish; '
      + 'your final reply goes to the front as the result.',
    `You may write only under ${WRITABLE.control} in the workspace: keep notes there so the next takeover knows what you knew.`,
    'Be brief: what you did, what you decided and why.',
  ].join('\n'),
  coder: [
    'You are a code agent behind a desktop pet. You write and change the scripts and small models of its daily layer.',
    `Write only under ${WRITABLE.coder} in the workspace. Nothing there goes live: a separate test and promotion step decides that.`,
    'For each change write the code, tests that show it works, and a short README saying what it is for and how it was checked.',
    'Your final reply goes back to the control center: which files you wrote, what the tests cover, and what you could not verify.',
  ].join('\n'),
};

type Decl = Omit<ToolDef, 'handler'>;

const TASK_ID = { type: 'string', description: 'The task id from delegate_task or task_status.' };

/** The front's tools for the bus. */
export const FRONT_TOOL_DECLS: readonly Decl[] = [
  {
    name: 'delegate_task',
    description: 'Hand a task to the control center behind you and carry on; its result comes to you later as an event. '
      + 'If the person explicitly asks you to hand work to the background, use this tool before saying it has been handed off; never claim a handoff without calling it. '
      + 'Use it for anything that takes more than a moment, something that went wrong, a problem the person reports, and '
      + 'anything that should keep running on its own: recurring reminders, routines, things to watch for, and where you should '
      + 'stand for the long run when you are in the person\'s way (your body shies away by itself; no need to move it). Pass on what '
      + 'they said as they said it, and what was going on; do not work out what they meant or how to do it: the control center '
      + 'does that, with the screen and the records in view, and decides how it runs, often without a model call each time. A '
      + 'one-off alarm in the next hours you may still set yourself. Mark it urgent only when it cannot wait for the task in hand.',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: {
        their_words: { type: 'string', description: 'What the person said, word for word (several things they said on it, each as said).' },
        context: { type: 'string', description: 'Facts only: what was going on when they said it, and what you already did about it.' },
        task: { type: 'string', description: 'Anything else the back should know. Not your reading of what they meant.' },
        as_i_see_it: { type: 'string', description: 'A few words, in your own voice, for this work as part of you (学着别挡着他); it is how you will think of it while it runs.' },
        urgent: { type: 'boolean', description: 'Take it before other waiting tasks, pausing a normal one if need be.' },
      },
      required: ['their_words'],
    },
  },
  {
    name: 'task_status',
    description: 'List the tasks still open behind you, or show one task by id.',
    tags: ['read'],
    parameters: { type: 'object', properties: { id: TASK_ID } },
  },
  {
    name: 'task_note',
    description: 'Add something the person said to an open task; the role working on it reads it.',
    tags: ['act'],
    parameters: { type: 'object', properties: { id: TASK_ID, note: { type: 'string' } }, required: ['id', 'note'] },
  },
  {
    name: 'cancel_task',
    description: 'Cancel an open task, for example when the person changed their mind.',
    tags: ['act'],
    parameters: { type: 'object', properties: { id: TASK_ID }, required: ['id'] },
  },
  {
    name: 'wake_list',
    description: 'List everything that wakes you on your own: reminders and your own rhythm of looking up, with their next times. '
      + 'To change, add or stop one, delegate it.',
    tags: ['read'],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'answer_permission',
    description: "Pass on the person's answer to a permission the background asked for. Only the person decides: "
      + 'ask them first and never answer on your own. An unanswered request is refused after two minutes.',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The permission id from the request.' },
        allow: { type: 'boolean' },
        always: { type: 'boolean', description: 'They allowed this kind from now on, not just this once.' },
        note: { type: 'string', description: 'What they wrote in their own words, if anything, as they meant it; it goes to the one who asked.' },
      },
      required: ['id', 'allow'],
    },
  },
];


const SCHEDULE_PARAM = {
  type: 'object',
  description: 'Local time. Give one of every_minutes (at least 5), times, or jitter_min/jitter_max (a random interval, the '
    + "rhythm's way); from/to bound every_minutes and jitter to a daily window; days limits the weekdays.",
  properties: {
    every_minutes: { type: 'integer' },
    jitter_min: { type: 'integer', description: 'Minutes, at least 5.' },
    jitter_max: { type: 'integer', description: 'Minutes, no less than jitter_min.' },
    times: { type: 'array', items: { type: 'string' }, description: 'HH:MM' },
    days: { type: 'array', items: { type: 'integer' }, description: '0 = Sunday … 6 = Saturday' },
    from: { type: 'string', description: 'HH:MM' },
    to: { type: 'string', description: 'HH:MM' },
  },
};
const REMINDER_FIELDS = {
  title: { type: 'string' },
  kind: { type: 'string', enum: ['simple', 'smart'], description: 'simple: said from lines with no model call; smart: the front decides what to say when it fires.' },
  schedule: SCHEDULE_PARAM,
  lines: { type: 'array', items: { type: 'string' }, description: "For simple: 8–12 varied lines in the pet's voice, so it does not repeat itself. "
    + 'They are kept and said word for word for weeks, while the pet may change how it talks: write what to say, plainly, '
    + 'without catchphrases or verbal tics; the front adds its own manner when it says one.' },
  guide: { type: 'string', description: 'For smart: what the front should weigh when it fires.' },
  motion: { type: 'string', description: 'For simple: what the pet does as it says one, in its action words, the same the front uses '
    + '(wave, jump; run 3s; spin x2). Pick what catches the eye for this nudge; left out, it waves and hops.' },
  why: { type: 'string', description: 'Why this kind and schedule; it goes into the ledger.' },
};
const RHYTHM_FIELDS = {
  skip_chance: { type: 'number', description: 'Rhythm only: the chance a look is let pass, 0–0.95.' },
  daily_speaking: { type: 'integer', description: 'Rhythm only: about how many times a day it may speak on its own.' },
};

/** The control center's own tools, next to the workspace file tools. */
export const CONTROL_TOOL_DECLS: readonly Decl[] = [
  {
    name: 'dispatch_code_task',
    description: 'Give a code agent a script or small model to write or change. Returns at once; the result comes back to you as a new task.',
    tags: ['act'],
    parameters: { type: 'object', properties: { task: { type: 'string' }, urgent: { type: 'boolean' } }, required: ['task'] },
  },
  {
    name: 'report_progress',
    description: 'Say in a few plain words what you are doing on this task now (looking at where he works; trying the right side). '
      + 'The pet knows it without being woken, and can answer the person from it. Call it when you start and when the picture changes.',
    tags: ['act'],
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'tell_front',
    description: 'Tell the front something the person should hear now, before you finish.',
    tags: ['speak'],
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'incident_history',
    description: 'Read the ledger of an incident: who did what, why, and how it turned out. Defaults to the current one.',
    tags: ['read'],
    parameters: { type: 'object', properties: { incident: { type: 'string' } } },
  },
  {
    name: 'record_decision',
    description: 'Record a decision and its reason in the ledger, so a later takeover can judge whether it was right.',
    tags: ['act'],
    parameters: { type: 'object', properties: { decision: { type: 'string' }, why: { type: 'string' } }, required: ['decision', 'why'] },
  },
  {
    name: 'control_write',
    description: 'Write or append to a file under control/ in the pet\'s workspace: your notes, rules (control/rules/), standards '
      + '(control/standards/), drafts (control/drafts/). Paths elsewhere are refused. Each write is kept in the workspace history.',
    tags: ['write'],
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative to the workspace, starting with control/.' },
        content: { type: 'string' },
        append: { type: 'boolean', description: 'Add to the end instead of replacing the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'screen_glance',
    description: "Look at the person's screen now: what they are doing, the windows open with their places, and where the pet "
      + 'stands. Nothing is kept of the picture.',
    tags: ['read'],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'case_decide',
    description: 'Answer a case you were given ([case <id>] at the top of the task): the answer as JSON in the shape the case '
      + 'asks for. It is checked; if something is missing or wrong you are told and may answer again. What the answer '
      + 'brings about is done for you and kept as this matter\'s history.',
    tags: ['act'],
    parameters: {
      type: 'object',
      properties: { case_id: { type: 'string' }, answer: { type: 'object', description: 'The answer, in the shape the case asks for.' } },
      required: ['case_id', 'answer'],
    },
  },
  {
    name: 'case_look',
    description: 'Ask about a picture of a case when you cannot see it yourself: a model that sees it answers your question '
      + 'about it in detail. picture is its number in the case (1 first).',
    tags: ['read'],
    parameters: {
      type: 'object',
      properties: { case_id: { type: 'string' }, picture: { type: 'number' }, question: { type: 'string' } },
      required: ['case_id', 'question'],
    },
  },
  {
    name: 'wake_create',
    description: 'Add a reminder to the wake table, the one place for everything that wakes the pet on its own. Decide simple or smart '
      + 'from what the person needs: a fixed nudge is simple; one that depends on what they are doing or on the day is smart. '
      + 'Either is said by the front in context while the person is with the pet.',
    tags: ['act'],
    parameters: { type: 'object', properties: REMINDER_FIELDS, required: ['title', 'kind', 'schedule', 'why'] },
  },
  {
    name: 'wake_update',
    description: "Change an entry of the wake table: a reminder's schedule, kind, lines (replacing them all) or guide; the rhythm's "
      + 'window, interval, skip_chance and daily_speaking; or active to pause and resume either.',
    tags: ['act'],
    parameters: { type: 'object', properties: { id: { type: 'string' }, ...REMINDER_FIELDS, ...RHYTHM_FIELDS, active: { type: 'boolean' } }, required: ['id', 'why'] },
  },
  {
    name: 'wake_list',
    description: 'List the wake table: the rhythm and every reminder, with their settings and next times.',
    tags: ['read'],
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'wake_delete',
    description: 'Remove a reminder for good. The rhythm cannot be removed; pause it with wake_update instead.',
    tags: ['act'],
    parameters: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] },
  },
];

/** One line per tool for people, for the bot's self-description. */
export const AGENT_TOOL_SUMMARIES: Readonly<Record<string, DescribeText>> = {
  delegate_task: { zh: '把任务交给后台的控制中心，不等结果，做完会以事件回来。', en: 'Hands a task to the control center and carries on; the result comes back as an event.' },
  task_status: { zh: '列出还没做完的后台任务，或按 id 看一个。', en: 'Lists open background tasks, or shows one by id.' },
  task_note: { zh: '给进行中的任务补一句话。', en: 'Adds a note to an open task.' },
  cancel_task: { zh: '取消一个还没做完的任务。', en: 'Cancels an open task.' },
  answer_permission: { zh: '把你对后台权限请求的答复转过去（这一次 / 同类以后都行 / 不行，以及你的原话）；没答复两分钟后自动拒绝。', en: "Passes on the person's answer to a permission request (once, this kind from now on, or no, and their own words); unanswered ones are refused." },
  dispatch_code_task: { zh: '控制中心把写脚本、调小模型的活派给代码 agent。', en: 'The control center gives a code agent a script or small model to build.' },
  tell_front: { zh: '控制中心在做完前先告诉前台一件事。', en: 'The control center tells the front something before it finishes.' },
  report_progress: { zh: '后台用大白话说一句正在干什么，前台不用被叫醒就知道。', en: 'The worker says in plain words what it is doing; the front knows without being woken.' },
  incident_history: { zh: '读一件事在账本里的前因后果。', en: "Reads an incident's history from the ledger." },
  record_decision: { zh: '把一个决定和理由记进账本。', en: 'Records a decision and its reason in the ledger.' },
  wake_list: { zh: '列出唤醒表：作息和所有提醒。', en: 'Lists the wake table: the rhythm and every reminder.' },
  screen_glance: { zh: '控制中心看一眼屏幕：在干什么、开着哪些窗口在哪、桌宠站在哪；图不留。', en: 'The control center glances at the screen; nothing is kept.' },
  control_write: { zh: '控制中心写 control/ 下的文件（规则、标准、笔记、草稿），别处一律拒绝。', en: 'The control center writes files under control/ only.' },
  wake_create: { zh: '控制中心往唤醒表里加一条提醒，自己判断用简单还是复杂的。', en: 'The control center adds a reminder, simple or smart.' },
  wake_update: { zh: '改唤醒表里的一项：提醒的时间、话术、类型，作息的时段、间隔、跳过概率、每天主动说话次数，或暂停、恢复。', en: 'Changes, pauses or resumes a reminder or the rhythm.' },
  wake_delete: { zh: '删掉一条提醒（作息只能暂停，不能删）。', en: 'Removes a reminder; the rhythm can only be paused.' },
};

/**
 * A task from the front as the control center gets it: the person's words as said and the facts around them, with the
 * front's own words kept apart, and the asking to work out what the person wants first. The front only relays; reading
 * intent is the back's.
 */
export function delegateBody(args: Record<string, unknown>): string {
  const words = str(args.their_words).trim();
  const context = str(args.context).trim();
  const extra = str(args.task).trim();
  const lines = [
    ...(words ? [`The person said: 「${words}」`] : []),
    ...(context ? [`What was going on, and what the pet already did: ${context}`] : []),
    ...(extra ? [words ? `The pet adds: ${extra}` : extra] : []),
  ];
  if (words) {
    lines.push('First work out what they want: the outcome they are after, not the words. Look at the screen when it is about '
      + 'the screen, and at what came before. Say it in one line in your record, then choose how.');
  }
  return lines.join('\n');
}

/**
 * What the front is told when the background asks for a permission: who asks, for what work, what exactly and what it
 * said about why, the kind a standing answer would cover, and how to ask the person.
 */
export function permissionNotice(id: string, who: string, task: Task, ask: PermissionAsk, kind: string): string {
  return [
    `[permission ${id}] The ${who} wants to go past what it may do on its own, for the work "${task.label ?? task.body.split('\n')[0]!.slice(0, 80)}".`,
    `What it wants to do: ${ask.title}${ask.detail ? ` ${ask.detail}` : ''}`,
    ...(ask.said ? [`Why it says it needs this: ${ask.said}`] : []),
    `"The same kind" would be: ${kind}`,
    'Ask the person now with pet_ask: one short sentence in everyday words saying what it wants to do and what for (no tool',
    'names, no JSON, no paths unless the place matters), and the options "just this once", "no", and "this kind from now on",',
    'in your language. Leave out the third when it reaches the network, installs something, deletes, or touches you while',
    'you run or the person\'s own files. Then pass on their answer with answer_permission: allow, always for the third, and',
    'note with their own words when they wrote any. Pass requestId="' + id + '" to pet_ask. Unanswered, it is refused in two minutes.',
  ].join('\n');
}

export interface AgentsOptions {
  dataDir: string;
  log: Logger;
  front?: () => FrontEventSource | null;
  /** LangChain model configured by the app for the requested background role. */
  model?: (role: 'control' | 'coder') => BaseChatModel | null;
  onUsage?: (usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }, role: string) => void;
  /** The workspace file tools; writes are fenced by the Persona's write guard with `WRITABLE`. */
  fileTools: () => ToolDef[];
  coderLimit?: number;
  retentionDays?: number;
  /** Legacy control-center DSH hook; production wiring leaves this omitted and uses the Host fork. */
  dsh?: DshBackend | null;
  /** Legacy direct DSH code hook; use `codeAgent` for provider-neutral wiring. */
  dshCode?: DshBackend | null;
  /** An external code-agent adapter. When set, it takes precedence over the legacy dshCode entry. */
  codeAgent?: CodeAgentAdapter | null;
  /** The isolated code-agent workspace passed to external providers. */
  codeWorkspace?: { cwd: string; writableRoot: string; readRoots?: string[] };
  /** Readies the code agent's own folder before each of its tasks: the copies it works from (code-home.ts). */
  prepareCode?: () => Promise<void>;
  /** The workspace, where the playbook (rules, standards, catalog) lives. */
  workspaceDir?: string;
  /** Says a line through the pet with no model call, doing `motion` (action words) as it does; false when it could not be shown. */
  say?: (line: string, motion: string) => Promise<boolean>;
  /** When the person last interacted with the pet, epoch ms; null when never. */
  lastInteraction?: () => number | null;
  /** Asks a model that sees pictures about one: for a case's pictures when the control center cannot be shown them. */
  lookAt?: (system: string, text: string, jpeg: Uint8Array) => Promise<string>;
  /** Routes newly started control tasks through the framework runner when enabled. */
  frameworkControl?: boolean;
  now?: () => Date;
}

/** A schedule as the tools take it. */
function scheduleOf(v: unknown): Schedule | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const s: Schedule = {};
  if (typeof o.every_minutes === 'number') s.everyMinutes = o.every_minutes;
  if (typeof o.jitter_min === 'number' || typeof o.jitter_max === 'number') {
    s.jitter = { minMinutes: Number(o.jitter_min ?? o.jitter_max), maxMinutes: Number(o.jitter_max ?? o.jitter_min) };
  }
  if (Array.isArray(o.times)) s.times = o.times.map(String);
  if (Array.isArray(o.days)) s.days = o.days.map(Number);
  if (typeof o.from === 'string') s.from = o.from;
  if (typeof o.to === 'string') s.to = o.to;
  return s;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function bind(decls: readonly Decl[], handlers: Record<string, ToolDef['handler']>): ToolDef[] {
  return decls.map((d) => ({ ...d, handler: handlers[d.name]! }));
}

export class Agents {
  readonly ledger: Ledger;
  readonly bus: TaskBus;
  private readonly opts: AgentsOptions;
  private prune: NodeJS.Timeout | null = null;
  private resultRetry: NodeJS.Timeout | null = null;
  private permissionPoll: NodeJS.Timeout | null = null;
  private closing: Promise<void> | null = null;
  /** Permission requests from DSH waiting for the person, by id. */
  private readonly asks = new Map<string, { resolve: (allow: boolean, how?: 'answered' | 'interrupted') => void; incidentId: string; taskId: string; kind: string; what: string }>();
  private readonly permissionRelay = new Map<string, { state: 'notice' | 'asked' | 'presented' | 'answered'; questionId?: string; channels?: string[] }>();
  private readonly permissionRepairs = new Map<string, 'interrupted' | 'timed_out'>();
  /** Standing answers to permission requests: a kind the person allowed from now on is not asked again. */
  readonly permissionRules: PermissionRules;
  readonly reminders: ReminderEngine;
  readonly playbook: Playbook | null;
  /** Judgments the person may confirm or overturn, kept as learning material. */
  readonly judgments: Judgments;
  private readonly tools: PetToolServer;
  /** What the daily layer said without the front, for the front to read the next time it wakes. */
  private quiet: string[] = [];
  /** Where the pet may stand per window layout, learnt from looks, activity and the person's hand (workmap.ts). */
  readonly workmap: WorkMap;
  /** Cases handed to the control center with their facts, pictures and history (cases.ts). */
  readonly cases: Cases;
  private readonly movedAway = new MovedAwayDetector();
  /** Builds and hands on a work-area case (set by the app, which has the screen and the pet); null sends a line instead. */
  openWorkareaCase: ((why: string) => void) | null = null;
  /** Settles a work-area plan from a case's answer (set by the app, which knows where that window stood); returns what it did. */
  settleWorkarea: ((key: string, keepOut: Array<[number, number]>, free: Array<[number, number]>, caseId: string, confidence: number) => string) | null = null;
  /** A look at the screen as text (screen_glance), the pet's roaming handed a policy, the program in front: set by the app. */
  screen: (() => Promise<string>) | null = null;
  /** The window in front as last read, for marking corrections on its layout (workmap.ts). */
  currentLook: (() => WindowLook | null) | null = null;
  foreground: (() => string | null) | null = null;
  petX: (() => number | null) | null = null;
  /** What one look of the rhythm does (rhythm.ts); set by the app once the screen and the model are at hand. */
  look: ((r: Reminder) => Promise<void>) | null = null;
  readonly dshKeeper: DshKeeper | null;
  readonly codeKeeper: DshKeeper | null;
  readonly codeAgentKeeper: CodeAgentKeeper | null;

  /** Opens the ledger and the bus; nothing runs before `start`. */
  constructor(opts: AgentsOptions) {
    this.opts = opts;
    this.dshKeeper = opts.dsh === undefined ? null : new DshKeeper({ backend: () => opts.dsh ?? null });
    this.codeKeeper = opts.dshCode === undefined ? null : new DshKeeper({ backend: () => opts.dshCode ?? null });
    this.codeAgentKeeper = opts.codeAgent === undefined ? null : new CodeAgentKeeper({ backend: () => opts.codeAgent ?? null });
    this.permissionRules = new PermissionRules(opts.dataDir);
    // the bot is built before the app creates its data directory
    mkdirSync(opts.dataDir, { recursive: true });
    this.ledger = new Ledger(join(opts.dataDir, 'ledger.sqlite'), { retentionDays: opts.retentionDays });
    this.bus = new TaskBus(join(opts.dataDir, 'bus.sqlite'), {
      runners: { control: (t, c) => this.run(t, c), coder: (t, c) => this.run(t, c) },
      alternateRunners: opts.frameworkControl ? { 'framework-v1': { control: (t, c) => this.run(t, c) } } : undefined,
      defaultRunnerIds: opts.frameworkControl ? { control: 'framework-v1' } : undefined,
      limits: { control: 1, coder: opts.coderLimit ?? 2 },
      ledger: this.ledger,
      onSettled: (t) => this.settled(t),
    });
    const now = opts.now ?? (() => new Date());
    this.reminders = new ReminderEngine(new ReminderStore(join(opts.dataDir, 'reminders.sqlite')), {
      say: async (line, motion) => {
        const shown = (await opts.say?.(line, motion)) ?? false;
        if (shown) this.quiet.push(`[${hhmm(now())}] the pet said, as a reminder: ${line}`);
        return shown;
      },
      wakeFront: (r, why, suggestion) => this.wakeFront(r, why, suggestion),
      rhythm: (r) => this.look?.(r) ?? Promise.resolve(),
      onStale: (r) => this.bus.submit({
        to: 'control', from: 'daily', ...(r.incidentId ? { incidentId: r.incidentId } : {}),
        body: `Reminder ${r.id} (${r.title}) has used its lines enough. Write 8–12 fresh, varied ones in the same spirit and set them `
          + `with wake_update. The current lines:\n${r.lines.map((l) => `- ${l}`).join('\n')}`,
      }),
      engaged: () => { const t = opts.lastInteraction?.(); return t !== null && t !== undefined && now().getTime() - t < ENGAGED_MS; },
      ledger: this.ledger,
      now,
    });
    this.judgments = new Judgments(join(opts.dataDir, 'judgments'));
    this.workmap = new WorkMap(join(opts.dataDir, 'workmap.sqlite'));
    this.cases = new Cases(join(opts.dataDir, 'cases'));
    this.cases.register(WORKAREA_KIND, workareaKind((c, keepOut, free, confidence) =>
      this.settleWorkarea ? this.settleWorkarea(c.key, keepOut, free, c.id, confidence) : 'kept only: nothing to settle it in'));
    this.playbook = opts.workspaceDir ? new Playbook(opts.workspaceDir) : null;
    this.playbook?.seed();
    this.tools = new PetToolServer((key) => {
      const t = this.bus.get(key);
      // the control center's own tools, and the workspace's read tools (which stay inside the workspace)
      return t && t.to === 'control' && t.status === 'running'
        ? [...this.controlTools(t), ...this.opts.fileTools().filter((x) => x.tags.includes('read'))] : null;
    });
  }

  /**
   * The person threw the pet or picked it up and put it elsewhere at `at`. Often enough in a short while, the matter goes
   * to the control center, as a workarea case when the app builds them (workarea-case.ts).
   */
  noteMovedAway(at: number): void {
    if (!this.movedAway.note(at)) return;
    // with the app's case builder, the control center gets the whole picture (workarea-case.ts), not a line of text
    if (this.openWorkareaCase) {
      this.openWorkareaCase(`The person moved the pet ${this.movedAway.recent(at)} times in the last ${MOVED_AWAY_MIN} minutes, `
        + 'each time while it was walking or soon after it walked there: plain trouble with where it walks.');
      return;
    }
    const x = this.petX?.() ?? null;
    const app = this.foreground?.() ?? null;
    this.bus.submit({
      to: 'control', from: 'daily',
      body: `The person moved the pet away ${this.movedAway.recent(at)} times in the last ${MOVED_AWAY_MIN} minutes, each time far, and each `
        + `time soon after it had walked to that spot (moves that look like play are not counted)${x !== null ? `; it now stands at ${Math.round(x * 100)}% of its screen width` : ''}. The program in front: ${app ?? 'unknown'}. `
        + 'Maybe it is in the way of where they work, maybe they are playing with it. Look at the screen with screen_glance and at '
        + 'the recent talk (incident_history is empty for this; recall is the front\'s), then decide. The pet has already '
        + 'learnt from these moves where it should not stand for this window. Tell the front only if the person should hear of '
        + 'it; if it is play, leave it. Record your decision.',
    });
  }

  /** What the front's work behind it is doing now, one line per open task in the front's own words; empty when nothing is. */
  behind(): string {
    return this.bus.list({ open: true }).filter((t) => !isInternalTask(t) && !isInternalWorkareaCaseTask(t, this.cases)).map((t) => {
      const what = t.label ?? t.body.split('\n')[0]!.slice(0, 50);
      const state = t.progress ?? (t.status === 'queued' ? 'waiting its turn' : 'just started');
      return `- ${what}: ${state}`;
    }).join('\n');
  }

  /** The daily layer's lines said since the front last read them, and empties the list. */
  drainQuiet(): string[] {
    const out = this.quiet;
    this.quiet = [];
    return out;
  }

  /** Runs tasks, those left from the last run included, and prunes the ledger and DSH's stored sessions now and daily. */
  start(): void {
    const prune = () => {
      const actions: Array<[string, () => unknown]> = [
        ['ledger', () => this.ledger.prune()],
        ['control sessions', () => this.opts.dsh?.pruneSessions(this.opts.retentionDays ?? 30)],
        ['code sessions', () => this.opts.dshCode?.pruneSessions(this.opts.retentionDays ?? 30)],
      ];
      for (const [name, action] of actions) {
        try { action(); }
        catch (error) { console.warn(`[agents] could not prune ${name}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    };
    prune();
    this.prune = setInterval(prune, DAY_MS);
    this.prune.unref();
    this.reminders.ensureRhythm(RHYTHM_DEFAULTS);
    this.reminders.start();
    this.bus.start();
    const retry = () => {
      try { for (const task of this.bus.pendingCodeResults()) this.settled(task); }
      catch (error) { console.warn(`[agents] could not read pending code results: ${(error as Error).message}`); }
      try { for (const task of this.bus.retryableFrontResults()) this.settled(task); }
      catch (error) { console.warn(`[agents] could not read pending front results: ${(error as Error).message}`); }
    };
    retry();
    this.resultRetry = setInterval(retry, 5000);
    this.resultRetry.unref();
    const expireInterrupted = () => {
      for (const [id, state] of this.permissionRepairs) {
        try { this.bus.finishPermission(id, state); this.permissionRepairs.delete(id); }
        catch { /* Keep the terminal state for the next retry. */ }
      }
      for (const [id, ask] of this.asks) {
        try {
          const task = this.bus.get(ask.taskId);
          if (!task || task.status !== 'running' || this.bus.stopRequested(ask.taskId)) ask.resolve(false, 'interrupted');
        } catch (error) {
          console.warn(`[agents] permission task state could not be read: ${(error as Error).message}`);
          ask.resolve(false, 'interrupted');
        }
      }
    };
    this.permissionPoll = setInterval(expireInterrupted, 200);
    this.permissionPoll.unref();
  }

  /** Only live waits can accept an answer; stale pending rows remain available for reconciliation. */
  pendingPermissions(): ReturnType<TaskBus['pendingPermissions']> {
    return this.bus.pendingPermissions().filter((permission) => this.asks.has(permission.id));
  }

  /** Short, current permission context for the front's per-request tail; it is not an authorization decision. */
  permissionContext(): string {
    const rows = [...this.asks].map(([id, ask]) => {
      const relay = this.permissionRelay.get(id);
      return `- requestId=${id}; relay=${relay?.state ?? 'notice'}${relay?.questionId ? `; questionId=${relay.questionId}` : ''}${relay?.channels?.length ? `; presented=${relay.channels.join(',')}` : ''}; task=${ask.taskId}; what=${ask.what}`;
    });
    return rows.length ? `[permission requests awaiting the person's answer]\n${rows.join('\n')}` : '';
  }

  /** Called by PetWorld after the front has persisted a question. */
  markPermissionQuestion(question: { requestId?: string; id: string }, state: 'asked' | 'presented' | 'answered' = 'asked', channel?: 'body' | 'workbench'): void {
    if (!question.requestId || !this.asks.has(question.requestId)) return;
    const previous = this.permissionRelay.get(question.requestId);
    this.permissionRelay.set(question.requestId, { state, questionId: question.id,
      channels: [...new Set([...(previous?.questionId === question.id ? previous.channels ?? [] : []), ...(channel ? [channel] : [])])] });
  }

  close(): void {
    void this.closeAsync().catch((error) => console.warn('[agents] shutdown failed', error));
  }

  closeAsync(): Promise<void> {
    return this.closing ??= this.shutdown();
  }

  private async shutdown(): Promise<void> {
    if (this.prune) clearInterval(this.prune);
    if (this.resultRetry) clearInterval(this.resultRetry);
    if (this.permissionPoll) clearInterval(this.permissionPoll);
    this.reminders.stop();
    const draining = this.bus.closeAsync();
    for (const ask of this.asks.values()) ask.resolve(false, 'interrupted');
    const stopped = await Promise.allSettled([this.dshKeeper?.stop(), this.codeKeeper?.stop(), this.codeAgentKeeper?.stop(), this.tools.close()]);
    await draining;
    this.ledger.close();
    this.reminders.store.close();
    this.workmap.close();
    this.cases.close();
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), 'one or more background components failed to stop');
  }

  /** The fork sessions the Persona declares next to its main one. */
  sessions(): SessionDecl[] {
    return [
      { id: SESSION.control, label: 'control center', persistent: false, receivesEvents: false,
        rounds: () => ({ soft: 10, hard: 20 }), tools: () => [...this.opts.fileTools(), ...this.controlTools(null)] },
      { id: SESSION.coder, label: 'code agent', persistent: false, receivesEvents: false,
        rounds: () => ({ soft: 20, hard: 40 }), tools: () => this.opts.fileTools() },
    ];
  }

  frontTools(): ToolDef[] {
    return bind(FRONT_TOOL_DECLS, {
      delegate_task: async (args) => {
        const t = this.bus.submit({ to: 'control', from: 'front', body: delegateBody(args), priority: args.urgent === true ? 'urgent' : 'normal', label: str(args.as_i_see_it) });
        // what the front chose to hand on, kept to learn from: a later complaint about the same thing labels it
        try {
          this.judgments.record({ kind: 'front-delegate', judge: 'front-provider', incidentId: t.incidentId, input: { task: t.body }, output: { delegated: true, urgent: t.priority === 'urgent' } });
        } catch (error) {
          console.warn(`[agents] delegation judgment could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
        return `[delegated] task ${t.id}${t.priority === 'urgent' ? ' (urgent)' : ''}; the result will come as an event.`;
      },
      task_status: async (args) => {
        const id = str(args.id);
        if (id) {
          const t = this.bus.get(id);
          return t ? describe(t) : `[not found] no task ${id}`;
        }
        const open = this.bus.list({ open: true });
        return open.length ? open.map(describe).join('\n') : '[none] no open tasks';
      },
      task_note: async (args) => (this.bus.update(str(args.id), str(args.note)) ? '[noted]' : '[not open] the task is missing or already finished'),
      cancel_task: async (args) => (this.bus.cancel(str(args.id)) ? '[cancelling]' : '[not open] the task is missing or already finished'),
      wake_list: async () => this.listReminders(),
      answer_permission: async (args) => {
        const ask = this.asks.get(str(args.id));
        if (!ask) {
          const state = this.bus.permissionState(str(args.id));
          if (state?.state === 'pending') return '[not waiting] request ended; stored state needs reconciliation';
          return state ? `[not waiting] request ${state.state}` : '[not waiting] no such request, or it was already answered or timed out';
        }
        if (this.bus.get(ask.taskId)?.status !== 'running' || this.bus.stopRequested(ask.taskId)) {
          ask.resolve(false, 'interrupted');
          return '[not waiting] the task is no longer active';
        }
        const allow = args.allow === true;
        try {
          if (!this.bus.finishPermission(str(args.id), allow ? 'allowed' : 'refused')) {
            ask.resolve(false, 'interrupted');
            return '[not waiting] request is no longer active';
          }
        } catch (error) {
          ask.resolve(false, 'interrupted');
          console.warn(`[agents] permission state could not be recorded: ${(error as Error).message}`);
          return '[refused] permission decision could not be recorded';
        }
        try {
          const note = str(args.note).trim();
          // their own words go to the one who asked, as a note it takes up (DSH itself hears only yes or no)
          if (note) this.bus.update(ask.taskId, `The person, answering your permission request (${ask.what}): ${note}`);
          if (allow && args.always === true) {
            this.permissionRules.add(ask.kind, ask.what);
            this.ledger.append({ role: 'front', actor: 'person', op: 'decision', summary: `allowed from now on: ${ask.kind}`, why: ask.what, incidentId: ask.incidentId });
          }
        } catch (error) {
          console.warn(`[agents] permission note or standing rule could not be recorded: ${(error as Error).message}`);
          return `[answered] permission ${allow ? 'allowed' : 'refused'}; note or standing rule needs review`;
        } finally {
          ask.resolve(allow);
        }
        return allow ? (args.always === true ? `[allowed, and this kind from now on: ${ask.kind}]` : '[allowed this once]') : '[refused]';
      },
    });
  }

  /** The control center's own tools, bound to the task it is running (null outside a run). */
  private controlTools(task: Task | null): ToolDef[] {
    const incident = task ? { incidentId: task.incidentId } : {};
    return bind(CONTROL_TOOL_DECLS, {
      dispatch_code_task: async (args) => {
        const t = this.bus.submit({
          to: 'coder', from: 'control', body: str(args.task), priority: args.urgent === true ? 'urgent' : 'normal',
          ...(task ? { incidentId: task.incidentId, parentId: task.id } : {}),
        });
        return `[dispatched] code task ${t.id}`;
      },
      report_progress: async (args) => (task && this.bus.setProgress(task.id, str(args.text)) ? '[noted]' : '[no open task]'),
      tell_front: async (args) => {
        const front = this.opts.front?.();
        if (!front) return { text: '[not told] the front is unavailable', failed: true };
        const accepted = front.enqueue({ type: 'control.notice', text: `[control center] ${str(args.text)}`, trigger: 'preempt' });
        if (!accepted) return { text: '[not told] the front did not accept the notice', failed: true };
        try { this.ledger.append({ role: 'control', actor: 'control', op: 'action', summary: `told the front: ${str(args.text)}`, ...incident }); }
        catch (error) { console.warn(`[agents] tell-front audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
        return '[told]';
      },
      incident_history: async (args) => history(this.ledger, str(args.incident) || task?.incidentId || ''),
      case_decide: async (args) => {
        const answer = args.answer && typeof args.answer === 'object' ? args.answer as Record<string, unknown>
          : (() => { try { return JSON.parse(str(args.answer)) as Record<string, unknown>; } catch { return null; } })();
        if (!answer) return { text: '[not decided] the answer is not a JSON object', failed: true };
        const out = this.cases.decide(str(args.case_id), answer);
        if (!out.ok) return { text: `[not decided] ${out.text}`, failed: true };
        try { this.ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: `case ${str(args.case_id)}: ${out.text}`,
          why: str(answer.why), ...incident, ...(task ? { parentSpanId: task.id } : {}) }); }
        catch (error) { console.warn(`[agents] case decision audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
        return `[decided] ${out.text}`;
      },
      case_look: async (args) => {
        const c = this.cases.get(str(args.case_id));
        if (!c) return { text: `[no case] ${str(args.case_id)}`, failed: true };
        const pics = this.cases.images(c);
        const pic = pics[Math.max(0, Math.round(Number(args.picture ?? 1)) - 1)];
        if (!pic || !this.opts.lookAt) return { text: '[no picture to look at]', failed: true };
        return this.opts.lookAt(`Look at this picture closely and answer the question about it in detail, naming what you see and where. ${pic.legend}`, str(args.question), pic.jpeg);
      },
      record_decision: async (args) => {
        const id = this.ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: str(args.decision), why: str(args.why),
          ...incident, ...(task ? { parentSpanId: task.id } : {}) });
        return `[recorded] decision ${id}`;
      },
      wake_create: async (args) => {
        try {
          const r = this.reminders.create({
            title: str(args.title), kind: args.kind === 'smart' ? 'smart' : 'simple', schedule: scheduleOf(args.schedule) ?? {},
            lines: Array.isArray(args.lines) ? args.lines.map(String) : [], guide: str(args.guide) || null, motion: str(args.motion) || null, why: str(args.why),
            incidentId: task?.incidentId ?? null,
          });
          try {
            this.ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: `reminder ${r.id} created: ${describeReminder(r)}`, why: r.why, ...incident });
          } catch (error) { console.warn(`[agents] reminder creation audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
          try {
            r.judgmentId = this.judgments.record({
              kind: 'reminder-kind', judge: this.judge(), promptVersion: 'control@1', ...(task ? { incidentId: task.incidentId } : {}),
              input: { request: task?.body ?? null, notes: task?.notes ?? [] },
              output: { kind: r.kind, schedule: r.schedule, lines: r.lines, guide: r.guide }, features: { lines: r.lines.length },
            });
            this.reminders.store.put(r);
          } catch (error) { console.warn(`[agents] reminder judgment could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
          return `[created] ${describeReminder(r)}`;
        } catch (error) { return { text: `[not created] ${(error as Error).message}`, failed: true }; }
      },
      wake_update: async (args) => {
        try {
          const before = this.reminders.store.get(str(args.id));
          const params = typeof args.skip_chance === 'number' || typeof args.daily_speaking === 'number'
            ? { skipChance: Number(args.skip_chance ?? before?.params?.skipChance ?? 0), dailySpeaking: Number(args.daily_speaking ?? before?.params?.dailySpeaking ?? 0) }
            : undefined;
          if (params && before?.kind !== 'rhythm') return { text: '[not updated] skip_chance and daily_speaking are the rhythm\'s', failed: true };
          const r = this.reminders.update(str(args.id), {
            ...(params ? { params } : {}),
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...((args.kind === 'smart' || args.kind === 'simple') && before?.kind !== 'rhythm' ? { kind: args.kind } : {}),
            ...(args.schedule ? { schedule: scheduleOf(args.schedule) } : {}),
            ...(Array.isArray(args.lines) ? { lines: args.lines.map(String) } : {}),
            ...(typeof args.guide === 'string' ? { guide: args.guide } : {}),
            ...(typeof args.motion === 'string' ? { motion: args.motion.trim() || null } : {}),
            ...(typeof args.active === 'boolean' ? { active: args.active } : {}),
          });
          try { this.ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: `reminder ${r.id} changed: ${describeReminder(r)}`, why: str(args.why), ...incident }); }
          catch (error) { console.warn(`[agents] reminder update audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
          // the kind first chosen was overturned: a label for that judgment
          if (before && before.kind !== r.kind && r.judgmentId) {
            try { this.judgments.label('reminder-kind', r.judgmentId, { label: { kind: r.kind }, agrees: false, source: 'later', note: str(args.why) }); }
            catch (error) { console.warn(`[agents] reminder update judgment could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
          }
          return `[updated] ${describeReminder(r)}`;
        } catch (error) { return { text: `[not updated] ${(error as Error).message}`, failed: true }; }
      },
      wake_list: async () => this.listReminders(),
      screen_glance: async () => (this.screen ? this.screen() : '[unavailable] the screen cannot be seen here'),
      control_write: async (args, ctx) => {
        // the workspace's own write tools, called as the control center: its fence and its history apply
        const tool = this.opts.fileTools().find((t) => t.name === (args.append === true ? 'append_file' : 'write_file'));
        if (!tool) return { text: '[failed] the workspace file tools are not available', failed: true };
        return tool.handler({ path: str(args.path), content: str(args.content) }, { ...ctx, role: SESSION.control });
      },
      wake_delete: async (args) => {
        if (this.reminders.store.get(str(args.id))?.kind === 'rhythm') return { text: '[not deleted] the rhythm can only be paused, with wake_update active=false', failed: true };
        const gone = this.reminders.store.delete(str(args.id));
        if (gone) {
          try { this.ledger.append({ role: 'control', actor: 'control', op: 'decision', summary: `reminder ${str(args.id)} deleted`, why: str(args.why), ...incident }); }
          catch (error) { console.warn(`[agents] reminder deletion audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
        }
        return gone ? '[deleted]' : `[not found] no reminder ${str(args.id)}`;
      },
    });
  }

  /** Who judges for the control center now: the DSH model, or the isolated LangChain task's. */
  private judge(): string {
    return this.dshUp() ? `dsh:${DSH_MODEL.model}` : 'langchain-agent';
  }

  private listReminders(): string {
    const all = this.reminders.store.list();
    return all.length ? all.map(describeReminder).join('\n') : '[none] no reminders';
  }

  private wakeFront(r: Reminder, why: 'smart' | 'engaged', suggestion: string | null): void {
    const say = why === 'engaged'
      ? `The person is with you right now, so say it in the flow of what you are doing. A line you could use: ${suggestion}`
      : `Decide now whether and how to say it, from what is going on. Guide: ${r.guide}`;
    // a reminder is to pull them out of their work: a big motion first, then the words, maybe as two bubbles
    const getAttention = 'It is meant to catch their eye while they are busy: open with a big motion (jump, wave, spin, dance), '
      + 'not a small look or a sit, then say it; two short bubbles are fine.';
    this.opts.front?.()?.enqueue({ type: 'reminder.due', id: r.id, text: `[reminder ${r.id} due: ${r.title}] ${say} ${getAttention}`, trigger: 'preempt' });
  }

  private async run(task: Task, control: RunControl): Promise<string | ConfirmedTaskSuccess> {
    // no time limit: a task cut off half way has cost its tokens and given nothing (the person's rule, 10-28); it runs
    // until it is done or someone cancels it
    const seen = control.notes().length;
    let out: string | ConfirmedTaskSuccess;
    try { out = await this.runOnce(task, control, () => {}); }
    catch (error) {
      const late = control.notes().slice(seen);
      if (late.length) {
        const cause = error instanceof Error ? error.message : String(error);
        const detail = `${cause}\nNotes added while this task ran (handling unconfirmed):\n${late.map((n) => `- ${n}`).join('\n')}`;
        throw error instanceof UncertainTaskError ? new UncertainTaskError(detail) : new Error(detail);
      }
      throw error;
    }
    // notes added while it ran never reached a DSH session (a prompt is sent once): the same incident is taken up again
    // with them, so a correction made meanwhile is not lost
    const late = control.notes().slice(seen);
    if (late.length && !control.shouldStop()) {
      this.bus.submit({
        to: task.to, from: task.from, incidentId: task.incidentId, parentId: task.id,
        body: `Notes came in on task ${task.id} while you worked on it, after you had started; reconsider what you did in their light:\n`
          + `${late.map((n) => `- ${n}`).join('\n')}\nWhat you did: ${(typeof out === 'string' ? out : out.result).slice(0, 1500)}`,
      });
    }
    return out;
  }

  private async runOnce(task: Task, control: RunControl, onStarted: () => void): Promise<string | ConfirmedTaskSuccess> {
    const lines = [`Task ${task.id} from the ${task.from}${task.priority === 'urgent' ? ' (urgent)' : ''}:`, task.body];
    const guide = this.playbook?.brief(task.to);
    if (guide) lines.push('', guide);
    if (task.attempts > 1) lines.push('', 'This task was started before and stopped. The incident so far:', history(this.ledger, task.incidentId));
    else if (task.parentId) lines.push('', 'The incident so far:', history(this.ledger, task.incidentId));
    const notes = control.notes();
    if (notes.length) lines.push('', 'Notes added since:', ...notes.map((n) => `- ${n}`));
    if (task.runnerId === 'framework-v1' && task.to === 'control') {
      if (!this.opts.frameworkControl || this.dshKeeper) throw new Error('framework control runner unavailable');
      const model = this.opts.model?.('control');
      if (model) {
        await this.tools.start();
        onStarted();
        const pictures = this.caseOf(task)?.images ?? [];
        const imageHint = '';
        let toolStarted = false;
        let out;
        try {
          out = await runControl({ model,
            system: PROMPT.control,
            task: lines.join('\n') + imageHint, tools: [...this.controlTools(task), ...this.opts.fileTools().filter((x) => x.tags.includes('read'))],
            images: pictures.length ? pictures.map((picture) => picture.jpeg) : undefined,
            log: this.opts.log, signal: control.signal, sessionId: `task:${task.id}`,
            onToolStarted: () => { toolStarted = true; },
            onUsage: (usage) => {
            try {
              this.ledger.append({
                role: 'control', actor: 'langchain', op: 'note', summary: 'background model usage',
                incidentId: task.incidentId, parentSpanId: task.id,
                why: JSON.stringify(usage),
              });
            } catch (error) {
              console.warn(`[agents] model usage audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
            }
            this.opts.onUsage?.(usage, 'control');
            },
          });
        } catch (error) {
          if (control.signal.aborted && toolStarted) throw new UncertainTaskError(`agent task cancelled after a tool started; side effects need review: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        for (const error of out.toolErrors) {
          try {
            this.ledger.append({ role: 'control', actor: 'framework', op: 'note',
              summary: `agent tool error: ${error.name}`, incidentId: task.incidentId, parentSpanId: task.id,
              ref: `tool:${error.callId}`, why: error.detail });
          } catch (cause) {
            console.warn(`[agents] framework tool error audit could not be recorded: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
        return { kind: 'confirmed-success', result: out.text };
      }
      throw new Error('LangChain control model unavailable');
    }
    const dsh = this.dshKeeper;
    if (dsh && task.to === 'control') {
      // one incident is one DSH session: a follow-up continues it, and its first line is what DSH lists the session by
      const resume = this.dshSessionOf(task.incidentId);
      const text = resume
        ? [`Task ${task.id} from the ${task.from}${task.priority === 'urgent' ? ' (urgent)' : ''}:`, task.body,
          ...(notes.length ? ['', 'Notes added since:', ...notes.map((n) => `- ${n}`)] : [])].join('\n')
        : [`[pet] ${task.body.split('\n')[0]!.slice(0, 60)}`, '', ...lines].join('\n');
      await this.tools.start();
      const pictures = this.caseOf(task)?.images ?? [];
      const seen = pictures.length && !dsh.takesImages
        ? `\n\n(If the case's pictures are not shown to you, ask about them with case_look.)` : '';
      const out = await dsh.run(text + seen, () => control.shouldStop(), (ask) => this.askPerson(task, ask), resume, [this.tools.entry(task.id)], onStarted, pictures.map((p) => p.jpeg));
      try { this.ledger.append({ role: 'control', actor: 'dsh', op: 'note', summary: `DSH session ${out.sessionId} ended: ${out.stopReason}`,
        incidentId: task.incidentId, parentSpanId: task.id, ref: `dsh:session:${out.sessionId}` }); }
      catch (error) { console.warn(`[agents] control session audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
      return out.text || `(no message; stop reason ${out.stopReason})`;
    }
    const codeAgent = this.codeAgentKeeper;
    if (codeAgent && task.to === 'coder') {
      if (this.opts.codeAgent === null) {
        const detail = 'code agent unavailable: no verified isolated provider is configured';
        throw task.attempts > 1 ? new UncertainTaskError(`${detail}; previous outcome: ${task.result ?? 'unknown'}`) : new Error(detail);
      }
      this.bus.bindCodeProvider(task.id, this.opts.codeAgent!.id);
      // The provider receives a bounded task package. It never sees the front transcript or DSH-specific session data.
      const pictures = this.caseOf(task)?.images ?? [];
      await this.tools.start();
      const codeTask: CodeTask = {
        id: task.id,
        incidentId: task.incidentId,
        prompt: [`[pet code] ${task.body.split('\n')[0]!.slice(0, 60)}`, '', ...lines].join('\n'),
        cwd: this.opts.codeWorkspace?.cwd ?? this.opts.workspaceDir ?? '',
        writableRoot: this.opts.codeWorkspace?.writableRoot ?? WRITABLE.coder,
        readRoots: this.opts.codeWorkspace?.readRoots ?? (this.opts.workspaceDir ? [this.opts.workspaceDir] : []),
        network: this.opts.codeAgent?.taskNetworkPolicy ?? 'deny',
        acceptance: ['The code agent must report the tests it actually ran.'],
        attempt: task.attempts,
        preferredAgent: this.bus.get(task.id)?.codeProvider ?? undefined,
        resume: task.codeRunRef?.sessionId ? task.codeRunRef : undefined,
        metadata: { mcpServers: [this.tools.entry(task.id)] },
      };
      const policyError = unsupportedPolicy(codeTask, this.opts.codeAgent!);
      if (policyError) throw task.attempts > 1 ? new UncertainTaskError(`${policyError}; previous outcome: ${task.result ?? 'unknown'}`) : new Error(policyError);
      await this.opts.prepareCode?.();
      const out = await codeAgent.run({ ...codeTask, ...(task.codeRunRef?.sessionId ? { resume: task.codeRunRef } : {}) }, {
        shouldStop: () => control.shouldStop(),
        onRunRef: (ref: CodeRunRef) => this.bus.bindCodeRunRef(task.id, ref),
        onActivity: (activity) => { this.bus.appendCodeAgentActivity(activity); },
        onStarted: () => onStarted(),
        onPermission: (ask) => this.askPerson(task, permissionAskOf(ask)),
        images: pictures.map((p) => p.jpeg),
      });
      try { this.ledger.append({ role: 'coder', actor: out.ref.provider, op: 'note', summary: `${out.ref.provider} code session ${out.ref.runId} ended: ${out.stopReason ?? out.status}`,
        incidentId: task.incidentId, parentSpanId: task.id, ref: `${out.ref.provider}:session:${out.ref.sessionId ?? out.ref.runId}` }); }
      catch (error) { console.warn(`[agents] code session audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
      if (out.status === 'unknown') throw new UncertainTaskError(`code agent unknown: ${out.summary || out.stopReason || '(no details)'}`);
      if (out.status !== 'succeeded') throw new Error(`code agent ${out.status}: ${out.summary || out.stopReason || '(no details)'}`);
      return { kind: 'confirmed-success', result: out.summary || `(no message; stop reason ${out.stopReason ?? out.status})` };
    }
    const code = this.codeKeeper;
    if (code && task.to === 'coder') {
      // a code task is a session of its own in the code agent's DSH, with the pet's tools for reporting progress
      await this.tools.start();
      await this.opts.prepareCode?.();
      const out = await code.run([`[pet code] ${task.body.split('\n')[0]!.slice(0, 60)}`, '', ...lines].join('\n'), () => control.shouldStop(),
        (ask) => this.askPerson(task, ask), task.codeRunRef?.sessionId ?? null, [this.tools.entry(task.id)], (sessionId) => {
          this.bus.bindCodeRunRef(task.id, { provider: 'dsh', runId: sessionId, sessionId });
          onStarted();
        }, undefined, true);
      try { this.ledger.append({ role: 'coder', actor: 'dsh', op: 'note', summary: `DSH code session ${out.sessionId} ended: ${out.stopReason}`,
        incidentId: task.incidentId, parentSpanId: task.id, ref: `dsh-code:session:${out.sessionId}` }); }
      catch (error) { console.warn(`[agents] code session audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`); }
      return out.text || `(no message; stop reason ${out.stopReason})`;
    }
    return this.fork(task, control, lines);
  }


  private async fork(task: Task, control: RunControl, lines: string[]): Promise<string | ConfirmedTaskSuccess> {
    const model = this.opts.model?.(task.to);
    if (!model) throw new Error('the local agent model is unavailable');
    let toolStarted = false;
    try {
      const result = await runControl({ model, system: PROMPT[task.to], task: lines.join('\n'),
        images: this.caseOf(task)?.images.map((image) => image.jpeg),
        tools: [...this.opts.fileTools(), ...(task.to === 'control' ? this.controlTools(task) : [])],
        log: this.opts.log, signal: control.signal, sessionId: `task:${task.id}`,
        onToolStarted: () => { toolStarted = true; },
        onUsage: (usage) => this.opts.onUsage?.(usage, task.to),
      });
      return { kind: 'confirmed-success', result: result.text };
    } catch (error) {
      if (control.signal.aborted && toolStarted) throw new UncertainTaskError(`task cancelled after a fork tool started; side effects need review: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /** The case a task carries and its pictures; null when it carries none. */
  private caseOf(task: Task): { c: StoredCase; images: Array<{ label: string; legend: string; jpeg: Uint8Array }> } | null {
    const id = caseIdOf(task.body);
    const c = id ? this.cases.get(id) : null;
    return c ? { c, images: this.cases.images(c) } : null;
  }

  /**
   * Opens a case and hands it to the control center as a task: the facts, the pictures and the decisions made on the
   * same matter before go with it (cases.ts). Returns the case.
   */
  submitCase(input: CaseInput, opts: { from?: 'daily' | 'front'; urgent?: boolean; label?: string } = {}): StoredCase {
    const c = this.cases.open(input);
    this.bus.submit({ to: 'control', from: opts.from ?? 'daily', body: this.cases.render(c), priority: opts.urgent ? 'urgent' : 'normal', ...(opts.label ? { label: opts.label } : {}) });
    try {
      this.ledger.append({ role: 'daily', actor: 'daily', op: 'escalate', summary: `case ${c.id} (${c.kind} · ${c.key}): ${c.question}` });
    } catch (error) {
      console.warn(`[agents] case escalation audit could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    return c;
  }

  private dshUp(): boolean {
    return this.dshKeeper !== null;
  }

  /** The DSH session an incident last ran in, from the ledger; null when it has none. */
  private dshSessionOf(incidentId: string): string | null {
    const refs = this.ledger.byIncident(incidentId, 1000).entries.map((e) => e.ref).filter((r): r is string => !!r?.startsWith('dsh:session:'));
    return refs.length ? refs[refs.length - 1]!.slice('dsh:session:'.length) : null;
  }

  /**
   * Hands DSH's permission request to the front, which asks the person with options, and waits for the answer; silence
   * is a refusal. A kind the person allowed from now on is allowed at once (permission-rules.ts).
   */
  private askPerson(task: Task, ask: PermissionAsk): Promise<boolean> {
    // unique even for two asks in the same millisecond: the id is a span of the ledger
    const id = `perm-${crypto.randomUUID().slice(0, 8)}`;
    const who = task.to === 'coder' ? 'code agent' : 'control center';
    const kind = permissionKind(who, ask.title, ask.input);
    const what = `${ask.title} ${ask.detail}`.trim().slice(0, 300);
    this.ledger.append({ role: task.to, actor: 'dsh', op: 'escalate', summary: `asks permission: ${ask.title}`, why: ask.detail,
      incidentId: task.incidentId, parentSpanId: task.id, spanId: id });
    if (this.permissionRules.allows(kind)) {
      this.ledger.append({ role: 'front', actor: 'person', op: 'evaluation', summary: `permission allowed by a standing answer: ${kind}`,
        result: 'ok', incidentId: task.incidentId, targetSpanId: id });
      return Promise.resolve(true);
    }
    const front = this.opts.front?.();
    if (!front) return Promise.resolve(false);
    this.bus.recordPermission(id, task.id);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false, 'timed out'), PERMISSION_WAIT_MS);
      timer.unref();
      const finish = (allow: boolean, how: string) => {
        clearTimeout(timer);
        if (!this.asks.delete(id)) return;
        this.permissionRelay.delete(id);
        if (how !== 'answered') {
          try { this.bus.finishPermission(id, how === 'interrupted' ? 'interrupted' : 'timed_out'); }
          catch (error) {
            console.warn(`[agents] permission state could not be recorded: ${(error as Error).message}`);
            this.permissionRepairs.set(id, how === 'interrupted' ? 'interrupted' : 'timed_out');
            allow = false;
          }
        }
        try {
          this.ledger.append({ role: 'front', actor: 'person', op: 'evaluation', summary: `permission ${allow ? 'allowed' : 'refused'} (${how})`,
            result: allow ? 'ok' : 'fail', incidentId: task.incidentId, targetSpanId: id });
        } catch (error) { console.warn(`[agents] permission audit could not be recorded: ${(error as Error).message}`); }
        resolve(allow);
      };
      this.asks.set(id, { resolve: (allow, how = 'answered') => finish(allow, how), incidentId: task.incidentId, taskId: task.id, kind, what });
      this.permissionRelay.set(id, { state: 'notice' });
      try {
        if (!front.enqueue({ type: 'permission.ask', id, text: permissionNotice(id, who, task, ask, kind), trigger: 'preempt', meta: { requestId: id } })) finish(false, 'interrupted');
      }
      catch (error) {
        console.warn('[agents] permission notice could not be delivered', error);
        finish(false, 'interrupted');
      }
    });
  }

  private settled(task: Task): void {
    if (task.from === 'control' && task.to === 'coder') {
      try { this.bus.deliverCodeResult(task); }
      catch (error) { this.opts.log.warn('Could not deliver code result; it remains pending', { taskId: task.id, err: error }); }
      return;
    }
    if (task.status === 'cancelled' && task.from === 'front') return;
    // upkeep the daily layer asked for (fresh lines) is the control center's business; the ledger has it
    if (task.from === 'daily') return;
    // Give the front the raw result as context; it decides whether a relevant outcome needs a brief, natural update.
    const what = task.label ? `「${task.label}」` : `task ${task.id}`;
    const text = `[your background work ${task.status}: ${what}] Use this result as context, not as text to quote. Decide whether anything relevant changed for the person; if so, tell them briefly in your own words. Say nothing when there is nothing relevant to report. Result: ${task.result ?? '(nothing)'}`;
    try {
      const accepted = this.opts.front?.()?.enqueue({ type: 'background.result', id: task.id, text, trigger: 'preempt' }) ?? false;
      if (accepted) this.bus.ackFrontResult(task.id);
    } catch (error) {
      this.opts.log.warn('Could not persist background result; it remains pending', { taskId: task.id, err: error });
    }
  }
}

const MOVED_AWAY_MIN = 10;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function describe(t: Task): string {
  const result = t.result ? ` → ${t.result.slice(0, 200)}` : '';
  return `${t.id} · ${t.to} · ${t.status}${t.priority === 'urgent' ? ' · urgent' : ''} · ${t.body.slice(0, 120)}${result}`;
}

function history(ledger: Ledger, incident: string): string {
  if (!incident) return '[none] no incident given';
  const { entries, omitted } = ledger.byIncident(incident, HISTORY_ROWS);
  if (!entries.length) return '[none] nothing recorded for this incident';
  return `${omitted ? `(${omitted} older rows not shown)\n` : ''}${toText(entries)}`;
}

function permissionAskOf(request: CodePermissionRequest): PermissionAsk {
  return {
    sessionId: request.run.sessionId ?? request.run.runId,
    title: request.title,
    detail: request.detail,
    input: request.input,
    said: request.said,
  };
}
