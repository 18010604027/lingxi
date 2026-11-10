import { HumanMessage, isAIMessage, isHumanMessage, isToolMessage, mapStoredMessageToChatMessage, type BaseMessage } from '@langchain/core/messages';
import { acceptsImages, protocolOf, type ProviderEntry } from './config.ts';
import { vendorOf } from './vendors.ts';

type Block = Record<string, unknown>;
const IMAGE_TYPES = new Set(['image', 'image_url', 'input_image']);
const REASONING_TYPES = new Set(['reasoning', 'reasoning_text', 'reasoning_content', 'thinking']);
const isImage = (part: unknown): boolean => !!part && typeof part === 'object' && IMAGE_TYPES.has(String((part as Block).type));
const isReasoning = (part: unknown): boolean => !!part && typeof part === 'object' && REASONING_TYPES.has(String((part as Block).type));

function withFields(message: BaseMessage, fields: Record<string, unknown>): BaseMessage {
  const stored = message.toDict();
  return mapStoredMessageToChatMessage({ ...stored, data: { ...stored.data, ...fields } });
}

/** Pure per-request policy. The stored conversation and adapter transport are left untouched. */
export function prepareMessages(messages: BaseMessage[], entry: ProviderEntry, options: { keepThinking?: boolean } = {}): BaseMessage[] {
  let latestUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isHumanMessage(messages[index])) { latestUser = index; break; }
  }
  const images = acceptsImages(entry);
  const responses = protocolOf(entry) === 'responses';
  const synthetic = vendorOf(entry.baseUrl)?.syntheticReasoning === true;
  const thinking = entry.spec.thinking !== false;
  const prepared = messages.map((message, index) => {
    let content = message.content;
    const additional = { ...message.additional_kwargs };
    if (Array.isArray(content) && (!images || index < latestUser)) content = content.filter((part) => !isImage(part));
    const dropReasoning = !thinking || (options.keepThinking === false && index < latestUser);
    if (dropReasoning) {
      delete additional.reasoning;
      delete additional.reasoning_content;
      if (Array.isArray(content)) content = content.filter((part) => !isReasoning(part));
    }
    if (responses && thinking && isAIMessage(message)) {
      const reasoning = additional.reasoning as Block | undefined;
      const plain = typeof additional.reasoning_content === 'string' ? additional.reasoning_content : '';
      if (!reasoning && plain) additional.reasoning = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: plain }] };
      else if (!reasoning && synthetic && index >= latestUser && message.tool_calls?.length) {
        additional.reasoning = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: '-' }] };
      }
    }
    return withFields(message, { content, additional_kwargs: additional });
  });
  if (responses) return prepared;

  // Chat accepts images in user messages. Keep each tool result before its image-only user message.
  const out: BaseMessage[] = [];
  let resultImages: unknown[] = [];
  const flush = () => {
    if (resultImages.length) out.push(new HumanMessage({ content: resultImages as HumanMessage['content'] }));
    resultImages = [];
  };
  for (const message of prepared) {
    if (!isToolMessage(message)) flush();
    if (isToolMessage(message) && Array.isArray(message.content) && message.content.some(isImage)) {
      resultImages.push(...message.content.filter(isImage));
      const text = message.content.filter((part) => !isImage(part));
      out.push(withFields(message, { content: text.length ? text : '[image]' }));
    } else out.push(message);
  }
  flush();
  return out;
}
