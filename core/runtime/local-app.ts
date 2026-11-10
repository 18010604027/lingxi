/** Thin Lingxi application wiring around the standard LangChain agent. */
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { EventEnvelope, FrontInputEvent, Logger, ToolDef } from '../contracts.ts';
import { AppEvents } from './app-events.ts';
import { createFrontAgent, type FrontContext, type FrontAgentOptions } from './front-agent.ts';

export interface LocalFrontOptions {
  model: BaseChatModel;
  tools: ToolDef[];
  log: Logger;
  eventFile: string;
  checkpointPath: string;
  sessionId: string;
  context(input: { events: EventEnvelope[] }): Omit<FrontContext, 'events'> | Promise<Omit<FrontContext, 'events'>>;
  onState?: FrontAgentOptions['onState'];
  onUsage?: FrontAgentOptions['onUsage'];
  prepareMessages?: FrontAgentOptions['prepareMessages'];
  /** The application decides whether this event wakes a paused or quiet front. */
  onWake?(event: FrontInputEvent): void;
}

export function eventContextText(event: EventEnvelope): string {
  const keys = ['interactionId', 'actionId', 'requestId', 'questionId', 'taskId', 'outputId', 'replyId',
    'runId', 'state', 'kind', 'action', 'x', 'y', 'from', 'at'];
  const facts = Object.fromEntries(keys.flatMap((key) => {
    const value = event.meta?.[key];
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? [[key, value]] : [];
  }));
  return `[${event.ts}] [${event.type}]${Object.keys(facts).length ? ` ${JSON.stringify(facts)}` : ''}${event.text ? `\n${event.text}` : ''}`;
}

/** Owns only the application's pending event store; model/tool execution stays in front-agent. */
export function createLocalFront(options: LocalFrontOptions) {
  const events = new AppEvents(options.eventFile);
  events.setOnWake((event) => options.onWake?.(event));
  const agent = createFrontAgent({
    model: options.model, tools: options.tools, log: options.log, checkpointPath: options.checkpointPath,
    readContext: async ({ consumedCursors }) => {
      const pending = events.pending().filter((event) => event.contextDelivery !== 'archive-only' && !consumedCursors.includes(event.cursor));
      const base = await options.context({ events: pending });
      return { ...base, events: pending.map((event) => ({ cursor: event.cursor, text: eventContextText(event),
        ...(event.type === 'app.config.changed' && event.origin === 'internal' ? { ephemeral: true } : {}) })) };
    }, onState: options.onState, onUsage: options.onUsage, prepareMessages: options.prepareMessages,
  });
  let active: Promise<string> | undefined;
  let closed = false;
  const hasInput = () => events.pending().some((event) => event.contextDelivery !== 'archive-only');
  const drain = (signal?: AbortSignal): Promise<string> => {
    if (closed) return Promise.reject(new Error('Front input is closed'));
    if (active) return active;
    // This drains application input between standard agent invocations; it is not a model/tool loop.
    active = Promise.resolve().then(async () => {
      let text = '';
      try {
        while (hasInput()) {
          const result = await agent.turn({ sessionId: options.sessionId, signal });
          events.confirm(result.consumedCursors);
          text = result.text;
        }
        return text;
      } finally { active = undefined; }
    });
    return active;
  };
  return {
    events,
    source: { enqueue: (event: Parameters<AppEvents['enqueue']>[0]) => events.enqueue(event), log: options.log },
    drain,
    turn: drain,
    setModel: agent.setModel,
    history: () => agent.history(options.sessionId),
    waitForIdle: async () => { await active; },
    close: async () => {
      closed = true;
      try { await active; } finally { await agent.close(); events.close(); }
    },
  };
}
