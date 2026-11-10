/** Single framework model calls for memory work; no tools and no nested legacy fork. */
import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Logger } from '../contracts.ts';
import { messageText, modelUsage, type ModelUsage } from './front-agent.ts';

export interface MemoryRunInput {
  /** Created by the application with thinking disabled for memory work. */
  model: BaseChatModel;
  system: string;
  text: string;
  image?: Uint8Array;
  sessionId: string;
  signal?: AbortSignal;
  onUsage?: (usage: ModelUsage) => void;
  log?: Logger;
  prepareMessages?(messages: BaseMessage[]): BaseMessage[];
}

export async function runMemory(input: MemoryRunInput): Promise<string> {
  input.signal?.throwIfAborted();
  const content = input.image
    ? [{ type: 'text' as const, text: input.text || '(no window title)' }, { type: 'image_url' as const, image_url: `data:image/jpeg;base64,${Buffer.from(input.image).toString('base64')}` }]
    : input.text;
  const messages = [new SystemMessage(input.system), new HumanMessage({ content })];
  const result = await input.model.invoke(input.prepareMessages?.(messages) ?? messages, { signal: input.signal,
    metadata: { role: 'memory', sessionId: input.sessionId } });
  input.signal?.throwIfAborted();
  const text = messageText(result);
  if (!text.trim()) throw new Error('Memory model returned no text');
  const usage = modelUsage(result);
  if (usage) {
    try { input.onUsage?.(usage); }
    catch (error) { input.log?.warn('Memory model usage projection failed', { error }); }
  }
  return text;
}
