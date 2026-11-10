/** Framework execution for one control task. The caller owns dispatch and durable task state. */
import { createAgent, createMiddleware } from 'langchain';
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Logger, ToolDef } from '../contracts.ts';
import { messageText, modelUsage, type ModelUsage } from './front-agent.ts';
import { adaptTool, SerialToolGate } from './tools.ts';

export interface ControlRunInput {
  model: BaseChatModel;
  system: string;
  task: string;
  /** Case evidence, in the same order described in the task body. */
  images?: readonly Uint8Array[];
  tools: ToolDef[];
  log: Logger;
  signal: AbortSignal;
  sessionId: string;
  onUsage?: (usage: ModelUsage) => void;
  onToolStarted?: () => void;
  prepareMessages?(messages: BaseMessage[]): BaseMessage[];
}

export interface ControlRunOutput {
  text: string;
  toolErrors: Array<{ name: string; callId: string; detail: string }>;
}

export async function runControl(input: ControlRunInput): Promise<ControlRunOutput> {
  input.signal.throwIfAborted();
  const gate = new SerialToolGate();
  const tools = input.tools.map((tool) => adaptTool(tool, { role: 'control', log: input.log }, {
    gate, onStart: () => input.onToolStarted?.(),
  }));
  const middleware = createMiddleware({ name: 'LingxiControlMessages', wrapModelCall: (request, handler) =>
    handler({ ...request, messages: input.prepareMessages?.(request.messages) ?? request.messages }) });
  const agent = createAgent({ model: input.model, tools, middleware: [middleware], version: 'v1' });
  let result;
  try {
    const content = input.images?.length
      ? [{ type: 'text' as const, text: input.task }, ...input.images.map((jpeg) => ({
        type: 'image_url' as const, image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`, detail: 'high' as const },
      }))]
      : input.task;
    result = await agent.invoke({ messages: [new SystemMessage(input.system), new HumanMessage({ content })] },
      { signal: input.signal, recursionLimit: Infinity });
  } finally {
    await gate.drain();
  }
  input.signal.throwIfAborted();
  const last = result.messages.at(-1);
  if (!last || last.getType() !== 'ai' || !messageText(last).trim()) {
    throw new Error('Control run ended without a final text response');
  }
  const refused = last.additional_kwargs.refusal;
  if (refused) throw new Error(`Control model refused the task: ${messageText(last)}`);
  for (const message of result.messages) {
    if (message.getType() !== 'ai') continue;
    const usage = modelUsage(message as import('@langchain/core/messages').AIMessage);
    if (usage) {
      try { input.onUsage?.(usage); }
      catch (error) { input.log.warn('Control model usage projection failed', { error }); }
    }
  }
  const toolErrors = result.messages.filter((m): m is ToolMessage => ToolMessage.isInstance(m) && m.status === 'error')
    .map((m) => ({ name: m.name ?? '', callId: m.tool_call_id, detail: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
  return { text: messageText(last), toolErrors };
}
