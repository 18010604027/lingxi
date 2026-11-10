/**
 * Body-facing application services: action and interaction events, shared output,
 * user questions, and their local API projections. The independent application
 * supplies the front and owns its lifecycle. The historical plugin host also uses
 * these services; that optional entry is not part of the product release.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Behavior } from '../behavior/behavior.ts';
import { allowed, nearestAllowed } from '../behavior/plan.ts';
import { parseScript, type Action } from './script.ts';
import { figureVocab } from './vocab.ts';
import { BodyLink } from '../behavior/body-link.ts';
import { Daily } from '../behavior/daily.ts';
import { buildCatalog } from '../behavior/catalog.ts';
import { loadPack } from '../behavior/pack.ts';
import { createWill } from '../behavior/will.ts';
import { workareaBody } from '../behavior/workarea-body.ts';
import { watchWorkarea } from '../daily/workarea.ts';
import { ReminderEngine, ReminderStore, type Reminder } from '../daily/reminders.ts';

/** A body that crashes more often than this is left down, so a broken one does not spin. */
const RESTARTS = { max: 5, withinMs: 60_000 };

export interface HostOptions {
  /** Where the repository (clips, `body/`, electron) lives; `LINGXI_ROOT` when absent. */
  root?: string;
  /** Lines worth seeing in the DSH log. */
  log?: (line: string) => void;
}

export interface Host {
  behavior: Behavior;
  daily: Daily;
  link: BodyLink;
  /** Where the repository is: her pack and her self-description live there. */
  readonly root: string;
  /** Whether the window is running. */
  readonly alive: boolean;
  /** A bubble, as the session's `pet_say` shows it. */
  say(text: string): void;
  /** Action words one after another ("run 3m", "walk 30%"); how each ended. */
  act(words: string[]): Promise<string>;
  /** Where she stands and where she may go, in whole percent. */
  where(): string;
  /** Her own alarms, as the panel lists them. */
  reminders(): Reminder[];
  /** Takes an alarm away; true when there was one. */
  removeReminder(id: string): boolean;
  /** A question and its options in the bubble. */
  ask(question: string, options: string[]): void;
  stop(): void;
}

/** What the person typed on her 说 window, for her one session. */
const typedListeners: Array<(text: string) => void> = [];
/** Subscribe to text entered through the body's 说 window. Returns a disposer. */
export function onTyped(listener: (text: string) => void): () => void {
  typedListeners.push(listener);
  return () => {
    const at = typedListeners.indexOf(listener);
    if (at >= 0) typedListeners.splice(at, 1);
  };
}

/** The host this process started, for the agent's tools; null before the plugin's body half is up. */
let running: Host | null = null;
export function getHost(): Host | null {
  return running;
}

/** Starts her body and the two things that move it; resolves once the body process is started. */
export async function startHost(options: HostOptions = {}): Promise<Host> {
  const log = options.log ?? ((line: string) => console.log(line));
  // where the repository is: the setting, the environment, or the one line ~/.lingxi/root (written once by hand)
  const noted = join(homedir(), '.lingxi', 'root');
  const root = options.root ?? process.env.LINGXI_ROOT ?? (existsSync(noted) ? readFileSync(noted, 'utf8').trim() : '');
  if (!root || !existsSync(join(root, 'body'))) {
    throw new Error('lingxi: her body is not where the plugin expects it; set LINGXI_ROOT to the repository');
  }
  // the figure is a pack of data (core/behavior/pack.ts), not a path in the code
  const pack = loadPack(root);
  const clips = pack.clips;
  if (!existsSync(clips)) throw new Error(`lingxi: no clips in ${clips}; point LINGXI_CLIPS at the pack's clips folder`);
  // the movement maths is the pack's own; without it there is nothing to run
  const motionFile = join(pack.dir, 'motion.cjs');
  if (!existsSync(motionFile)) throw new Error(`lingxi: the figure pack has no motion.cjs: ${pack.dir} (format: packs/README.md)`);
  const figure = pack.figure;
  const link = new BodyLink();
  const url = await link.start();
  const behavior = new Behavior(link, figure, figure.bodyWidth);
  // The reminder engine can tick immediately during start. Keep the script
  // builder above engine construction so a due reminder never reaches a
  // still-uninitialised lexical binding (the bundled host runs this in one
  // module and exposes TDZ errors directly to DSH).
  const vocab = figureVocab(figure);
  const wire = (action: Action) => (typeof action === 'string'
    ? action
    : { id: action.id, ...(action.seconds !== undefined ? { seconds: action.seconds } : {}), ...(action.to !== undefined ? { to: action.to } : {}) });
  const sayScript = (text: string, holdSec = 0) => {
    const words = String(text ?? '').trim();
    if (!words) return;
    const { beats } = parseScript(words, vocab);
    const made = beats.map((beat) => ({
      text: beat.text,
      actions: beat.actions.map(wire),
      anchors: beat.anchors.map((a) => ({ at: a.at, actions: a.actions.map(wire) })),
    }));
    if (!made.length) { link.send({ t: 'say', text: words }); return; }
    console.log('[lingxi] sending', made.length, 'beat(s):', JSON.stringify(made.map((b) => b.text)).slice(0, 120));
    link.send({ t: 'say', text: words, beats: made, ...(holdSec ? { hold: holdSec } : {}) });
  };
  // where she may not stand: the screen is still read here (plugin-host runs beside DSH, not in a session), and the
  // stretches under the person's input box go to the behaviour system; the learning that feeds the control center
  // needs the roles behind her, so it is left out until her session exists
  const dataDir = process.env.LINGXI_DATA_DIR ?? join(homedir(), '.lingxi', 'data');
  // Her pacing is a daily piece, not repository code: `daily/routine.json` in her data directory.
  // A missing or broken file simply leaves the defaults in place.
  const routineDir = join(dataDir, 'daily');
  const routineFile = join(routineDir, 'routine.json');
  const routine = (() => {
    try {
      return JSON.parse(readFileSync(routineFile, 'utf8')) as { gap?: [number, number] };
    } catch {
      try {
        mkdirSync(routineDir, { recursive: true });
        writeFileSync(routineFile, JSON.stringify({ gap: [5, 12] }, null, 2));
      } catch { /* her data directory may be read-only; the defaults still apply */ }
      return {};
    }
  })();
  const daily = new Daily(behavior, link, createWill(), { routine, actions: buildCatalog(figure) });
  daily.start();
  // where she stood last time: she appears there again, rather than in the middle of wherever the person is working
  const spotFile = join(dataDir, 'spot.json');
  let startX = '';
  try {
    const kept = JSON.parse(readFileSync(spotFile, 'utf8')) as { x?: unknown };
    if (typeof kept.x === 'number' && kept.x >= 0 && kept.x <= 1) startX = String(kept.x);
  } catch { /* first run */ }
  const saveSpot = setInterval(() => {
    try { if (link.connected) writeFileSync(spotFile, JSON.stringify({ x: Number(link.x.toFixed(4)) })); } catch { /* not worth stopping for */ }
  }, 5000);
  saveSpot.unref();
  // What the person types on her 说 window: their words come back in a bubble at once, then hers
  // (the bubbles are hers, the thinking is the session's)
  link.on('message', (m: { t: string; text?: string }) => {
    if (m.t !== 'typed') return;
    const said = String(m.text ?? '').trim();
    if (!said) return;
    link.send({ t: 'said', text: said });
    for (const listener of typedListeners) {
      try { listener(said); } catch { /* a listener that throws must not lose the echo */ }
    }
  });

  const workarea = watchWorkarea({ dataDir, body: workareaBody(link, behavior, figure.bodyWidth) });
  // her alarms: kept in her own data directory, said through her body (the session wake-up comes later, when her
  // conversation is the front — a later step)
  // Her reminders used to live in `reminders.sqlite` (the old brain); the plugin's store is `reminders.json`. Bring
  // anything the older store has that this one lacks, so a reminder made before the move keeps firing (10-29: the
  // hourly water one had been left behind).
  const reminders = new ReminderStore(join(dataDir, 'reminders.json'));
  const legacy = join(dataDir, 'reminders.sqlite');
  if (existsSync(legacy)) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(legacy, { readOnly: true });
      for (const row of db.prepare('select body from reminder').all() as Array<{ body: string }>) {
        const record = JSON.parse(row.body) as Reminder;
        if (!record?.id || reminders.get(record.id)) continue;
        reminders.put(record);
      }
      db.close();
    } catch (err) {
      console.error('[lingxi] could not read the older reminder store:', (err as Error)?.message ?? err);
    }
  }
  const engine = new ReminderEngine(reminders, {
    say: async (line, motion) => {
      sayScript(line);
      if (motion) await behavior.plan(motion.split(',').map((w) => ({ id: w.trim() })).filter((c) => c.id), 'daily');
      return true;
    },
    wakeFront: () => { /* the panel shows it; waking her session is step 3's remainder */ },
    onStale: () => { /* lines are the pack's business; nothing to ask yet */ },
  });
  engine.start();

  const electron = join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  let body: ChildProcess | null = null;
  let stopping = false;
  let alive = true;
  const exits: number[] = [];

  const startBody = () => {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    // She is born at a spot she may stand on: the work area is read first (a moment at worst), then the window is
    // created there and shown — so there is never a move to see, not even a hidden one.
    const first = async () => {
      const until = Date.now() + 2500;
      while (Date.now() < until && behavior.keptOut.length === 0) await new Promise((r) => setTimeout(r, 100));
      if (stopping) return;
      const wanted = startX ? Number(startX) : Number.NaN;
      const from = Number.isFinite(wanted) && wanted >= 0 && wanted <= 1 ? wanted : 0.5;
      const spot = allowed(from, behavior.keptOut) ? from : nearestAllowed(from, behavior.keptOut, 0.03, 0.97) ?? from;
      spawnBody(spot);
    };
    const spawnBody = (spot: number) => {
      const child = spawn(electron, [join(root, 'body')], {
        env: {
          ...env,
          BODY_CLIPS: clips,
          BODY_WS: url,
          BODY_WIDTH: String(figure.bodyWidth),
          ...(figure.hit?.box ? { BODY_HIT_BOX: JSON.stringify(figure.hit.box) } : {}),
          BODY_MOTION: motionFile,
          BODY_START_X: String(spot),
          // hidden until it has said hello, so the window never flashes at a spot before it is sure of
          BODY_HIDDEN: '1',
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      body = child;
      // Show her only after the body has said hello: at the moment it is spawned nothing is connected yet, and an
      // early return here used to leave her hidden for good.
      const reveal = async () => {
        const until = Date.now() + 20_000;
        while (!link.connected && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
        if (!link.connected) {
          log('[lingxi] her body never said hello; leaving the window as it is');
          return;
        }
        if (stopping) return;
        link.send({ t: 'show' });
        log(`[lingxi] she is on screen at ${(link.x * 100).toFixed(0)}%`);
      };
      void reveal();
      child.on('exit', (code, signal) => {
        if (body === child) body = null;
        if (stopping) return;
        const now = Date.now();
        exits.push(now);
        while (exits.length && now - exits[0]! > RESTARTS.withinMs) exits.shift();
        if (exits.length > RESTARTS.max) {
          log(`[lingxi] her body exited ${exits.length} times within a minute (last: ${signal ?? code}); left down`);
          return;
        }
        log(`[lingxi] her body exited (${signal ?? code}); starting it again`);
        setTimeout(() => void first(), 1000);
      });
    };
    void first();
  };
  void startBody();

  // A script becomes a run of beats, one bubble each, with actions played as they come.
  const commandOf = (action: Action) => (typeof action === 'string'
    ? { id: action }
    : { id: action.id, ...(action.seconds !== undefined ? { seconds: action.seconds } : {}), ...(action.to !== undefined ? { to: action.to } : {}) });
  const host: Host = {
    behavior,
    daily,
    link,
    root,
    get alive() { return alive; },

    reminders: () => reminders.list(),
    removeReminder: (id) => reminders.delete(id),

    /** One bubble, or a whole script: 【…】 and <…> split the words into beats, each beat its own bubble, in order. */
    say: (text) => { void sayScript(text); },

    /** "run 3m", "walk 30%", "jump x2" — the words the front writes, with a time or a place on them. */
    act: async (words) => {
      // one run, handed to the behaviour system whole: it queues it (and cuts short what it finds), rather than a
      // loop here driving command after command, which would put a second scheduler outside the behaviour system
      const run: Array<{ id: string; seconds?: number; to?: number }> = [];
      for (const word of words) {
        const [id, ...rest] = String(word).trim().split(/\s+/);
        if (!id) continue;
        const command: { id: string; seconds?: number; to?: number } = { id };
        for (const bit of rest) {
          if (/^\d+(\.\d+)?%$/.test(bit)) command.to = Number(bit.slice(0, -1)) / 100;
          else if (/^\d+(\.\d+)?[sm]$/.test(bit)) command.seconds = Number(bit.slice(0, -1)) * (bit.endsWith('m') ? 60 : 1);
        }
        run.push(command);
      }
      const ends = await behavior.plan(run, 'front');
      return ends.map((end) => `${end.id}: ${end.outcome}`).join(', ') || 'nothing to do';
    },

    where: () => {
      const q = (v: number) => Math.round(v * 100);
      const blocked = behavior.keptOut.map(([a, b]) => [q(a), q(b)] as [number, number]).filter(([a, b]) => b > a);
      const free: Array<[number, number]> = [];
      let at = 0;
      for (const [a, b] of [...blocked].sort((x, y) => x[0] - y[0])) { if (a - at >= 4) free.push([at, a]); at = Math.max(at, b); }
      if (100 - at >= 4) free.push([at, 100]);
      const mine = q(link.x);
      const may = free.length ? free.map(([a, b]) => `${a}–${b}%`).join('、') : '没有能去的地方';
      const mayNot = blocked.length ? blocked.map(([a, b]) => `${a}–${b}%`).join('、') : '';
      return `你站在屏幕横向 ${mine}% 处。能去:${may}。${mayNot ? `不能去(有人在用的地方):${mayNot}。` : '整条都能去。'}`;
    },

    ask: (question, options) => {
      const said = `${question}${options.length ? ` ${options.map((o, i) => `${i + 1}. ${o}`).join(' ')}` : ''}`;
      link.send({ t: 'say', text: said });
    },

    stop() {
      if (!alive) return;
      alive = false;
      stopping = true;
      running = null;
      clearInterval(saveSpot);
      engine.stop();
      reminders.close();
      workarea.stop();
      daily.stop();
      body?.kill();
      body = null;
      link.close();
    },
  };
  running = host;
  return host;
}
