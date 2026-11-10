/**
 * What she does when nobody asks anything of her: the will (will.ts) chooses, this turns the choice
 * into commands for the behaviour system. Each second the will's drives drift with what the body is doing; whenever
 * the body has been free a moment (no command under way, no hand on her), the will is asked what next. The choices are
 * the old body's (`web/kit/body.js` perform), with the new figure's words in place of its drawn poses:
 * - stroll: a short walk, mostly the way she faces, not across where the person works;
 * - explore: a longer way, walking;
 * - retreat: as far from where the person works as she can get;
 * - watch: just beside where the person works, humming there a while;
 * - rest: something calm on the spot; nap: dozing off, then asleep a while;
 * - look: looking about; idle: nothing for a few seconds.
 * A hand dropping or throwing her, a click and talk feed back into the will. The weights and action chains are
 * this project's own (the person's call, 10-28).
 */
import type { BodyMessage } from './body-link.ts';
import type { Behavior, Command } from './behavior.ts';
import { allowed, pick } from './plan.ts';
import { dailyChoices, type CatalogAction } from './catalog.ts';
import type { Choice, Cross, Feeling, Roam, TouchKind, Will, Wish } from './will.ts';

const EDGE = 0.03;
/** Faster than this, a drop is a throw (body/motion.cjs THROW_MIN_SPEED). */
const THROW_SPEED = 500;
const REST = ['hum', 'tap', 'tail', 'bubbles', 'stretch', 'yawn', 'mutter'];

/** The calm words of the pack's catalogue, or the built-in ones when no catalogue was handed in. */
function restWords(actions: CatalogAction[] | undefined): string[] {
  if (!actions?.length) return REST;
  const calm = dailyChoices(actions, ['calm', 'rest', 'bored']).map((action) => action.id);
  return calm.length ? calm : dailyChoices(actions).map((action) => action.id);
}

/** What a daily piece may set (her data directory daily/routine.json): pacing now, more later. */
export interface Routine { gap?: [number, number] }
export interface InteractionPolicy { click?: string; pet?: string; landed?: string; voice?: 'quiet' | 'consider' }

export interface DailyOptions {
  routine?: Routine;
  random?: () => number;
  /** Seconds, for the will's clock. */
  now?: () => number;
  /** Hour of the day, 0..24. */
  hour?: () => number;
  roam?: Roam;
  /** A pack without a teleport only runs across a stretch this often; the rest of the time she stays out of it. */
  crossRunChance?: number;
  /** The pack's actions; when given, a rest and a held pose are chosen from them instead of the built-in words. */
  actions?: CatalogAction[];
}

/** Commands go through this, so a test can see them; the behaviour system's own `command` otherwise. */
type Doer = Pick<Behavior, 'command' | 'busy' | 'doing' | 'place' | 'keptOut' | 'on' | 'instantCross'> & Partial<Pick<Behavior, 'react' | 'canReact'>> & { setCrossPolicy?: (policy: (width: number, urgent: boolean) => Cross) => void };
type Events = { on(event: 'message', listener: (m: BodyMessage) => void): unknown };

export class Daily {
  private nextAt = 0;
  private readonly routine: Routine;
  private lastT: number | null = null;
  private lastX: number | null = null;
  private stillSince = 0;
  private wasBusy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  roam: Roam;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly hour: () => number;
  private readonly crossRunChance: number;
  private readonly restChoices: string[];
  private clickChoices: string[] = [];
  private policy: InteractionPolicy = { voice: 'quiet' };
  private touching = false;

  constructor(private readonly behavior: Doer, link: Events, readonly will: Will, opts: DailyOptions = {}) {
    // The pacing belongs to a daily piece (a script the code agent writes), not to this file: opts.routine comes
    // from her data directory.
    this.routine = opts.routine ?? {};
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now() / 1000);
    this.hour = opts.hour ?? (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; });
    this.roam = opts.roam ?? 'calm';
    this.crossRunChance = opts.crossRunChance ?? 0.1;
    this.restChoices = restWords(opts.actions);
    // Avoidance is a mechanical body policy, but how she gets across is the pack's and the person's call: a pack with
    // a teleport crosses freely, one without only runs across now and then and otherwise stays out of the stretch
    // (`instantCross` says which kind the pack is; `crossTravel` makes the run one continuous pass).
    this.behavior.setCrossPolicy?.(() => (this.behavior.instantCross !== false || this.random() < this.crossRunChance ? 'teleport' : 'stop'));
    link.on('message', (m) => {
      if (m.t === 'grab') {
        this.touching = true;
        // A hand chose a new place. A previous destination must not pull her back after landing.
        this.will.settle('go');
        this.will.settle('near');
      }
      if (m.t === 'drop') this.feel(Math.hypot(m.vx, m.vy) > THROW_SPEED ? 'thrown' : 'dropped');
      if (m.t === 'landed') {
        this.touching = false;
        this.respond('landed', m.interactionId ?? `landed-${m.at ?? this.now()}`);
      }
      if (m.t === 'click') {
        this.feel('poked');
        this.respond('click', m.interactionId ?? `click-${m.at ?? this.now()}`);
      }
      if (m.t === 'pet') {
        this.touching = m.phase === 'started';
        if (m.phase === 'started') {
          this.feel('petted');
          this.respond('pet', m.interactionId);
        }
      }
    });
  }

  /** Sets which library actions answer a click; the configuration layer decides, the daily layer only uses them. */
  setClickActions(ids: readonly string[]): void { this.clickChoices = [...ids]; }

  get interactionPolicy(): Readonly<InteractionPolicy> { return { ...this.policy }; }

  /** Front-selected words remain in force until the front changes them. */
  setInteractionPolicy(policy: InteractionPolicy): Readonly<InteractionPolicy> {
    for (const key of ['click', 'pet', 'landed'] as const) {
      const word = policy[key];
      if (word !== undefined && (!word || !this.behavior.canReact?.(word))) throw new Error(`Unknown interaction action: ${word}`);
    }
    if (policy.voice !== undefined && !['quiet', 'consider'].includes(policy.voice)) throw new Error('Unknown interaction voice policy');
    this.policy = { ...this.policy, ...policy };
    return this.interactionPolicy;
  }

  private respond(kind: TouchKind, interactionId: string): void {
    const selected = this.policy[kind];
    // A click with no front-chosen word plays one of the library's click actions; an empty library falls back to the
    // instinct the will worked out.
    const picked = !selected && kind === 'click' && this.clickChoices.length
      ? [this.clickChoices[Math.min(this.clickChoices.length - 1, Math.floor(this.random() * this.clickChoices.length))]!]
      : null;
    this.behavior.react?.(selected ? [selected] : picked ?? this.will.reaction(kind, this.behavior.doing), interactionId);
    this.nextAt = this.now() + this.between(1.5, 3.5);
  }

  start(everyMs = 1000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), everyMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Something she went through, from outside the body (talked to, a face the front had her wear). */
  feel(kind: Feeling): void {
    this.will.feel(kind, this.now());
    this.nextAt = this.now() + this.between(1.5, 3.5);
  }

  /** Takes a wish from the front (go somewhere, stay, roam, keep away), fading after `ttl` seconds. */
  wish(w: Parameters<Will['wish']>[0]): Wish {
    return this.will.wish(w, this.now());
  }

  /** One beat: drives drift, and when she has been free a moment, the will chooses what next. */
  tick(): void {
    const T = this.now();
    const dt = this.lastT === null ? 0 : Math.min(5, T - this.lastT);
    this.lastT = T;
    const { x } = this.behavior.place;
    if (this.lastX === null || Math.abs(x - this.lastX) > 0.01) { this.lastX = x; this.stillSince = T; }
    const doing = this.behavior.doing;
    this.will.tick({
      dt, T,
      moving: doing === 'walk' || doing === 'run',
      running: doing === 'run',
      seated: doing !== null && this.restChoices.includes(doing),
      asleep: doing === 'sleep' || doing === 'doze',
      still: T - this.stillSince,
      // the body does not say yet whether the person is at the mouse or keyboard
      pointerBusy: false,
      hour: this.hour(),
    });
    const busy = this.behavior.busy;
    if (this.wasBusy && !busy) this.nextAt = Math.max(this.nextAt, T + this.between(1.2, 3.2));
    this.wasBusy = busy;
    if (busy || this.touching || T < this.nextAt) return;
    const c = this.will.next({ T, free: true, roam: this.roam });
    if (!c) { this.nextAt = T + 0.5; return; }
    // an action is followed by a real rest, not by the next one 2 s later (user, 10-29): she plays something, then
    // stands and breathes for a while
    const movement = ['stroll', 'explore', 'retreat', 'watch'].includes(c.name) || c.name === 'go' || c.name === 'near';
    this.nextAt = T + this.between(...this.gap(movement));
    this.perform(c.name, c.wish);
  }

  private perform(name: Choice | 'go' | 'near', wish?: Wish): void {
    const go = (to: number | null, run = false) => to === null ? undefined : this.run({ id: run ? 'run' : 'walk', to });
    switch (name) {
      case 'go':
        if (wish?.x !== undefined) void this.run({ id: wish.run ? 'run' : 'walk', to: wish.x }).then(() => this.will.settle(wish));
        else if (wish) this.will.settle(wish);
        return;
      case 'near': {
        if (!wish || wish.x === undefined) return;
        const r = wish.range ?? 0.08;
        void go(this.clamp(wish.x + (this.random() * 2 - 1) * r), !!wish.run);
        return;
      }
      case 'stroll': void go(this.strollTarget(80, 360)); return;
      case 'explore': {
        const W = this.width();
        void go(this.strollTarget(W * 0.15, W * 0.5, true));
        return;
      }
      case 'retreat': void go(this.awayTarget()); return;
      case 'watch': {
        const spot = this.watchSpot();
        const hum = () => this.run({ id: 'hum', seconds: this.between(8, 14) });
        if (spot === null) void hum();
        else void this.run({ id: 'walk', to: spot }).then((end) => { if (end?.outcome === 'arrived') return hum(); });
        return;
      }
      case 'rest': void this.run({ id: pick(this.restChoices, this.random) }); return;
      case 'nap': void this.run({ id: 'doze' }).then((end) => { if (end?.outcome === 'done') return this.run({ id: 'sleep', seconds: this.between(30, 90) }); }); return;
      case 'look': void this.run({ id: 'look' }); return;
      case 'idle': this.nextAt = this.now() + this.between(20, 35);
    }
  }

  private run(c: Command) {
    // her own wandering waits behind whatever else is running, and never cuts anything short
    return this.behavior.command(c, 'daily').catch(() => undefined);
  }

  private between(lo: number, hi: number): number { return lo + this.random() * (hi - lo); }

  /** Seconds to rest after an action: the routine file's gap, else a calm default. */
  private gap(movement = false): [number, number] {
    const g = this.routine.gap;
    const configured: [number, number] = Array.isArray(g) && g.length === 2 && g.every((n) => typeof n === 'number' && n >= 0) ? [g[0]!, g[1]!] : [5, 12];
    return movement ? [Math.max(configured[0], 20), Math.max(configured[1], 35)] : configured;
  }
  private width(): number { return this.behavior.place.areaWidth || 1920; }
  private clamp(x: number): number { return Math.max(EDGE, Math.min(1 - EDGE, x)); }

  /** Whether the way from `a` to `b` goes over where the person works. */
  private crosses(a: number, b: number): boolean {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return this.behavior.keptOut.some(([z0, z1]) => z1 > lo && z0 < hi);
  }

  /** `lo`–`hi` pixels away, mostly the way she faces; not across where the person works unless `across`. */
  private strollTarget(lo: number, hi: number, across = false): number | null {
    const { x, facing } = this.behavior.place;
    const W = this.width();
    const ahead = facing === 'right' ? 1 : -1;
    const ok = (t: number, free: boolean) => t >= EDGE && t <= 1 - EDGE && allowed(t, this.behavior.keptOut) && (free || !this.crosses(x, t));
    for (let i = 0; i < 24; i++) {
      const dir = i < 12 ? (this.random() < 0.7 ? ahead : -ahead) : this.random() < 0.5 ? 1 : -1;
      const t = x + (dir * this.between(lo, i < 12 ? hi : hi * 1.5)) / W;
      if (ok(t, across && this.random() < 0.15)) return t;
    }
    // no room on this side: a short step, or nothing
    for (let i = 0; i < 8; i++) { const t = x + this.between(-lo, lo) / W; if (ok(t, false)) return t; }
    return null;
  }

  /** The spot farthest from where the person works that she may stand on. */
  private awayTarget(): number | null {
    const zones = this.behavior.keptOut;
    const { x } = this.behavior.place;
    if (!zones.length) return this.clamp(x + (x < 0.5 ? 1 : -1) * this.between(0.25, 0.45));
    let best: number | null = null, bestD = -1;
    for (let i = 0; i < 24; i++) {
      const t = this.between(EDGE, 1 - EDGE);
      if (!allowed(t, zones)) continue;
      const dist = Math.min(...zones.map(([a, b]) => (t < a ? a - t : t > b ? t - b : 0)));
      if (dist > bestD) { best = t; bestD = dist; }
    }
    return best;
  }

  /** Just outside the nearest stretch where the person works; null when there is none. */
  private watchSpot(): number | null {
    const zones = this.behavior.keptOut;
    if (!zones.length) return null;
    const { x } = this.behavior.place;
    const near = (z: readonly [number, number]) => Math.min(Math.abs(x - z[0]), Math.abs(x - z[1]));
    const [a, b] = zones.reduce((m, z) => (near(z) < near(m) ? z : m));
    const W = this.width();
    const left = Math.abs(x - a) <= Math.abs(x - b);
    const t = this.clamp(left ? a - this.between(10, 60) / W : b + this.between(10, 60) / W);
    return allowed(t, zones) ? t : null;
  }
}
