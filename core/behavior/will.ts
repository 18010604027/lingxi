/**
 * Her own will, for when nobody asks anything of her (moved here from the old body's
 * `web/kit/will.js`). Nobody else orders a move through it; they change what she feels. The person's hand is
 * something she goes through; the front gives moods and wishes that fade; the control center tunes her habits; where
 * the person works is a place she finds uncomfortable. From those she keeps a few drives that drift with time
 * (energy, curiosity, wanting company, boredom, unease), scores what she could do next, keeps to a choice for a while
 * so it looks like she means it, and picks with a little chance so it is never the same twice. How she gets past where
 * the person works (stop, turn back, blink across) is chosen the same way. The person's reaction to a choice (moving
 * her away, petting her) nudges the habits it came from.
 * There is one inner state, and both what she does and what she says come from it: `describe` puts it into words for
 * the front, so its words match what the body does. Pure: daily.ts hands it what the
 * body is doing and asks it what to do.
 */

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface Drives { energy: number; curiosity: number; social: number; boredom: number; unease: number; joy: number; night: number }

const FEELING_WORDS = {
  tired: ['tired', '累了'], slightlyTired: ['a bit tired', '有点累'], rested: ['rested', '精力充足'],
  wary: ['wary, having just been moved away by hand', '刚被挪开，有些警惕'], unsettled: ['a little unsettled', '有点不安'],
  social: ['wanting company', '想有人陪'], restless: ['restless', '有点无聊，想活动'], curious: ['curious', '好奇'],
  cheerful: ['cheerful', '心情愉快'], low: ['low', '情绪低落'], late: ['it is late', '夜深了'],
} as const;
export type FeelingCode = keyof typeof FEELING_WORDS;
export interface FeelingState { codes: FeelingCode[]; text: string; summary: string }

/** Both the model text and the UI summary describe the same drive thresholds. */
export function describeFeeling(d: Drives): FeelingState {
  const codes: FeelingCode[] = [d.energy < 0.25 ? 'tired' : d.energy < 0.5 ? 'slightlyTired' : 'rested'];
  if (d.unease > 0.45) codes.push('wary'); else if (d.unease > 0.2) codes.push('unsettled');
  if (d.social > 0.6) codes.push('social');
  if (d.boredom > 0.6) codes.push('restless');
  if (d.curiosity > 0.65) codes.push('curious');
  if (d.joy > 0.65) codes.push('cheerful'); else if (d.joy < 0.15) codes.push('low');
  if (d.night >= 1) codes.push('late');
  return { codes, text: codes.map((code) => FEELING_WORDS[code][0]).join('; '), summary: codes.map((code) => FEELING_WORDS[code][1]).join('；') };
}

/** What she could do on her own, with how much each drive pulls toward it. */
const CHOICES = {
  stroll: (d: Drives) => (0.5 * d.boredom + 0.3 * d.curiosity + 0.1) * d.energy,
  explore: (d: Drives) => d.curiosity * d.energy * (0.4 + d.joy * 0.6) * 0.9,
  watch: (d: Drives) => d.social * (1 - d.unease) * 0.8,
  rest: (d: Drives) => (1 - d.energy) * 0.7 + 0.05,
  nap: (d: Drives) => (1 - d.energy) ** 2 * d.night,
  look: (d: Drives) => 0.15 + 0.35 * d.curiosity,
  idle: (d: Drives) => 0.18 + 0.2 * (1 - d.boredom),
  retreat: (d: Drives) => d.unease * 0.9,
};
export type Choice = keyof typeof CHOICES;

/** Obstacle crossing is mechanical: instant teleport, or the pack's one fast crossing move as fallback. */
export type Cross = 'stop' | 'turn' | 'teleport';

export type WishKind = 'go' | 'near' | 'roam' | 'stay' | 'away';
export interface Wish { kind: WishKind; x?: number; range?: number; run?: boolean; walkId?: string; strength: number; until: number; why?: string }
export type WishInput = Partial<Omit<Wish, 'until'>> & { kind: WishKind; ttl?: number };

/** What the body is doing, each tick. */
export interface TickState { dt: number; T: number; moving: boolean; running: boolean; seated: boolean; asleep: boolean; still: number; pointerBusy: boolean; hour?: number }
export type Roam = 'free' | 'calm' | 'off';
export type Feeling = 'thrown' | 'dropped' | 'petted' | 'poked' | 'talked' | `face:${string}`;
export type TouchKind = 'click' | 'pet' | 'landed';

interface Decision { kind: 'choice' | 'cross'; name: string; at: number; why: string }

export interface Will {
  readonly drives: Drives;
  readonly habits: Record<string, number>;
  readonly recent: Decision[];
  readonly current: { name: string; since: number; minUntil: number; wish?: Wish } | null;
  readonly wishes: Wish[];
  tick(s: TickState): void;
  wish(w: WishInput, T: number): Wish;
  feel(kind: Feeling, T: number): void;
  reaction(kind: TouchKind, doing: string | null): string[];
  next(s: { T: number; free: boolean; roam: Roam }): { name: Choice | 'go' | 'near'; wish?: Wish } | null;
  cross(s: { T: number; width: number; urgent?: boolean; pointerBusy?: boolean; policy?: Cross }): Cross;
  describe(): string;
  settle(w: Wish | WishKind): void;
}

/**
 * `opts.rnd`: a 0..1 random source (tests pass a seeded one). `opts.habits`: weights per choice and per crossing,
 * 1 when absent; the control center tunes them and reactions nudge them.
 */
export function createWill(opts: { rnd?: () => number; habits?: Record<string, number> } = {}): Will {
  const rnd = opts.rnd ?? Math.random;
  const habits: Record<string, number> = { ...opts.habits };
  const drives: Drives = { energy: 0.75, curiosity: 0.4, social: 0.3, boredom: 0.2, unease: 0, joy: 0.3, night: 0 };
  let wishes: Wish[] = [];
  let current: Will['current'] = null;
  const recent: Decision[] = []; // the last decisions, newest last

  const habit = (k: string) => habits[k] ?? 1;
  const remember = (kind: Decision['kind'], name: string, at: number, why: string) => {
    recent.push({ kind, name, at, why });
    if (recent.length > 40) recent.shift();
  };

  return {
    drives,
    habits,
    recent,
    get current() { return current; },
    get wishes() { return wishes; },

    /** Drives drift each tick. `still`: seconds in one spot; `pointerBusy`: the person is moving the mouse or typing. */
    tick(s) {
      const dt = s.dt;
      drives.energy = clamp01(drives.energy + dt * (s.asleep ? 0.02 : s.seated ? 0.008 : s.running ? -0.02 : s.moving ? -0.006 : 0.001));
      drives.boredom = clamp01(s.moving ? drives.boredom - dt * 0.05 : drives.boredom + dt * (s.still > 20 ? 0.006 : 0.002));
      drives.curiosity = clamp01(drives.curiosity + dt * (s.pointerBusy ? 0.004 : -0.002));
      drives.social = clamp01(drives.social - dt * 0.002);
      drives.unease = clamp01(drives.unease - dt * 0.01);
      drives.joy = clamp01(drives.joy + (0.3 - drives.joy) * dt * 0.01);
      const h = s.hour ?? 12;
      drives.night = h >= 23 || h < 7 ? 1 : h >= 22 ? 0.5 : h >= 13 && h < 15 ? 0.3 : 0;
      wishes = wishes.filter((w) => w.until > s.T);
      if (current?.wish && !wishes.includes(current.wish)) current = null;
    },

    /** Takes a wish from outside; a new one of the same kind replaces the old. Returns it. */
    wish(w, T) {
      const { ttl, ...rest } = w;
      const out: Wish = { strength: 0.8, ...rest, until: T + (ttl ?? 20) };
      wishes = [...wishes.filter((x) => x.kind !== w.kind), out];
      if (w.kind === 'go' || w.kind === 'near') current = null;
      return out;
    },

    /** Something she went through: thrown, dropped (put down by hand), petted, poked, talked to, or a face she wore. */
    feel(kind, T) {
      const last = [...recent].reverse().find((r) => T - r.at < 30);
      if (kind === 'thrown' || kind === 'dropped') {
        drives.unease = clamp01(drives.unease + (kind === 'thrown' ? 0.5 : 0.3));
        drives.energy = clamp01(drives.energy - 0.08);
        // moved away by hand: what she chose just before is a little less her habit
        if (last) habits[last.name] = Math.max(0.4, habit(last.name) * 0.85);
        current = null;
      } else if (kind === 'petted') {
        drives.joy = clamp01(drives.joy + 0.2);
        drives.social = clamp01(drives.social + 0.25);
        drives.unease = clamp01(drives.unease - 0.2);
        if (last) habits[last.name] = Math.min(2, habit(last.name) * 1.05);
      } else if (kind === 'poked') {
        drives.social = clamp01(drives.social + 0.08);
        drives.boredom = clamp01(drives.boredom - 0.1);
      } else if (kind === 'talked') {
        drives.social = clamp01(drives.social + 0.15);
        drives.boredom = clamp01(drives.boredom - 0.2);
      } else if (kind.startsWith('face:')) {
        const f = kind.slice(5);
        if (['happy', 'love', 'wink', 'excited', 'laugh', 'cheer'].includes(f)) drives.joy = clamp01(drives.joy + 0.12);
        if (['sleepy', 'yawn', 'doze'].includes(f)) drives.energy = clamp01(drives.energy - 0.1);
        if (['sad', 'shy', 'surprised'].includes(f)) drives.unease = clamp01(drives.unease + 0.05);
      }
    },

    /** Stable semantic preferences; contact does not roll dice or count up to anger. */
    reaction(kind, doing) {
      if (doing === 'sleep' || doing === 'doze' || drives.energy < 0.25) return ['look', 'yawn', 'wave'];
      if (drives.unease > 0.45) return ['shy', 'look', 'wave'];
      if (kind === 'pet') return ['laugh', 'happy', 'wave'];
      if (kind === 'landed') return ['stretch', 'wave', 'look'];
      return drives.joy > 0.65 ? ['jump', 'happy', 'wave'] : ['wave', 'look'];
    },

    /** What to do next, asked when the body is free; null to keep on. `free`: she may act on her own. */
    next(s) {
      // a wish the body is already carrying out is kept until it ends
      if (current && s.T < current.minUntil) return null;
      const go = wishes.find((w) => w.kind === 'go' || w.kind === 'near');
      if (go) {
        const name = go.kind as 'go' | 'near';
        current = { name, since: s.T, minUntil: s.T + 2, wish: go };
        remember('choice', name, s.T, go.why ?? 'wished');
        return { name, wish: go };
      }
      // roaming off: nothing of her own, only what she is wished
      if (!s.free || s.roam === 'off') return null;
      const stay = wishes.find((w) => w.kind === 'stay');
      const roamWish = wishes.find((w) => w.kind === 'roam');
      const away = wishes.find((w) => w.kind === 'away');
      const temper = s.roam === 'free' ? 1.3 : 1;
      const scores = (Object.entries(CHOICES) as Array<[Choice, (d: Drives) => number]>).map(([name, f]): [Choice, number] => {
        let v = f(drives) * habit(name);
        if (['stroll', 'explore', 'watch', 'retreat'].includes(name)) v *= temper;
        if (stay && ['stroll', 'explore', 'watch'].includes(name)) v *= 0.15;
        if (roamWish && (name === 'stroll' || name === 'explore')) v += roamWish.strength;
        if (away && name === 'retreat') v += away.strength;
        // a little chance, and not the same thing twice in a row unless it pulls hard
        v *= 0.8 + rnd() * 0.4;
        if (current?.name === name && name !== 'idle') v *= 0.6;
        return [name, v];
      });
      const total = scores.reduce((a, [, v]) => a + Math.max(0, v), 0);
      let r = rnd() * total;
      let pick: Choice = 'idle';
      for (const [name, v] of scores) { if ((r -= Math.max(0, v)) < 0) { pick = name; break; } }
      current = { name: pick, since: s.T, minUntil: s.T + 1 };
      remember('choice', pick, s.T, 'own');
      return { name: pick };
    },

    /** Crossing no longer consults drives, urgency or learned habits; the body configuration owns the fallback. */
    cross(_s) { return 'teleport'; },

    /** The inner state in a few plain words, for the front; changes only when a word would. Model text, so English. */
    describe() {
      return describeFeeling(drives).text;
    },

    /** A wish is done (arrived, or given up): that one, or every wish of a kind when given its name. */
    settle(w) {
      wishes = wishes.filter((x) => (typeof w === 'string' ? x.kind !== w : x !== w));
      if (current && (typeof w === 'string' ? current.name === w : current.wish === w)) current = null;
    },
  };
}
