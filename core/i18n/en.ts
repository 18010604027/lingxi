/**
 * English: the text of the Core process that people read, which is now only this app's own settings: the language,
 * the context ring and the request caps. The keys are zh.ts's.
 */
import type { CoreText } from './index.ts';

const en: CoreText = {
  /** This app's own settings. */
  settings: {
    language: { title: 'Language', description: 'The text she reads and the language she talks in. Takes effect at once.' },
    contextRing: { title: 'Context ring', description: "Shows a ring in the Chat page's input box with how far the conversation is from being tidied up." },
    roundsSoft: { title: 'Wrap-up reminder', suffix: 'requests', description: 'After this many model requests in one wake-up, she is reminded to finish the current task and end the turn.' },
    roundsHard: { title: 'Requests per wake-up', suffix: 'requests', description: 'The most model requests in one wake-up; the turn ends when it is reached.' },
  },
};

export default en;
