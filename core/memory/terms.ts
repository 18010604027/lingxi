/**
 * Search terms for Chinese and mixed text, for an FTS5 `unicode61` column: the words `Intl.Segmenter('zh')` finds
 * (ICU's dictionary), plus every pair of adjacent Han characters, which catches the new words and names the
 * dictionary splits (猫咖, 阿珍). FTS5's own trigram tokenizer finds nothing for two-character words, and `unicode61`
 * alone takes a whole Chinese sentence as one token; both were checked on this machine.
 */
const HAN = /\p{Script=Han}/u;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** The distinct terms of `text`, lowercased, in first-seen order. */
export function terms(text: string): string[] {
  const out = new Set<string>();
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue;
    const word = s.segment.toLowerCase();
    out.add(word);
  }
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i++) {
    if (HAN.test(chars[i]!) && HAN.test(chars[i + 1]!)) out.add(chars[i]! + chars[i + 1]!);
  }
  return [...out];
}

/** The terms as the indexed column holds them. */
export const indexText = (text: string): string => terms(text).join(' ');

/** An FTS5 query that matches any of the terms (AND misses texts where one generated pair never occurs); null when there are none. */
export function matchQuery(text: string): string | null {
  const t = terms(text);
  return t.length ? t.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ') : null;
}

/** Everyday words that say little about what a line is about, left out when judging how much of a query a text covers. */
const COMMON = new Set(['记得', '还记得', '记不记得', '上次', '之前', '以前', '那天', '那次', '当时', '忘了', '今天', '明天', '昨天', '现在', '刚才', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '什么', '怎么', '为什么',
  '一下', '一个', '没有', '不是', '就是', '还是', '可以', '好的', '然后', '因为', '所以', '但是', '如果', '已经', '还有', '一点', '有点', '真的', '觉得']);

/**
 * The content words of `text` (two characters or more, everyday words and words about remembering left out), for judging
 * how much of it a text covers. Single Han characters in a row are joined: the dictionary splits names and new words
 * (团子, 猫咖) that way.
 */
export function words(text: string): string[] {
  const out = new Set<string>();
  let run = '';
  const flush = () => { if ([...run].length >= 2 && !COMMON.has(run)) out.add(run); run = ''; };
  for (const s of segmenter.segment(text)) {
    const w = s.segment.toLowerCase();
    if (s.isWordLike && [...w].length === 1 && HAN.test(w) && !SINGLE.has(w)) { run += w; continue; }
    flush();
    if (s.isWordLike && [...w].length >= 2 && !COMMON.has(w)) out.add(w);
  }
  flush();
  return [...out];
}

/** Single characters that are grammar, not part of a name: they end a run of single characters. */
const SINGLE = new Set([...'的了吗呢吧啊呀哦嗯是在有和与跟也都就还又很太我你他她它们这那个一不没把被给对向从到说要会能去来']);

/** The share of `query`'s content words that occur in `text`, 0 when the query has none. */
export function coverage(query: string, text: string): number {
  const w = words(query), t = text.toLowerCase();
  return w.length ? w.filter((x) => t.includes(x)).length / w.length : 0;
}
