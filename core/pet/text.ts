/**
 * What the front reads from the pet World (events, receipts), in Chinese and in English; `en: typeof zh` keeps the two
 * the same shape. Moved from the old pet package's model-text.ts, only what the new body has.
 */
export type ModelLanguage = 'zh' | 'en';

export interface SayReceipt {
  /** Seconds of earlier lines still ahead of this one. */
  waitSec: number;
  /** Seconds this one stays on screen. */
  selfSec: number;
  /** Markers left out: not words she knows. */
  dropped: string[];
}

/** How a command ended (behavior.ts `CommandEnd`), for `[moved]`. */
export interface Ended { word: string; outcome: string; at: string; adjusted?: string; crossed?: number; by?: string; user: string }

const zh = {
  dateLocale: 'zh-CN',
  touch: (text: string) => `[touch] ${text}`,
  typed: (user: string, text: string) => `[typed] ${user}:${text}`,
  answered: (user: string, question: string, text: string) => `[answer] ${user}回答「${question}」:${text}`,
  poked: (user: string, n: number) => (n > 1 ? `${user}戳了你 ${n} 下` : `${user}戳了你一下`),
  thrown: (user: string, at: string) => `${user}把你拎起来甩了出去,你落在屏幕横向 ${at} 处`,
  dropped: (user: string, at: string) => `${user}把你拎起来,放到了屏幕横向 ${at} 处`,

  layoutUnknown: '还不知道屏幕上的情况,过一会儿再看。',
  /** Where she stands, where she may go and where not (percent of the screen's width). */
  layout: (x: number | null, free: Array<[number, number]>, blocked: Array<[number, number]>) =>
    `${x === null ? '' : `你站在屏幕横向 ${x}% 处。`}能去:${free.length ? free.map(([a, b]) => `${a}–${b}%`).join('、') : '没有能去的地方'}。`
    + (blocked.length ? `不能去(有人在用的地方):${blocked.map(([a, b]) => `${a}–${b}%`).join('、')}。` : '整条都能去。'),
  commandEnded: (c: Ended) => {
    const extra = (c.adjusted ? `想去的地方是${c.user}干活的地方,停在了旁边的 ${c.adjusted}。` : '') + (c.crossed ? `路上跳过了 ${c.crossed} 处${c.user}干活的地方。` : '');
    switch (c.outcome) {
      case 'arrived': return `${c.word}到了屏幕横向 ${c.at} 处。${extra}`;
      case 'done': return `${c.word}结束了,现在在屏幕横向 ${c.at} 处。${extra}`;
      case 'wall': return `${c.word}不了:四周都是${c.user}干活的地方,像有堵空气墙,只能在 ${c.at} 处原地跑了一会儿。`;
      case 'interrupted': return c.by === 'hand' ? `${c.word}到一半被${c.user}拎走了,现在在 ${c.at} 处。` : '';
      case 'unknown': return c.by === 'disconnect' ? `${c.word}进行时身体断开了,无法确认有没有做完。` : `${c.word}的结果还不能确认。`;
      default: return '';
    }
  },

  notConnected: (tool: string, user: string) => `[${tool} 没执行] 桌宠的身体没有连上,${user}看不到。`,
  sayEmpty: '[pet_say 没执行] 脚本是空的。不想说话就不调用。',
  sayReceipt: (r: SayReceipt) => `${r.waitSec > .5 ? `已排队,前面还有约 ${Math.round(r.waitSec)} 秒` : '已开始显示'},这段约 ${Math.round(r.selfSec)} 秒。`
    + (r.dropped.length ? `\n[执行参数] 这些标记不是你会的动作,已略过:${r.dropped.join('、')}。` : ''),
  askEmpty: '[pet_ask 没执行] question 是空的。',
  askReceipt: (user: string) => `已在气泡里问出。${user}下一条身体输入会回答当前最新的问题；较早的问题仍保留待答。`,
  /** The question as the bubble shows it while there are no buttons. */
  askBubble: (question: string, options: string[]) => `${question}${options.length ? ` ${options.map((o, i) => `${i + 1}. ${o}`).join(' ')}` : ''}`,
  actNone: (dropped: string[]) => `[pet_act 没执行] 没有你会的动作${dropped.length ? `:${dropped.join('、')} 都不是` : ''}。`,
  actReceipt: (actions: string[], dropped: string[]) => `已受理动作:${actions.join(' → ')}。动作按顺序播放；结束或中断情况会另行记录。`
    + (dropped.length ? `\n[执行参数] 这些不是你会的动作,已略过:${dropped.join('、')}。` : ''),
};

const en: typeof zh = {
  dateLocale: 'en-US',
  touch: (text) => `[touch] ${text}`,
  typed: (user, text) => `[typed] ${user}: ${text}`,
  answered: (user, question, text) => `[answer] ${user} answered "${question}": ${text}`,
  poked: (user, n) => (n > 1 ? `${user} poked you ${n} times` : `${user} poked you`),
  thrown: (user, at) => `${user} picked you up and threw you; you landed at ${at} across the screen`,
  dropped: (user, at) => `${user} picked you up and put you down at ${at} across the screen`,

  layoutUnknown: 'The screen is not known yet; look again in a while.',
  layout: (x, free, blocked) =>
    `${x === null ? '' : `You stand at ${x}% across the screen. `}You may go to: ${free.length ? free.map(([a, b]) => `${a}–${b}%`).join(', ') : 'nowhere'}.`
    + (blocked.length ? ` Not to (in use): ${blocked.map(([a, b]) => `${a}–${b}%`).join(', ')}.` : ' All of it is free.'),
  commandEnded: (c) => {
    const extra = (c.adjusted ? ` Where you meant to go is where ${c.user} works; you stopped beside it at ${c.adjusted}.` : '') + (c.crossed ? ` On the way you hopped over ${c.crossed} place(s) where ${c.user} works.` : '');
    switch (c.outcome) {
      case 'arrived': return `${c.word}: got to ${c.at} across the screen.${extra}`;
      case 'done': return `${c.word} is over; you are at ${c.at} across the screen.${extra}`;
      case 'wall': return `${c.word} could not go anywhere: all around is where ${c.user} works, like an invisible wall; you ran on the spot at ${c.at} for a moment.`;
      case 'interrupted': return c.by === 'hand' ? `${c.word} was cut short: ${c.user} picked you up; you are at ${c.at}.` : '';
      case 'unknown': return c.by === 'disconnect' ? `The body disconnected during ${c.word}; it could not confirm whether the action finished.` : `The result of ${c.word} is not confirmed.`;
      default: return '';
    }
  },

  notConnected: (tool, user) => `[${tool} not done] The pet's body is not connected; ${user} cannot see it.`,
  sayEmpty: '[pet_say not done] The script is empty. Do not call it when you have nothing to say.',
  sayReceipt: (r) => `${r.waitSec > .5 ? `Queued, about ${Math.round(r.waitSec)} s ahead of it` : 'Showing now'}; this one takes about ${Math.round(r.selfSec)} s.`
    + (r.dropped.length ? `\n[parameters] Not actions you know, left out: ${r.dropped.join(', ')}.` : ''),
  askEmpty: '[pet_ask not done] The question is empty.',
  askReceipt: (user) => `Asked in the bubble. ${user}'s next body reply answers the newest waiting question; older questions remain pending.`,
  askBubble: (question, options) => `${question}${options.length ? ` ${options.map((o, i) => `${i + 1}. ${o}`).join(' ')}` : ''}`,
  actNone: (dropped) => `[pet_act not done] No action you know${dropped.length ? `: ${dropped.join(', ')} are not` : ''}.`,
  actReceipt: (actions, dropped) => `Accepted: ${actions.join(' → ')}. Actions play in order; completion or interruption is recorded separately.`
    + (dropped.length ? `\n[parameters] Not actions you know, left out: ${dropped.join(', ')}.` : ''),
};

export const PET_TEXT: Record<ModelLanguage, typeof zh> = { zh, en };
