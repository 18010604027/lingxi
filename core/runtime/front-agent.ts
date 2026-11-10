/** The application's conversation entry; LangChain owns the model/tool loop. */
import { createAgent, createMiddleware } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { Logger, ToolDef } from '../contracts.ts';
import { adaptTool, SerialToolGate } from './tools.ts';
import { SqliteCheckpointSaver } from './sqlite-checkpoint-saver.ts';

export interface FrontContext {
  system: string;
  head: string;
  tail: string;
  /** Application event rows not yet confirmed as consumed. */
  events?: ReadonlyArray<{ cursor: number; text: string; ephemeral?: boolean }>;
}
export interface ModelUsage { inputTokens: number; outputTokens: number; totalTokens: number; cachedInputTokens: number }
export interface ConversationEntry {
  role: string;
  text: string;
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
}
export interface FrontAgentOptions {
  model: BaseChatModel;
  tools: ToolDef[];
  log: Logger;
  checkpointPath: string;
  readContext(input: { sessionId: string; consumedCursors: readonly number[] }): FrontContext | Promise<FrontContext>;
  onState?(state: 'processing' | 'idle' | 'failed', detail?: string): void;
  onUsage?(usage: ModelUsage, sessionId: string): void;
  prepareMessages?(messages: BaseMessage[]): BaseMessage[];
}
export type FrontAgent = ReturnType<typeof createFrontAgent>;

export function messageText(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('');
}

export function modelUsage(message: AIMessage): ModelUsage | undefined {
  const usage = message.usage_metadata;
  if (!usage) return undefined;
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    cachedInputTokens: usage.input_token_details?.cache_read ?? 0 };
}

/** Only one front invocation is accepted at a time; the application owns pending input events. */
export function createFrontAgent(options: FrontAgentOptions) {
  const saver = new SqliteCheckpointSaver(options.checkpointPath);
  const gate = new SerialToolGate();
  let running = false;
  let closed = false;
  let sessionId = '';
  let current: FrontContext;
  const consumed = new Set<number>();
  const notify = (state: 'processing' | 'idle' | 'failed', detail?: string) => {
    try { options.onState?.(state, detail); }
    catch (error) { options.log.warn('Front status projection failed', { error }); }
  };
  const defs = options.tools.some((tool) => tool.name === 'end_turn') ? options.tools : [...options.tools, {
    name: 'end_turn', description: 'Finish this turn when there is nothing further to say or do.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, tags: ['flow'] as const,
    endsTurn: true, handler: async () => 'Turn finished.',
  }];
  const tools = defs.map((def) => adaptTool(def, { role: 'front', log: options.log }, { gate }));
  const context = createMiddleware({
    name: 'LingxiConversationContext',
    beforeModel: async () => {
      notify('processing');
      const snapshot = await options.readContext({ sessionId, consumedCursors: [...consumed] });
      current = { ...snapshot, events: snapshot.events?.filter((event) => !consumed.has(event.cursor)) };
      // User/background input persists as messages. Configuration notices are request-scoped context and must not
      // become repeated conversation history on every later turn.
      const ephemeral = (current.events ?? []).filter((event) => event.ephemeral).map((event) => event.text).join('\n');
      if (ephemeral) current.tail = [current.tail, ephemeral].filter(Boolean).join('\n');
      return { messages: (current.events ?? []).filter((event) => !event.ephemeral).map((event) => new HumanMessage({
        id: `lingxi-event-${sessionId}-${event.cursor}`, content: event.text,
      })) };
    },
    wrapModelCall: async (request, handler) => {
      const messages = [...(current.head ? [new HumanMessage(current.head)] : []), ...request.messages,
        ...(current.tail ? [new HumanMessage(current.tail)] : [])];
      const response = await handler({ ...request, systemPrompt: current.system,
        messages: options.prepareMessages?.(messages) ?? messages });
      for (const event of current.events ?? []) consumed.add(event.cursor);
      const usage = modelUsage(response);
      if (usage) {
        try { options.onUsage?.(usage, sessionId); }
        catch (error) { options.log.warn('Model usage projection failed', { error }); }
      }
      return response;
    },
  });
  // Keep each assistant tool batch in declared order, including a final returnDirect tool.
  let model = options.model;
  const buildAgent = () => createAgent({ model, tools, middleware: [context], checkpointer: saver, version: 'v1' });
  let agent = buildAgent();
  let pendingModel: BaseChatModel | undefined;
  return {
    setModel(next: BaseChatModel): void {
      if (closed) throw new Error('Front agent is closed');
      if (running) pendingModel = next;
      else { model = next; agent = buildAgent(); }
    },
    async turn(input: { sessionId: string; text?: string; signal?: AbortSignal }): Promise<{ text: string; consumedCursors: number[] }> {
      if (closed) throw new Error('Front agent is closed');
      if (running) throw new Error('Front turn already running; pending input belongs to the application event source');
      input.signal?.throwIfAborted();
      running = true;
      sessionId = input.sessionId;
      consumed.clear();
      try {
        const result = await agent.invoke({ messages: input.text ? [new HumanMessage(input.text)] : [] }, {
          configurable: { thread_id: input.sessionId }, signal: input.signal, recursionLimit: Infinity,
        });
        const last = result.messages.at(-1);
        notify('idle');
        return { text: last && AIMessage.isInstance(last) ? messageText(last) : '', consumedCursors: [...consumed] };
      } catch (error) {
        notify('failed', error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        await gate.drain(); running = false;
        if (pendingModel) { model = pendingModel; pendingModel = undefined; agent = buildAgent(); }
      }
    },
    async history(sessionId: string): Promise<ConversationEntry[]> {
      const tuple = await saver.getTuple({ configurable: { thread_id: sessionId } });
      return ((tuple?.checkpoint.channel_values.messages ?? []) as BaseMessage[]).map((message) => ({
        role: message.getType(), text: messageText(message),
        ...(AIMessage.isInstance(message) && message.tool_calls?.length ? { toolCalls: message.tool_calls } : {}),
      }));
    },
    async close(): Promise<void> {
      if (running) throw new Error('Finish or cancel the active front turn before closing');
      if (closed) return;
      closed = true;
      await gate.drain();
      saver.close();
    },
  };
}
