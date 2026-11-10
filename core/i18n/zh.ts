/**
 * 简体中文:Core 进程里给人看的文字,目前只有这个应用自己的设置项:语言、上下文圆环、每轮请求上限。
 * 键与 en.ts 相同;繁体中文缺的顶层键读这里。
 */
export default {
  /** 设置里这个应用自己的几项 */
  settings: {
    language: { title: '语言', description: '她读到的文字和说话的语言都用这一种，修改后立即生效。' },
    contextRing: { title: '上下文圆环', description: '在对话页输入框显示一个圆环，表示离整理之前的对话还有多远。' },
    roundsSoft: { title: '收尾提醒', suffix: '次', description: '单次唤醒请求模型达到此次数时，提醒她完成当前任务后结束本轮。' },
    roundsHard: { title: '单次唤醒上限', suffix: '次', description: '单次唤醒最多请求模型的次数，达到后结束本轮。' },
  },
};
