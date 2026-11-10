/**
 * Speech scripts for the pet's bubble. Markers name expressions and motions:
 *
 * - `【a, b】` blocking: runs the words, then starts a new bubble with the text after it.
 * - `<a, b>` inline: runs the words when typing reaches that point, without a new bubble; but between two sentences
 *   (the text before it ends one, and more follows) it starts a new bubble like 【】, so a reply comes as several
 *   messages the way people text, which the model reaches for this way far more often than with 【】.
 *
 * Moved from the old pet package. The words are the figure's vocabulary (core/pet/vocab.ts), by id or
 * by any of their names; unknown words are dropped and reported back. An inline marker longer than
 * `INLINE_TAG_MAX` or spanning a line is text.
 *
 * A word may be followed by what it should be like: how long (`3m`, `30s`,
 * `3分钟`, `30秒`), how many times (`x2`, `2次`, `两下` as `2下`), or where to (`left` `right` `center` `cursor`,
 * `左边` `右边` `中间` `鼠标`, a share of the width as `0.3` or `30%`). None is needed. A count repeats the word; the
 * rest goes with it to the body as a command.
 */
import type { ModelLanguage } from './text.ts';

/** One word of a body's vocabulary. */
export interface VocabWord {
  id: string;
  kind: 'expression' | 'motion';
  /** Names the bot may write it by, by language; the id always works. */
  names: Record<string, string[]>;
  /** What it looks like on this body, by language. */
  about: Record<string, string>;
  /** Seconds the page waits after it before the next word in a row. */
  seconds: number;
  /** Held until the next word (sitting, sleeping). */
  lasting?: boolean;
  /** When the front should reach for it, in the figure's own words (from the pack's when). */
  when?: Record<string, string>;
}

const lookups = new WeakMap<readonly VocabWord[], Map<string, VocabWord>>();
function lookup(vocab: readonly VocabWord[]): Map<string, VocabWord> {
  let m = lookups.get(vocab);
  if (!m) {
    m = new Map();
    for (const v of vocab) {
      m.set(v.id, v);
      for (const n of Object.values(v.names).flat()) m.set(n, v);
    }
    lookups.set(vocab, m);
  }
  return m;
}

/** The id of a word of `vocab` (its id or one of its names), or null. */
export function vocabId(word: string, vocab: readonly VocabWord[]): string | null {
  const m = lookup(vocab);
  return m.get(word.trim().toLowerCase())?.id ?? m.get(word.trim())?.id ?? null;
}

/** Where a command goes: a share of the width (0 left, 1 right), or a named place. */
export type Place = number | 'left' | 'right' | 'center' | 'cursor';
/** A word with what it should be like: for how long, or where to. */
export interface Command { id: string; seconds?: number; to?: Place }
/** A word of the body's vocabulary as it is played: just the word, or a command. */
export type Action = string | Command;

/** The word an action plays. */
export const actionId = (a: Action): string => (typeof a === 'string' ? a : a.id);

/** An action written back for a receipt: the word, then how long and where to (`run 180s →right`). */
export function describeAction(a: Action): string {
  if (typeof a === 'string') return a;
  const to = a.to === undefined ? '' : typeof a.to === 'number' ? ` →${Math.round(a.to * 100)}%` : ` →${a.to}`;
  return `${a.id}${a.seconds !== undefined ? ` ${Math.round(a.seconds)}s` : ''}${to}`;
}

const PLACES: Record<string, Place> = {
  left: 'left', right: 'right', center: 'center', middle: 'center', cursor: 'cursor', mouse: 'cursor',
  左: 'left', 左边: 'left', 右: 'right', 右边: 'right', 中间: 'center', 中: 'center', 鼠标: 'cursor', 鼠标那: 'cursor', 鼠标那儿: 'cursor',
};

/** What a parameter token says, or null when it is not one. */
export function paramOf(token: string): { seconds: number } | { count: number } | { to: Place } | null {
  const t = token.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*(s|sec|秒|秒钟)$/.exec(t);
  if (m) return { seconds: Number(m[1]) };
  m = /^(\d+(?:\.\d+)?)\s*(m|min|分|分钟)$/.exec(t);
  if (m) return { seconds: Number(m[1]) * 60 };
  m = /^(?:x|×)(\d+)$/.exec(t) ?? /^(\d+)\s*(?:次|下|遍|x)$/.exec(t);
  if (m) return { count: Math.max(1, Math.min(10, Number(m[1]))) };
  if (t in PLACES) return { to: PLACES[t]! };
  m = /^(\d+(?:\.\d+)?)%$/.exec(t);
  if (m) return { to: Math.max(0, Math.min(1, Number(m[1]) / 100)) };
  m = /^(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(t);
  if (m) return { to: Number(m[1]) };
  return null;
}

/** At most this long for one command: a guard against a slip of the pen, not a limit on how long she may keep at it. */
export const COMMAND_MAX_SECONDS = 60 * 60;

export interface Anchor {
  /** Character offset in the beat's text. */
  at: number;
  actions: Action[];
}

export interface Beat {
  actions: Action[];
  text: string;
  anchors: Anchor[];
}

export interface ParsedScript {
  beats: Beat[];
  dropped: string[];
}

export const INLINE_TAG_MAX = 32;

/**
 * The actions of a marker's inside: words, each with the parameters that follow it. A count repeats the word; a
 * duration or a place makes it a command. A parameter with no word before it is dropped.
 */
/** Words that only join a motion to its place (`walk to 30%`, `跑 到 鼠标`), read past. */
const CONNECTOR = /^(to|towards|到|去|往|向)$/i;

/** A motion said with where it goes on it (`走到`, `跑去`): the word without 到 / 去, or that doubled (走 → 走走). */
function goingWord(w: string, vocab: readonly VocabWord[]): string | null {
  const m = /^(.+?)(到|去)$/.exec(w);
  return m ? vocabId(m[1]!, vocab) ?? vocabId(m[1]!.repeat(2), vocab) : null;
}

function words(inner: string, dropped: string[], vocab: readonly VocabWord[]): Action[] {
  const out: Array<{ id: string; seconds?: number; to?: Place; count: number }> = [];
  for (const w of inner.split(/[,，、\s]+/)) {
    if (!w || CONNECTOR.test(w)) continue;
    const id = vocabId(w, vocab) ?? goingWord(w, vocab);
    if (id) { out.push({ id, count: 1 }); continue; }
    const p = paramOf(w), last = out.at(-1);
    if (p && last) {
      if ('seconds' in p) last.seconds = Math.min(COMMAND_MAX_SECONDS, p.seconds);
      else if ('count' in p) last.count = p.count;
      else last.to = p.to;
    } else dropped.push(w);
  }
  return out.flatMap(({ id, seconds, to, count }) => {
    const one: Action = seconds === undefined && to === undefined ? id : { id, ...(seconds !== undefined ? { seconds } : {}), ...(to !== undefined ? { to } : {}) };
    return Array.from({ length: count }, () => one);
  });
}

/** Text that ends a sentence: an inline marker after it, with more to say, starts a new bubble. */
const SENTENCE_END = /([。！？!?~～]|\.\.\.|…|\.)$/;

export function parseScript(script: string, vocab: readonly VocabWord[]): ParsedScript {
  const dropped: string[] = [];
  const beats: Beat[] = [];
  let cur: Beat = { actions: [], text: '', anchors: [] };
  let i = 0;
  while (i < script.length) {
    const ch = script[i];
    if (ch === '【') {
      const end = script.indexOf('】', i + 1);
      if (end < 0) { cur.text += script.slice(i); break; }
      const acts = words(script.slice(i + 1, end), dropped, vocab);
      if (cur.text.trim() || cur.actions.length || cur.anchors.length) beats.push(cur);
      cur = { actions: acts, text: '', anchors: [] };
      i = end + 1;
      continue;
    }
    if (ch === '<' || ch === '＜') {
      const close = ch === '<' ? '>' : '＞';
      const end = script.indexOf(close, i + 1);
      const inner = end < 0 ? '' : script.slice(i + 1, end);
      if (end < 0 || inner.length > INLINE_TAG_MAX || /\n/.test(inner)) { cur.text += ch; i++; continue; }
      const acts = words(inner, dropped, vocab);
      const more = script.slice(end + 1).replace(/[【<＜][^】>＞]*[】>＞]/g, '').trim().length > 0;
      if (acts.length && more && SENTENCE_END.test(cur.text.trimEnd())) {
        beats.push(cur);
        cur = { actions: acts, text: '', anchors: [] };
      } else if (acts.length) cur.anchors.push({ at: cur.text.length, actions: acts });
      i = end + 1;
      continue;
    }
    cur.text += ch;
    i++;
  }
  if (cur.text.trim() || cur.actions.length || cur.anchors.length) beats.push(cur);
  for (const b of beats) {
    const lead = b.text.length - b.text.trimStart().length;
    b.text = b.text.trim();
    for (const a of b.anchors) a.at = Math.max(0, Math.min(b.text.length, a.at - lead));
  }
  return { beats, dropped };
}

/**
 * Seconds a script stays on screen: typing at ~20 × `speed` chars/s, plus reading time per bubble divided by `speed`
 * (`window.bubbleSpeed`). `steps` gives each character's typing steps (1/20 s) when they are not one each (the pet's
 * speech, src/speech).
 */
export function estimateSeconds(beats: readonly Beat[], speed: number, steps?: (ch: string) => number): number {
  let s = 0;
  for (const b of beats) {
    if (b.actions.length) s += .5;
    const typed = steps ? [...b.text].reduce((n, ch) => n + steps(ch), 0) : b.text.length;
    if (b.text) s += (typed / 20 + 1.6 + b.text.length * .07) / speed;
  }
  return Math.round(s * 10) / 10;
}

/** Validates an action list for `pet_act`, splitting known words (with what follows them, as in a marker) from unknown ones. */
export function parseActions(list: readonly unknown[], vocab: readonly VocabWord[]): { actions: Action[]; dropped: string[] } {
  const actions: Action[] = [];
  const dropped: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') { dropped.push(String(raw)); continue; }
    actions.push(...words(raw, dropped, vocab));
  }
  return { actions, dropped };
}

const pickIn = <T>(by: Record<string, T>, language: string): T | undefined => by[language] ?? by.zh ?? Object.values(by)[0];

/**
 * The vocabulary as the bot reads it, by model-text language. A row gives what a word is called and
 * what it looks like. The Chinese table lists every word's Chinese names; the English one only the
 * English names a pack gives, so the bot writes ids or English words in English bubbles. A look
 * without English text is given in the pack's own language.
 */
const VOCAB_TEXT = {
  zh: {
    row: (v: VocabWord) => `| ${v.id} | ${(pickIn(v.names, 'zh') ?? []).join(' / ')} | ${pickIn(v.about, 'zh') ?? ''}${v.lasting ? ',保持到下一个动作' : ''} | ${pickIn(v.when ?? {}, 'zh') ?? ''} |`,
    head: '| 词 | 中文 | 样子 | 什么时候用 |\n|---|---|---|---|\n',
    expressions: '表情(持续几秒后回到平常的脸):',
    motions: '动作:',
    changed: '词表变了。',
    gone: (words: readonly VocabWord[]) => `这些词用不了了:${words.map((v) => `${v.id}(${pickIn(v.names, 'zh')?.[0] ?? v.id})`).join('、')}。`,
    fresh: '新增或样子变了的:',
    kinds: { expression: '表情', motion: '动作' } as Record<VocabWord['kind'], string>,
  },
  en: {
    row: (v: VocabWord) => `| ${[v.id, ...v.names.en ?? []].join(' / ')} | ${pickIn(v.about, 'en') ?? ''}${v.lasting ? '; held until the next action' : ''} | ${pickIn(v.when ?? {}, 'en') ?? ''} |`,
    head: '| word | looks like | when to reach for it |\n|---|---|---|\n',
    expressions: 'Expressions (they last a few seconds, then the face goes back to normal):',
    motions: 'Motions:',
    changed: 'The vocabulary changed.',
    gone: (words: readonly VocabWord[]) => ` These words no longer work: ${words.map((v) => v.id).join(', ')}.`,
    fresh: ' New or changed:',
    kinds: { expression: 'Expressions', motion: 'Motions' } as Record<VocabWord['kind'], string>,
  },
} satisfies Record<ModelLanguage, unknown>;

/** The vocabulary as the bot's prompt shows it: expressions, then motions. */
export function vocabTable(vocab: readonly VocabWord[], language: ModelLanguage = 'zh'): string {
  const t = VOCAB_TEXT[language];
  const rows = (kind: VocabWord['kind']) => vocab.filter((v) => v.kind === kind).map(t.row).join('\n');
  return `${t.expressions}\n\n${t.head}${rows('expression')}\n\n`
    + `${t.motions}\n\n${t.head}${rows('motion')}`;
}

/**
 * How the vocabulary went from `before` to `after`, for the bot: the words gone, then the rows of the words
 * new or told differently (kind, names, look). Empty when the bot would see the same table.
 */
export function vocabChange(before: readonly VocabWord[], after: readonly VocabWord[], language: ModelLanguage = 'zh'): string {
  const t = VOCAB_TEXT[language];
  const told = new Map(before.map((v) => [v.id, `${v.kind}${t.row(v)}`]));
  const gone = before.filter((v) => !after.some((w) => w.id === v.id));
  const fresh = after.filter((v) => told.get(v.id) !== `${v.kind}${t.row(v)}`);
  if (!gone.length && !fresh.length) return '';
  const lines = [t.changed];
  if (gone.length) lines[0] += t.gone(gone);
  if (fresh.length) {
    lines[0] += t.fresh;
    for (const kind of ['expression', 'motion'] as const) {
      const rows = fresh.filter((v) => v.kind === kind);
      if (rows.length) lines.push(`${t.kinds[kind]}:\n\n${t.head}${rows.map(t.row).join('\n')}`);
    }
  }
  return lines.join('\n\n');
}
