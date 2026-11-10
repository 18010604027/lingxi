/**
 * The wake table: every time the pet wakes on its own, in one place the control center can see and change. Three kinds
 * of entry, one engine, one tick:
 * - rhythm: the pet looking up on its own now and then (rhythm.ts), at a random interval inside its waking hours,
 *   sometimes letting the moment pass. There is one; it can be tuned and paused, not deleted.
 * - simple and smart reminders, below.
 * The control center decides for each reminder whether it is simple or smart and says why; the engine then runs it
 * without asking anyone:
 * - simple: a line picked at random from the reminder's own lines, avoiding the ones said last, is said by the pet
 *   directly, with no model call. When the lines have been used enough or grown old, the engine asks for a fresh set
 *   once (`onStale`); the control center writes them.
 * - smart: the front is woken with the reminder's guide and decides then what to say, from what is going on.
 * - Either kind goes to the front when the person interacted with the pet in the last few minutes (`engaged`): a
 *   scripted line dropped into a live conversation breaks it, so the front says it in context, a simple reminder's
 *   picked line given as a suggestion.
 * A reminder whose time passed while the computer slept or the app was closed is not said late: it moves on to its
 * next time and the skip is counted.
 */
import { randomUUID } from 'node:crypto';
import type { Ledger } from '../ledger/ledger.ts';
import { openDb, type Db } from '../sqlite.ts';

export type ReminderKind = 'simple' | 'smart' | 'rhythm';

/**
 * When an entry is due, in the machine's local time: every N minutes inside a daily window, at set times, or after a
 * random interval inside the window (`jitter`, the rhythm's way).
 */
export interface Schedule {
  everyMinutes?: number;
  jitter?: { minMinutes: number; maxMinutes: number };
  /** `HH:MM` times of day. */
  times?: string[];
  /** Days of the week it runs, 0 = Sunday; all when absent. */
  days?: number[];
  /** Daily window `HH:MM`–`HH:MM` for `everyMinutes`; the whole day when absent. */
  from?: string;
  to?: string;
}

export interface Reminder {
  id: string;
  title: string;
  kind: ReminderKind;
  schedule: Schedule;
  /** What a simple reminder says, one line each; markers as `pet_say` takes them. */
  lines: string[];
  /** What a smart reminder should consider when it fires. */
  guide: string | null;
  /**
   * What the pet does as it says a simple one, in its action words (`wave, jump`; `run 3s`): chosen with the reminder,
   * since a nudge has to catch the eye in its own way. Null or absent: `REMINDER_MOTION`.
   */
  motion?: string | null;
  /** Why the control center chose this kind. */
  why: string;
  incidentId: string | null;
  active: boolean;
  nextAt: string | null;
  lastFiredAt: string | null;
  /** Indexes of the lines said last, newest last. */
  recent: number[];
  /** Times said since the lines were last replaced. */
  usesSinceLines: number;
  linesUpdatedAt: string;
  /** A fresh set of lines was asked for and has not arrived. */
  refreshAsked: boolean;
  /** The judgment record of the choice of kind, for labelling it when the choice is overturned. */
  judgmentId?: string;
  /** The rhythm's own settings: the chance a look is let pass, and how often a day it may speak on its own. */
  params?: RhythmParams;
  createdAt: string;
}

export interface RhythmParams { skipChance: number; dailySpeaking: number }

export interface ReminderInput {
  title: string;
  kind: ReminderKind;
  schedule: Schedule;
  lines?: string[];
  guide?: string | null;
  motion?: string | null;
  why: string;
  incidentId?: string | null;
  params?: RhythmParams;
}

/** What a simple reminder does as it is said when it names nothing of its own: a wave and a hop, to catch the eye. */
export const REMINDER_MOTION = 'wave, jump';

export interface EngineHooks {
  /** The rhythm's look, when its entry is due. */
  rhythm?: (r: Reminder) => Promise<void>;
  /** Says a line through the pet, doing `motion` (action words) as it does; false when it could not be shown. */
  say: (line: string, motion: string) => Promise<boolean>;
  /** Wakes the front with a reminder that is due; `suggestion` is the picked line of a simple one. */
  wakeFront: (r: Reminder, why: 'smart' | 'engaged', suggestion: string | null) => void;
  /** Whether the person interacted with the pet recently enough that a reminder should be said in context. */
  engaged?: () => boolean;
  /** Asks the control center for a fresh set of lines. */
  onStale: (r: Reminder) => void;
  ledger?: Ledger;
  now?: () => Date;
  random?: () => number;
}

/** A simple reminder asks for new lines once each has been said about twice, or after two weeks. */
const STALE_USES_PER_LINE = 2;
const STALE_MS = 14 * 86_400_000;
/** A due time older than this when noticed is skipped, not said late. */
const LATE_MS = 30 * 60_000;
const TICK_MS = 30_000;
/** How far ahead `nextAfter` looks for a time that fits the days and window. */
const SEARCH_DAYS = 8;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminder (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL
);
`;

const minutesOf = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`not a time of day: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`not a time of day: ${hhmm}`);
  return h * 60 + min;
};

/** Checks a schedule; returns the reason it cannot run, or null. */
/** Fields a reminder input may carry; anything else is refused rather than stored. */
const KNOWN_INPUT_FIELDS = new Set(['title', 'kind', 'schedule', 'lines', 'guide', 'motion', 'why', 'incidentId', 'params']);

/** Bounded text with no control characters (a reminder's words end up in a bubble and in a log line). */
export function textProblem(value: unknown, max: number, field = 'text'): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return field + ' must be a string';
  if (value.length > max) return field + ' is at most ' + max + ' characters';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return field + ' has control characters';
  return null;
}

/** Actions are words the figure knows, with an optional duration: never free text. */
export function motionProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'motion must be a string';
  if (value.length > 120) return 'motion is at most 120 characters';
  for (const part of value.split(',')) {
    const word = part.trim().split(/\s+/)[0] ?? '';
    if (!word) continue;
    if (!/^[\p{L}\p{N}_-]+$/u.test(word)) return 'motion words are letters, digits, _ or -';
  }
  return null;
}
export function scheduleProblem(s: Schedule): string | null {
  const every = s.everyMinutes !== undefined;
  const times = s.times !== undefined && s.times.length > 0;
  const jitter = s.jitter !== undefined;
  if (Number(every) + Number(times) + Number(jitter) !== 1) return 'give exactly one of everyMinutes, times or jitter';
  if (every && (!Number.isInteger(s.everyMinutes) || s.everyMinutes! < 5)) return 'everyMinutes must be a whole number, at least 5';
  if (jitter && !(s.jitter!.minMinutes >= 5 && s.jitter!.maxMinutes >= s.jitter!.minMinutes)) return 'jitter needs minMinutes of at least 5 and maxMinutes no smaller';
  try {
    for (const t of s.times ?? []) minutesOf(t);
    if (s.from !== undefined) minutesOf(s.from);
    if (s.to !== undefined) minutesOf(s.to);
  } catch (error) { return (error as Error).message; }
  if (s.days && s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'days are 0 (Sunday) to 6';
  return null;
}

/**
 * The first due time strictly after `after`, local time; null when the schedule never fits. A `jitter` schedule draws
 * its interval with `random`, and past the window's end moves to a little after the next window opens.
 */
export function nextAfter(s: Schedule, after: Date, random: () => number = Math.random): Date | null {
  const days = new Set(s.days ?? [0, 1, 2, 3, 4, 5, 6]);
  if (s.jitter) {
    const from = s.from ? minutesOf(s.from) : 0;
    const to = s.to ? minutesOf(s.to) : 24 * 60 - 1;
    const span = s.jitter.minMinutes + random() * (s.jitter.maxMinutes - s.jitter.minMinutes);
    const at = new Date(after.getTime() + span * 60_000);
    const m = at.getHours() * 60 + at.getMinutes();
    const sameDay = at.getDate() === after.getDate();
    if (sameDay && days.has(at.getDay()) && m >= from && m <= to && after.getHours() * 60 + after.getMinutes() >= from) return at;
    const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
    if (after.getHours() * 60 + after.getMinutes() >= from) day.setDate(day.getDate() + 1);
    for (let i = 0; i < SEARCH_DAYS; i++, day.setDate(day.getDate() + 1)) {
      if (days.has(day.getDay())) return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(from / 60), from % 60 + Math.round(random() * 20));
    }
    return null;
  }
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  for (let i = 0; i < SEARCH_DAYS; i++, day.setDate(day.getDate() + 1)) {
    if (!days.has(day.getDay())) continue;
    let slots: number[];
    if (s.times?.length) slots = s.times.map(minutesOf).sort((a, b) => a - b);
    else {
      const from = s.from ? minutesOf(s.from) : 0;
      const to = s.to ? minutesOf(s.to) : 24 * 60 - 1;
      slots = [];
      for (let m = from; m <= to; m += s.everyMinutes!) slots.push(m);
    }
    for (const m of slots) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
      if (at.getTime() > after.getTime()) return at;
    }
  }
  return null;
}

/** A line index at random, never one of the last few said (as many as the lines allow). */
export function pickLine(r: Pick<Reminder, 'lines' | 'recent'>, random: () => number = Math.random): number {
  const avoid = new Set(r.recent.slice(-Math.min(5, r.lines.length - 1)));
  const open = r.lines.map((_, i) => i).filter((i) => !avoid.has(i));
  return open[Math.floor(random() * open.length)]!;
}

export class ReminderStore {
  private readonly db: Db;

  constructor(file: string) {
    this.db = openDb(file);
    this.db.exec(SCHEMA);
  }

  list(): Reminder[] {
    return (this.db.prepare('SELECT body FROM reminder').all() as Array<{ body: string }>)
      .map((r) => JSON.parse(r.body) as Reminder)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Reminder | null {
    const row = this.db.prepare('SELECT body FROM reminder WHERE id = ?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Reminder : null;
  }

  put(r: Reminder): void {
    this.db.prepare('INSERT INTO reminder (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body').run(r.id, JSON.stringify(r));
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM reminder WHERE id = ?').run(id).changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

export class ReminderEngine {
  readonly store: ReminderStore;
  private readonly hooks: EngineHooks;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(store: ReminderStore, hooks: EngineHooks) {
    this.store = store;
    this.hooks = hooks;
    this.now = hooks.now ?? (() => new Date());
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The rhythm's entry, made with `defaults` the first time; there is only ever one. */
  ensureRhythm(defaults: { schedule: Schedule; params: RhythmParams }): Reminder {
    const found = this.store.list().find((r) => r.kind === 'rhythm');
    if (found) return found;
    const now = this.now();
    const r: Reminder = {
      id: 'rhythm', title: 'looking up on my own', kind: 'rhythm', schedule: defaults.schedule, lines: [], guide: null,
      why: 'the pet looks up now and then, glances at the screen and decides whether to speak', incidentId: null, active: true,
      nextAt: nextAfter(defaults.schedule, now, this.hooks.random)?.toISOString() ?? null, lastFiredAt: null, recent: [],
      usesSinceLines: 0, linesUpdatedAt: now.toISOString(), refreshAsked: false, createdAt: now.toISOString(), params: defaults.params,
    };
    this.store.put(r);
    return r;
  }

  /** Checks what is wrong with an input; null when it can be stored. */
  problem(input: Partial<ReminderInput>): string | null {
    // A reminder is content the code agent writes, so it is checked like untrusted input: known fields only, bounded
    // text, no control characters, and actions limited to words the figure actually knows (user, 10-29 — a bad edit
    // could otherwise put anything into one).
    const unknown = Object.keys(input).filter((k) => !KNOWN_INPUT_FIELDS.has(k));
    if (unknown.length) return `unknown field(s): ${unknown.join(', ')}`;
    for (const [field, value] of [['title', input.title], ['why', input.why], ['guide', input.guide], ['incidentId', input.incidentId]] as const) {
      const bad = textProblem(value, field === 'guide' ? 600 : 200);
      if (bad) return bad;
    }
    if (input.lines !== undefined) {
      if (!Array.isArray(input.lines) || input.lines.length > 40) return 'lines is at most 40 lines';
      for (const line of input.lines) {
        const bad = textProblem(line, 200);
        if (bad) return 'each line ' + bad;
      }
    }
    if (input.motion !== undefined && input.motion !== null) {
      const bad = motionProblem(input.motion);
      if (bad) return bad;
    }
    if (input.params && !(input.params.skipChance >= 0 && input.params.skipChance <= 0.95 && input.params.dailySpeaking >= 0)) {
      return 'skipChance is 0 to 0.95 and dailySpeaking 0 or more';
    }
    if (input.schedule) {
      const p = scheduleProblem(input.schedule);
      if (p) return p;
    }
    if (input.kind === 'simple' && input.lines !== undefined && input.lines.filter((l) => l.trim()).length < 3) return 'a simple reminder needs at least 3 lines, so it does not repeat itself';
    if (input.kind === 'smart' && input.guide !== undefined && !input.guide?.trim()) return 'a smart reminder needs a guide';
    return null;
  }

  create(input: ReminderInput): Reminder {
    if (input.kind === 'rhythm') throw new Error('there is one rhythm entry; change it with an update');
    const problem = this.problem({ ...input, lines: input.lines ?? [], guide: input.guide ?? '' });
    if (problem) throw new Error(problem);
    const now = this.now();
    const r: Reminder = {
      id: `rem-${randomUUID().slice(0, 8)}`, title: input.title, kind: input.kind, schedule: input.schedule,
      lines: (input.lines ?? []).map((l) => l.trim()).filter(Boolean), guide: input.guide?.trim() || null, motion: input.motion?.trim() || null, why: input.why,
      incidentId: input.incidentId ?? null, active: true, nextAt: nextAfter(input.schedule, now)?.toISOString() ?? null,
      lastFiredAt: null, recent: [], usesSinceLines: 0, linesUpdatedAt: now.toISOString(), refreshAsked: false, createdAt: now.toISOString(),
    };
    this.store.put(r);
    return r;
  }

  /** Changes a reminder; new lines reset its staleness, a new schedule or resuming recomputes its next time. */
  update(id: string, change: Partial<ReminderInput> & { active?: boolean }): Reminder {
    const r = this.store.get(id);
    if (!r) throw new Error(`no reminder ${id}`);
    const merged = { ...r, ...change, guide: change.guide === undefined ? r.guide : change.guide };
    const problem = this.problem({ ...(change.params ? { params: { ...r.params!, ...change.params } } : {}), kind: merged.kind, schedule: merged.schedule, lines: change.lines ?? (merged.kind === 'simple' ? r.lines : undefined), guide: merged.kind === 'smart' ? merged.guide ?? '' : undefined });
    if (problem) throw new Error(problem);
    const now = this.now();
    if (change.lines) Object.assign(merged, { lines: change.lines.map((l) => l.trim()).filter(Boolean), recent: [], usesSinceLines: 0, linesUpdatedAt: now.toISOString(), refreshAsked: false });
    if (change.schedule || change.active === true) merged.nextAt = nextAfter(merged.schedule, now, this.hooks.random)?.toISOString() ?? null;
    if (change.params) merged.params = { ...r.params!, ...change.params };
    this.store.put(merged);
    return merged;
  }

  /** Says or hands on every reminder that is due. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const r of this.store.list()) {
        if (!r.active || !r.nextAt || new Date(r.nextAt).getTime() > now.getTime()) continue;
        const late = now.getTime() - new Date(r.nextAt).getTime() > LATE_MS;
        r.nextAt = nextAfter(r.schedule, now, this.hooks.random)?.toISOString() ?? null;
        if (late) {
          this.hooks.ledger?.count('daily', `reminder:${r.id}`, 'skipped-late');
          this.store.put(r);
          continue;
        }
        await this.fire(r, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async fire(r: Reminder, now: Date): Promise<void> {
    r.lastFiredAt = now.toISOString();
    if (r.kind === 'rhythm') {
      this.store.put(r);
      await this.hooks.rhythm?.(r);
      return;
    }
    if (r.kind === 'smart' || r.lines.length === 0) {
      this.hooks.ledger?.count('daily', `reminder:${r.id}`, 'woke-front');
      this.store.put(r);
      this.hooks.wakeFront(r, 'smart', null);
      return;
    }
    const i = pickLine(r, this.hooks.random);
    if (this.hooks.engaged?.()) {
      this.hooks.ledger?.count('daily', `reminder:${r.id}`, 'woke-front-engaged');
      r.recent = [...r.recent, i].slice(-10);
      this.store.put(r);
      this.hooks.wakeFront(r, 'engaged', r.lines[i]!);
      return;
    }
    const shown = await this.hooks.say(r.lines[i]!, r.motion || REMINDER_MOTION);
    this.hooks.ledger?.count('daily', `reminder:${r.id}`, shown ? 'said' : 'not-shown');
    if (shown) {
      r.recent = [...r.recent, i].slice(-10);
      r.usesSinceLines++;
    }
    const stale = r.usesSinceLines >= r.lines.length * STALE_USES_PER_LINE || now.getTime() - new Date(r.linesUpdatedAt).getTime() > STALE_MS;
    if (stale && !r.refreshAsked) {
      r.refreshAsked = true;
      this.store.put(r);
      this.hooks.onStale(r);
      return;
    }
    this.store.put(r);
  }
}

/** One line per reminder, for the control center and the front. */
export function describeReminder(r: Reminder): string {
  const s = r.schedule;
  const window = s.from || s.to ? ` ${s.from ?? '00:00'}–${s.to ?? '23:59'}` : '';
  const when = s.times?.length ? `at ${s.times.join(', ')}` : s.jitter ? `every ${s.jitter.minMinutes}–${s.jitter.maxMinutes} min at random${window}` : `every ${s.everyMinutes} min${window}`;
  const days = s.days ? ` on days ${s.days.join(',')}` : '';
  const what = r.kind === 'simple' ? `${r.lines.length} lines, said with ${r.motion || REMINDER_MOTION}` : r.kind === 'rhythm'
    ? `lets ${Math.round((r.params?.skipChance ?? 0) * 100)}% of looks pass, speaks on its own about ${r.params?.dailySpeaking ?? 0} times a day` : `guide: ${r.guide}`;
  return `${r.id} · ${r.title} · ${r.kind} · ${when}${days} · ${r.active ? `next ${r.nextAt ?? 'never'}` : 'paused'} · ${what}`;
}
