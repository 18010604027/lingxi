/**
 * The behaviour system for the new body: the one place that decides what the
 * body does. The body only plays a clip, moves, talks and reports; everything here is the choosing:
 * - an action word becomes one of its clips, played once, facing the way she faces (writing never mirrored); with how
 *   long (`sleep 3m`), it is kept up that long;
 * - "go there" becomes the figure's walking or running moves (plan.ts), facing the way she goes; a stretch she may not
 *   stand in (where the person works) she blinks across instead of walking over;
 * - a walk or run with nowhere it may go stands idle for a moment and says there is a wall;
 * - between actions she idles; a hand picking her up stops whatever she was doing.
 * Actions run one after another; a newer one (or a hand) cuts the one under way short. Each command says how it ended
 * (`command` event), for the front's `[moved]`.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { BodyCommand, BodyLink, BodyMessage } from './body-link.ts';
import type { Cross } from './will.ts';
import { allowed, crossTravel, nearestAllowed, pick, planTravel, route, type Figure, type MoveClip, type Zone } from './plan.ts';

/** An action as the front gives it (script.ts `Command`): a word, with how long or where to. */
export interface Command { id: string; seconds?: number; to?: number | 'left' | 'right' | 'center' | 'cursor'; interactionId?: string }
export interface CommandEnd { id: string; outcome: 'arrived' | 'done' | 'wall' | 'interrupted' | 'replaced' | 'unknown'; x: number; adjusted?: number; crossed?: number; by?: string }
export interface CommandStart { id: string }
export interface ActionReceipt {
  actionId: string; id: string; clip: string; playbackId: number; interactionId?: string; at: number;
  state: 'started' | 'completed' | 'interrupted' | 'failed' | 'unknown';
}

const WALL_SECONDS = 2.5;

/** Who asked: her session (front) comes first; her own daily script waits its turn. */
export type Urgency = 'front' | 'daily';
const EDGE = 0.03;

export class Behavior extends EventEmitter {
  /** Counts the actions begun; an action that sees it change was cut short. */
  private turn = 0;
  private held = false;
  private handInteractionId: string | undefined;
  private zones: Zone[] = [];
  /** The same stretches as the work area gave them, without her width; the hop across one is sized on these. */
  private raw: Zone[] = [];
  /** Whether she steps around what stands in her way (the person's setting); off walks straight through. */
  private avoidance = true;
  /** What is waiting to be done, oldest first. */
  private queue: Array<{ command: Command; done: (end: CommandEnd) => void; urgent: boolean }> = [];
  private draining = false;
  /** The command under way, to report how it ended when something else takes over. */
  private current: { id: string; turn: number; interactionId?: string } | null = null;
  private readonly clips = new Map<number, Omit<ActionReceipt, 'state' | 'at'> & { started: boolean }>();
  /** Terminal signal emitted before an interrupted asynchronous command unwinds. */
  private readonly cutResults = new Map<number, CommandEnd>();
  private crossPolicy: ((width: number, urgent: boolean) => Cross) | null = null;
  private commandUrgent = false;
  private activeTravel: { x: number; blocked: boolean; escaping: boolean } | null = null;

  constructor(private readonly link: BodyLink, private readonly figure: Figure, private readonly bodyPx: number,
    private readonly random: () => number = Math.random, private readonly wallMs = WALL_SECONDS * 1000) {
    super();
    link.on('message', (m: BodyMessage) => {
      if (m.t === 'clip') {
        const action = this.clips.get(m.id);
        if (action) {
          const { started: _, ...receipt } = action;
          if (m.state === 'playing' && !action.started) {
            action.started = true;
            this.emit('action', { ...receipt, state: 'started', at: Date.now() } satisfies ActionReceipt);
          } else if (m.state !== 'playing') {
            this.clips.delete(m.id);
            this.emit('action', { ...receipt, state: m.state === 'ended' ? 'completed' : m.state === 'failed' ? 'failed' : 'interrupted', at: Date.now() } satisfies ActionReceipt);
          }
        }
      }
      if (m.t === 'grab') {
        this.end('interrupted', 'hand');
        this.turn++;
        this.dropQueued();
        this.held = true;
        this.handInteractionId = m.interactionId;
        this.play(pick(figure.held, random), { loop: true });
      }
      if (m.t === 'landed') { this.held = false; this.handInteractionId = undefined; this.idle(); }
    });
    link.on('gone', () => {
      for (const action of this.clips.values()) {
        const { started: _, ...receipt } = action;
        this.emit('action', { ...receipt, state: 'unknown', at: Date.now() } satisfies ActionReceipt);
      }
      this.clips.clear();
      this.end('unknown', 'disconnect');
      this.turn++;
      this.dropQueued();
      this.held = false;
    });
    link.on('hello', () => this.idle());
  }

  /** Whether a command is under way or a hand holds her. */
  get busy(): boolean { return this.current !== null || this.held || this.queue.length > 0; }

  /** The word of the command under way, 'held' while a hand holds her, null while she idles. */
  get doing(): string | null { return this.held ? 'held' : this.current?.id ?? null; }

  /** Where the body stands and the width of the work area it stands on, in pixels. */
  get place(): { x: number; facing: 'left' | 'right'; areaWidth: number } {
    return { x: this.link.x, facing: this.link.facing, areaWidth: this.link.areaWidth };
  }

  /** Where she may not stand, as the work area gave it: the stretch itself, without her own width. */
  get keptOut(): readonly Zone[] { return this.zones; }

  /** Whether the pack crosses a stretch by teleporting; false means one continuous run (`crossTravel`). */
  get instantCross(): boolean { return this.figure.moves.teleport !== false; }

  /** Turns obstacle avoidance on or off; off drops the stretches she was keeping out of. */
  setAvoidance(on: boolean): void {
    if (this.avoidance === on) return;
    this.avoidance = on;
    if (!on) this.setZones([]);
  }

  /**
   * Where she may not stand (shares of the work area), from the work area's plans.
   *
   * The stretches are widened by half her drawn width first: 銆屼笉绔欒繘鍘汇€嶈鐨勬槸濂圭殑*韬瓙*涓嶈繘鍘伙紝涓嶆槸涓績鐐?   * (user, 10-29). A bigger figure keeps further off, and the width comes from the pack (canvas + hit.box).
   * Nothing moves her when they change 鈥?she walks out on her own next time she goes somewhere (the old rule:
   * llowed/
earestAllowed/
oute decide where she may be).
   */
  setZones(zones: Zone[]): void {
    // With avoidance off the work area's stretches are not hers to mind.
    if (!this.avoidance) zones = [];
    // Two sets, for two questions (user, 10-29): where she may *stand* is the stretch widened by half her body, but
    // hopping across it (blink) is the stretch itself 鈥?a wider zone made that hop longer, which read as a teleport.
    const previous = this.zones;
    this.raw = zones.map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as Zone);
    const half = this.halfWidth();
    this.zones = this.raw.map(([a, b]) => [a - half, b + half] as Zone);
    if (JSON.stringify(previous) === JSON.stringify(this.zones)) return;
    // Replacing the clip uses main.cjs's existing interruptTravel path.  Its
    // replaced receipt releases walk(), which stops or leaves the new zone.
    const active = this.activeTravel;
    const bounds = this.centerBounds();
    const exit = active?.escaping && !allowed(this.link.x, this.zones)
      ? nearestAllowed(this.link.x, this.zones, bounds.lo, bounds.hi) : null;
    const invalidEscape = !!active?.escaping && (!allowed(active.x, this.zones)
      || (!allowed(this.link.x, this.zones) && (exit === null || Math.abs(exit - active.x) > 0.005)));
    if (active && !active.blocked && (invalidEscape || (!active.escaping && (!allowed(this.link.x, this.zones) || !allowed(active.x, this.zones)
      || route(this.link.x, active.x, this.zones).some((leg) => leg.kind === 'cross'))))) {
      active.blocked = true;
      this.idle();
    }
  }

  /** The existing will chooses how a route handles a kept out stretch. */
  setCrossPolicy(policy: (width: number, urgent: boolean) => Cross): void { this.crossPolicy = policy; }

  /** Half her drawn width, as a share of the work area; 0 until both the figure and the work area are known. */
  private halfWidth(): number {
    const box = this.figure.hit?.box;
    const canvas = this.figure.canvas?.width;
    const area = this.link.areaWidth;
    if (!box || !canvas || !area) return 0;
    return (((box.x1 - box.x0) / canvas) * this.bodyPx) / area / 2;
  }

  /** The body window clamps its left edge, so its centre has a smaller reachable range. */
  private centerBounds(): { lo: number; hi: number } {
    const half = this.link.areaWidth > 0 ? this.bodyPx / this.link.areaWidth / 2 : 0;
    return { lo: Math.max(EDGE, half), hi: Math.min(1 - EDGE, 1 - half) };
  }

  /** Stands about, until the next action. */
  idle(): void {
    if (!this.held) this.play(pick(this.figure.idle, this.random), { loop: true });
  }

  /** Whether `word` is something she can do. */
  knows(word: string): boolean {
    return word === 'walk' || word === 'run' || !!this.moveFor(word) || !!this.figure.words[word]?.length;
  }

  canReact(word: string): boolean { return !!this.figure.words[word]?.length; }

  /** Immediate contact feedback shares playback, never queues a backlog or touches speech. */
  react(words: string[], interactionId: string): void {
    if (this.held || this.current?.interactionId) return;
    const id = words.find((word) => this.canReact(word));
    if (!id) return;
    void this.command({ id, interactionId }).catch((error) => console.warn('[behavior] contact reaction failed', error));
  }

  /** Does a command; resolves when it is over or cut short, with how it ended. */
  async command(c: Command, urgency: Urgency = 'front'): Promise<CommandEnd> {
    const [end] = await this.plan([c], urgency);
    return end!;
  }

  /** Queues a front-requested run behind the current body action and returns its eventual outcomes. */
  enqueue(commands: Command[], urgency: Urgency = 'front'): Promise<CommandEnd[]> {
    // Front work must use the same preemption path as `command`/`plan`.
    // Keeping it in the daily queue only set an urgent bit; it did not cut
    // the current daily action or clear stale queued actions.
    return this.plan(commands, urgency, urgency === 'front');
  }

  /**
   * Does a run of commands, one after another, queued with whatever else she is doing.
   *
   * - `front` (her session, `pet_act`): it comes first 鈥?the action under way is cut short and the waiting ones from her
   *   own daily script are dropped (it makes new ones when it thinks of something again);
   * - `daily` (her own wandering): it waits its turn behind whatever is running and preempts nothing.
   *
   * Resolves when every command of this run is over, cut short, or dropped before it started.
   */
  async plan(commands: Command[], urgency: Urgency = 'front', intentUrgent = urgency === 'front'): Promise<CommandEnd[]> {
    if (!commands.length) return [];
    if (!this.link.connected) return commands.map((command) => {
      const end = { id: command.id, outcome: 'unknown', x: this.link.x, by: 'disconnect' } satisfies CommandEnd;
      this.emit('command', end);
      return end;
    });
    if (this.held) return commands.map((c) => {
      const end = { id: c.id, outcome: 'interrupted', x: this.link.x, by: 'hand' } satisfies CommandEnd;
      this.emit('command', end);
      return end;
    });
    if (urgency === 'front') {
      this.end('replaced');
      this.turn++; // whatever is under way is cut; it reports interrupted
      this.dropQueued();
    }
    const ends = new Array<CommandEnd | undefined>(commands.length);
    let left = commands.length;
    const finished = new Promise<CommandEnd[]>((resolve) => {
      commands.forEach((command, i) => {
        this.queue.push({ command, urgent: intentUrgent, done: (end) => { ends[i] = end; if (--left === 0) resolve(ends as CommandEnd[]); } });
      });
    });
    void this.drain();
    return finished;
  }

  /** One command after another, from the queue; a newer front run cuts the one under way. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        if (this.held) break;
        const item = this.queue.shift()!;
        const c = item.command;
        this.commandUrgent = item.urgent;
        const turn = ++this.turn;
        this.current = { id: c.id, turn, ...(c.interactionId ? { interactionId: c.interactionId } : {}) };
        this.emit('command-start', { id: c.id } satisfies CommandStart);
        let end: CommandEnd;
        try {
          end = c.id === 'walk' || c.id === 'run' || this.moveFor(c.id) ? await this.going(c, turn) : await this.gesture(c, turn);
        } catch (error) {
          if (turn !== this.turn) end = { id: c.id, outcome: 'interrupted', x: this.link.x, by: 'disconnect' };
          else throw error;
        }
        if (turn !== this.turn) {
          // The live event and promise agree: disconnect remains unknown; an explicit replacement remains interruption.
          const cut = this.cutResults.get(turn);
          this.cutResults.delete(turn);
          item.done(cut ?? { ...end, outcome: 'interrupted' });
          continue;
        }
        this.current = null;
        this.emit('command', end);
        this.idle();
        item.done(end);
        this.commandUrgent = false;
      }
    } finally {
      this.draining = false;
    }
  }

  /** Drops the commands waiting in the queue, saying they never ran. */
  private dropQueued(): void {
    for (const item of this.queue.splice(0)) {
      const end = { id: item.command.id, outcome: 'replaced', x: this.link.x } satisfies CommandEnd;
      this.emit('command', end);
      item.done(end);
    }
  }

  /** Does one action word once (a command with nothing else). */
  async act(word: string): Promise<boolean> {
    if (!this.knows(word)) return false;
    return (await this.command({ id: word })).outcome !== 'interrupted';
  }

  /** Goes to `x`, walking or running. */
  async goTo(x: number, run = false): Promise<boolean> {
    return (await this.command({ id: run ? 'run' : 'walk', to: x })).outcome === 'arrived';
  }

  say(text: string, ms?: number): void {
    this.link.send({ t: 'say', text, ...(ms ? { ms } : {}) });
  }

  /** Reports the command under way as ended by something else. */
  private end(outcome: 'interrupted' | 'replaced' | 'unknown', by?: string): void {
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.emit('command-cut', c.turn);
    const result = { id: c.id, outcome, x: this.link.x, ...(by ? { by } : {}) } satisfies CommandEnd;
    if (outcome === 'unknown') this.cutResults.set(c.turn, result);
    else this.cutResults.delete(c.turn);
    this.emit('command', result);
  }

  private async gesture(c: Command, turn: number): Promise<CommandEnd> {
    const clips = this.figure.words[c.id];
    if (!clips?.length) return { id: c.id, outcome: 'done', x: this.link.x };
    const clip = c.interactionId ? clips[0]! : pick(clips, this.random);
    const facing = this.figure.noMirror.includes(clip) ? this.figure.nativeFacing : this.link.facing;
    if (c.seconds) {
      // kept up that long: the clip loops, then the next action (or idling) takes over
      this.play(clip, { loop: true, facing });
      await this.until(turn, c.seconds * 1000);
    } else {
      await this.playOnce(clip, facing);
    }
    return { id: c.id, outcome: turn === this.turn ? 'done' : 'interrupted', x: this.link.x };
  }

  /** The way of moving the front named, when it is one of the figure's moves. */
  private moveFor(word: string): MoveClip | null {
    for (const list of [this.figure.moves.walk, this.figure.moves.run]) {
      const found = list.find((m) => m.id === word);
      if (found) return found;
    }
    return null;
  }

  private async going(c: Command, turn: number): Promise<CommandEnd> {
    // a named way of moving (the front chose it) keeps to that clip; plain walk/run pick a variant while going
    const named = this.moveFor(c.id);
    const run = c.id === 'run' || (named ? this.figure.moves.run.includes(named) : false);
    let crossed = 0;
    let adjusted: number | undefined;
    const startX = this.link.x;
    const startedBlocked = !allowed(startX, this.zones);
    const bounds = this.centerBounds();
    const goOnce = async (want: number | null): Promise<'arrived' | 'wall' | 'cut'> => {
      let escaped = false;
      while (turn === this.turn) {
        const trapped = this.zones.find(([a, b]) => this.link.x > a && this.link.x < b);
        if (!trapped) break;
        escaped = true;
        const exit = nearestAllowed(this.link.x, this.zones, bounds.lo, bounds.hi);
        if (exit === null) {
          await this.wall(turn);
          return turn === this.turn ? 'wall' : 'cut';
        }
        // Keep correcting from the actual position until the body confirms a legal location. Do not resume the old
        // target in this run, since it could send her straight back through the same kept out stretch.
        if (this.figure.moves.teleport !== false) await this.teleportTo(exit, turn);
        else if (!await this.dashTo(exit, turn, true)) {
          await this.wall(turn);
          return turn === this.turn ? 'wall' : 'cut';
        }
      }
      if (turn !== this.turn) return 'cut';
      if (escaped) return startedBlocked ? 'arrived' : 'wall';
      const x = want === null ? null : nearestAllowed(want, this.zones, bounds.lo, bounds.hi);
      if (x === null) {
        await this.wall(turn);
        return turn === this.turn ? 'wall' : 'cut';
      }
      if (want !== null && Math.abs(x - want) > 0.005) adjusted = x;
      // Route against the same expanded keep-out geometry used to validate
      // standing positions.  Using raw window spans here let the body centre
      // clear a window while its drawn body still entered it.
      for (const leg of route(this.link.x, x, this.zones)) {
        if (turn !== this.turn) return 'cut';
        if (!allowed(this.link.x, this.zones)) return goOnce(null);
        if (leg.kind === 'cross') {
          if (!allowed(leg.to, this.zones)) return 'wall';
          const width = this.raw.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
          // Keep-out is a mechanical safety boundary.  A daily policy may
          // explicitly choose teleport/stop/turn, but an uninstalled policy
          // must never silently turn a normal route into a dash through the
          // forbidden stretch.
          const decision = this.crossPolicy?.(width, this.commandUrgent) ?? 'stop';
          if (decision && decision !== 'teleport') {
            if (decision === 'turn' && Math.abs(this.link.x - startX) > 0.005) await this.walk(startX, false, turn);
            return turn === this.turn ? 'wall' : 'cut';
          }
          crossed++;
          if (decision === 'teleport') {
            if (this.figure.moves.teleport !== false) await this.teleportTo(leg.to, turn);
            else if (!await this.dashTo(leg.to, turn)) return turn === this.turn ? 'wall' : 'cut';
          }
        } else {
          if (!await this.walk(leg.to, run, turn, named)) {
            if (!allowed(this.link.x, this.zones)) return goOnce(null);
            return turn === this.turn ? 'wall' : 'cut';
          }
        }
      }
      return turn === this.turn ? 'arrived' : 'cut';
    };
    const extra = () => ({ ...(adjusted !== undefined ? { adjusted } : {}), ...(crossed ? { crossed } : {}) });

    if (c.to !== undefined) {
      const how = await goOnce(this.placeX(c.to));
      return { id: c.id, outcome: how === 'cut' ? 'interrupted' : how, x: this.link.x, ...extra() };
    }
    if (c.seconds) {
      // about the whole area while the time lasts
      const until = Date.now() + c.seconds * 1000;
      while (turn === this.turn && Date.now() < until) {
        const how = await goOnce(this.anywhere(run ? 0.2 : 0.06));
        if (how !== 'arrived') return { id: c.id, outcome: how === 'cut' ? 'interrupted' : how, x: this.link.x, ...extra() };
      }
      return { id: c.id, outcome: 'done', x: this.link.x, ...extra() };
    }
    // bare: a short stroll, or a run to the far side
    const how = await goOnce(run ? (this.link.x < 0.5 ? bounds.hi : bounds.lo) : this.anywhere(0.06));
    return { id: c.id, outcome: how === 'cut' ? 'interrupted' : how === 'arrived' ? 'done' : how, x: this.link.x, ...extra() };
  }

  /** Walks or runs to `x` (`plan.ts` moves). */
  private async walk(x: number, run: boolean, turn: number, move?: MoveClip | null, escaping = false): Promise<boolean> {
    const bounds = this.centerBounds();
    if (escaping) {
      if (allowed(this.link.x, this.zones)) return true;
      const exit = nearestAllowed(this.link.x, this.zones, bounds.lo, bounds.hi);
      if (exit === null) return false;
      x = exit;
    }
    const variants = this.figure.moves[run ? 'run' : 'walk'];
    const defaults = variants.filter((candidate) => candidate.default !== false);
    const selected = move ?? pick(defaults.length ? defaults : variants, this.random);
    const plan = planTravel(this.link.x, x, this.link.areaWidth, this.bodyPx, this.figure.refWidth, selected);
    // Leaving a kept-out stretch is one direct movement to the nearest legal
    // edge. Splitting it into strides can put an intermediate target deeper
    // in the stretch or on the body window's unreachable side.
    if (escaping) {
      const active = { x, blocked: false, escaping: true };
      this.activeTravel = active;
      try {
        if (allowed(this.link.x, this.zones) || !allowed(active.x, this.zones)) return false;
        const exit = nearestAllowed(this.link.x, this.zones, bounds.lo, bounds.hi);
        if (exit === null || Math.abs(exit - active.x) > 0.005) return false;
        await this.playOnce(selected.clip, x > this.link.x ? 'right' : 'left',
          { x, leadSec: plan?.steps[0]?.leadSec ?? selected.leadSec, tailSec: plan?.steps[0]?.tailSec ?? selected.tailSec },
          plan?.steps[0]?.endSec ?? selected.endSec, plan?.steps[0]?.segment);
      } finally {
        if (this.activeTravel === active) this.activeTravel = null;
      }
      if (active.blocked) return false;
      return true;
    }
    if (!plan && run) {
      // A short run can be below the running clip's minimum stride. Use a
      // small walk (or its short-travel fallback) so the requested target is
      // not reported as reached while the body stays still.
      const walkVariants = this.figure.moves.walk;
      const walkDefaults = walkVariants.filter((candidate) => candidate.default !== false);
      const walker = pick(walkDefaults.length ? walkDefaults : walkVariants, this.random);
      const walkingPlan = planTravel(this.link.x, x, this.link.areaWidth, this.bodyPx, this.figure.refWidth, walker);
      if (walkingPlan) return this.walk(x, false, turn, walker);
      if (Math.abs(x - this.link.x) > 0.001 && allowed(this.link.x, this.zones) && allowed(x, this.zones)
        && !route(this.link.x, x, this.zones).some((leg) => leg.kind === 'cross')) {
        const direction = x > this.link.x ? 'right' : 'left';
        const active = { x, blocked: false, escaping: false };
        this.activeTravel = active;
        try {
          if (!allowed(this.link.x, this.zones) || !allowed(x, this.zones)
            || route(this.link.x, x, this.zones).some((leg) => leg.kind === 'cross')) return false;
          const step = crossTravel(this.link.x, x, walker, this.link.areaWidth, this.bodyPx, this.figure.refWidth)?.steps[0];
          await this.playOnce(walker.clip, direction, { x, leadSec: step?.leadSec ?? 0, tailSec: step?.tailSec ?? 0 }, step?.endSec, step?.segment);
        } finally {
          if (this.activeTravel === active) this.activeTravel = null;
        }
        if (active.blocked) return false;
      }
      return true;
    }
    if (!plan) return true;
    for (const step of plan.steps) {
      if (turn !== this.turn) return false;
      // Work areas can change while a previous clip plays.  Recheck each
      // segment from the body's actual position before issuing it.
      if (escaping) {
        if (allowed(this.link.x, this.zones) || !allowed(step.x, this.zones)) return false;
        const exit = nearestAllowed(this.link.x, this.zones, bounds.lo, bounds.hi);
        if (exit === null || Math.abs(exit - step.x) > 0.005) return false;
      } else if (!allowed(this.link.x, this.zones) || !allowed(step.x, this.zones)
        || route(this.link.x, step.x, this.zones).some((leg) => leg.kind === 'cross')) return false;
      const active = { x: step.x, blocked: false, escaping };
      this.activeTravel = active;
      try {
        await this.playOnce(step.clip, plan.facing, { x: step.x, leadSec: step.leadSec, tailSec: step.tailSec }, step.endSec, step.segment);
      } finally {
        if (this.activeTravel === active) this.activeTravel = null;
      }
      if (active?.blocked) return false;
    }
    return true;
  }

  /** One run across, in a single clip, with no other action in between. */
  private async dashTo(x: number, turn: number, escaping = false): Promise<boolean> {
    const move = this.figure.moves.cross;
    // No implicit walking/running fallback. The pack must name a fast crossing and bound any stopping tail.
    if (!move || (!move.segment && move.tailSec > 0 && move.endSec === undefined)) return false;
    const plan = crossTravel(this.link.x, x, move, this.link.areaWidth, this.bodyPx, this.figure.refWidth);
    if (!plan) return true;
    const step = plan.steps[0]!;
    const active = { x, blocked: false, escaping };
    this.activeTravel = active;
    try {
      await this.playOnce(step.clip, plan.facing, { x: step.x, leadSec: step.leadSec, tailSec: step.tailSec }, step.endSec, step.segment);
    } finally { if (this.activeTravel === active) this.activeTravel = null; }
    return turn === this.turn && !active.blocked;
  }

  private async teleportTo(x: number, turn: number): Promise<void> {
    if (turn !== this.turn) return;
    let id = 0;
    const arrived = this.link.waitFor((m) => id !== 0 && m.t === 'move' && m.id === id);
    id = this.link.send({ t: 'move', x, mode: 'instant' });
    await arrived;
  }

  /** Nowhere to go: wait without showing movement that is not happening. */
  private async wall(turn: number): Promise<void> {
    this.idle();
    await this.until(turn, this.wallMs);
  }

  private placeX(to: NonNullable<Command['to']>): number {
    const { lo, hi } = this.centerBounds();
    if (to === 'left') return lo;
    if (to === 'right') return hi;
    if (to === 'center') return 0.5;
    // the body does not say where the pointer is yet: stay put
    // the pointer, once the body has reported one; her own x is only the fallback
    if (to === 'cursor') {
      const d = this.link.display;
      return this.link.pointer && d?.width ? (this.link.pointer.x - d.x) / d.width : this.link.x;
    }
    return Math.max(lo, Math.min(hi, to));
  }

  /** Somewhere she may stand, at least `minDist` away; null when nowhere is. */
  private anywhere(minDist: number): number | null {
    const { lo, hi } = this.centerBounds();
    for (let i = 0; i < 32; i++) {
      const x = lo + this.random() * (hi - lo);
      if (Math.abs(x - this.link.x) > minDist && allowed(x, this.zones)) return x;
    }
    return nearestAllowed(this.link.x < 0.5 ? hi : lo, this.zones, lo, hi);
  }

  /** Waits `ms`, or until another action begins. */
  private until(turn: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => { if (turn !== this.turn || Date.now() - started >= ms) { clearInterval(tick); resolve(); } }, 100);
    });
  }

  private play(clip: string, opts: Omit<Extract<BodyCommand, { t: 'play' }>, 't' | 'clip'> = {}): number {
    const id = this.link.send({ t: 'play', clip: `${clip}.webm`, ...opts });
    this.clips.set(id, { actionId: randomUUID(), id: this.held ? 'held' : this.current?.id ?? 'idle', clip,
      playbackId: id, ...((this.held ? this.handInteractionId : this.current?.interactionId) ? { interactionId: this.held ? this.handInteractionId : this.current?.interactionId } : {}), started: false });
    return id;
  }

  /** Plays a clip once and waits for it to be over: ended, replaced by another, or failed. */
  private async playOnce(clip: string, facing: 'left' | 'right', travel?: { x: number; leadSec: number; tailSec: number }, endSec?: number,
    segment?: Extract<BodyCommand, { t: 'play' }>['segment']): Promise<void> {
    let id = 0;
    const done = this.link.waitFor((m) => id !== 0 && m.t === 'clip' && m.id === id && m.state !== 'playing');
    const turn = this.current?.turn;
    let release: () => void = () => {};
    const cut = new Promise<void>((resolve) => {
      const listener = (endedTurn: number) => { if (turn !== undefined && endedTurn === turn) resolve(); };
      this.on('command-cut', listener);
      release = () => this.off('command-cut', listener);
    });
    id = this.play(clip, { facing, ...(travel ? { travel } : {}), ...(endSec !== undefined ? { endSec } : {}), ...(segment ? { segment } : {}) });
    try { await Promise.race([done, cut]); } finally { release(); }
  }
}
