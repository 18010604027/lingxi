/** A deterministic LangChain model for ordinary application integration tests. */
import { BaseChatModel, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';

export class ScriptedModel extends BaseChatModel {
  readonly requests: BaseMessage[][] = [];
  readonly declarations: BindToolsInput[][] = [];
  private index = 0;
  constructor(private readonly responses: Array<AIMessage | ((messages: BaseMessage[]) => AIMessage | Promise<AIMessage>)>) { super({}); }
  _llmType(): string { return 'lingxi-scripted-test'; }
  bindTools(tools: BindToolsInput[]) { this.declarations.push(tools); return this; }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.requests.push(messages);
    const step = this.responses[this.index++];
    if (!step) throw new Error('Scripted model exhausted');
    const message = typeof step === 'function' ? await step(messages) : step;
    return { generations: [{ text: typeof message.content === 'string' ? message.content : '', message }] };
  }
}
