/**
 * The pet's own rhythm: now and then, inside its waking hours, it looks up on its own. When is the wake table's business
 * (daily/reminders.ts, the `rhythm` entry, which the control center can tune); this is what one look does. If nobody is at the screen
 * (locked, or no input for a while) it lets the moment pass; otherwise it glances at the screen the person is working
 * on, has the model put what it sees in a sentence or two, and wakes the front with that, the day's topics so far and
 * how often it has already spoken on its own today. Whether to say anything is the front's call, from what it knows of
 * the person. The picture goes to the model and is kept nowhere; the sentence is kept in the event log.
 */

/**
 * The rhythm entry's first settings, from the person's wishes (2026-10-26): awake 09:00–23:30, a look every 40–70
 * minutes, one in five let pass as a person sometimes does not look up, and about 8 times a day of speaking on its own
 * (a guide the front is told, not a lock). The control center tunes them from there.
 */
export const RHYTHM_DEFAULTS = {
  schedule: { jitter: { minMinutes: 40, maxMinutes: 70 }, from: '09:00', to: '23:30' },
  params: { skipChance: 0.2, dailySpeaking: 8 },
};

export type GlanceResult =
  | { jpeg: Uint8Array; foreground: string | null; foregroundApp: string | null; windows: Array<{ title: string; foreground: boolean }> }
  | { away: 'locked' | 'idle'; idleMs: number };

export interface RhythmHooks {
  glance: () => Promise<GlanceResult>;
  /** What the picture shows, in a sentence or two; throws when the model cannot see it. */
  see: (jpeg: Uint8Array, context: string) => Promise<string>;
  /** Keeps the glance's sentence in the event log, without waking anyone. */
  note: (text: string) => void;
  /** Wakes the front with the moment. */
  wake: (text: string) => void;
  /** Titles of the topics talked about today, oldest first. */
  topicsToday: () => string[];
  /** Times the pet has spoken on its own today. */
  spokenToday: () => number;
  /** Counts what happened to each look: woke, skipped, away-locked, away-idle, glance-failed. */
  count?: (outcome: string) => void;
  now?: () => Date;
  random?: () => number;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export const SEE_PROMPT = [
  'You look at a screenshot of the screen a person is working on, for the desktop pet that keeps them company.',
  'Say in one or two sentences, in Chinese, what they seem to be doing: which kind of program, which kind of activity',
  '(写代码, 看论文, 刷视频, 聊天, 打游戏…), and its subject when it is plain at a glance.',
  'Do not copy text off the screen, do not name other people or accounts, and do not judge (no 摸鱼, no 应该).',
  'If the picture is mostly empty or dark, say so.',
].join('\n');

/** SEE_PROMPT for the control center's glance, which also needs where on the screen they work, to keep the pet out of it. */
export const WHERE_PROMPT = [
  SEE_PROMPT,
  'Then, on a new line starting with 「工作区:」, say where along the bottom quarter of the screen they type or work (an input',
  'box, the editor, a terminal, a chat box), as stretches of the width in percent from the left edge, like 「工作区: 30–75%（输入框）」;',
  'several stretches separated by commas; 「工作区: 无」 when nothing there is worked in.',
].join('\n');

export class Rhythm {
  private readonly hooks: RhythmHooks;

  constructor(hooks: RhythmHooks) {
    this.hooks = hooks;
  }

  /** One look, with the rhythm entry's settings: let pass, find nobody there, or glance and wake the front. */
  async beat(params: { skipChance: number; dailySpeaking: number } = RHYTHM_DEFAULTS.params): Promise<'skipped' | 'away-locked' | 'away-idle' | 'woke'> {
    const now = (this.hooks.now ?? (() => new Date()))();
    if ((this.hooks.random ?? Math.random)() < params.skipChance) return this.counted('skipped');
    let g: GlanceResult | null = null;
    try { g = await this.hooks.glance(); } catch { this.hooks.count?.('glance-failed'); }
    if (g && 'away' in g) return this.counted(g.away === 'locked' ? 'away-locked' : 'away-idle');
    let seen: string | null = null;
    if (g) {
      const fg = g.foreground ? `前台窗口：${g.foreground}${g.foregroundApp ? `（${g.foregroundApp}）` : ''}` : '';
      try { seen = (await this.hooks.see(g.jpeg, fg)).trim() || null; } catch { this.hooks.count?.('see-failed'); }
      if (seen) this.hooks.note(`[glance ${hhmm(now)}] ${seen}`);
    }
    const windows = g && !('away' in g) ? g.windows.slice(0, 8).map((w) => `${w.foreground ? '* ' : '- '}${w.title.slice(0, 80)}`).join('\n') : '';
    const topics = this.hooks.topicsToday();
    const spoken = this.hooks.spokenToday();
    this.hooks.wake([
      `[your own moment ${hhmm(now)}] Nobody asked you anything; you looked up on your own.`,
      seen ? `On their screen: ${seen}` : 'You could not see their screen this time.',
      windows ? `Windows open (* is in front):\n${windows}` : '',
      topics.length ? `Talked about today: ${topics.join('; ')}.` : 'Nothing talked about yet today.',
      `You have spoken on your own ${spoken} time${spoken === 1 ? '' : 's'} today; keep it to about ${params.dailySpeaking} a day.`,
      'Decide from what you know of them whether to say anything now. Staying quiet is fine and often right: when they are '
        + 'deep in work, when you spoke on your own a little while ago, or when they asked for quiet. If you speak, keep it light '
        + 'and short, never judge what they are doing, and never read their screen back to them.',
    ].filter(Boolean).join('\n'));
    return this.counted('woke');
  }

  private counted<T extends string>(outcome: T): T {
    this.hooks.count?.(outcome);
    return outcome;
  }
}
