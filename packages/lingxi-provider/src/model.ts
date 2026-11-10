import { ChatOpenAI, type ChatOpenAIFields } from '@langchain/openai';
import { protocolOf, validateEntry, type ProviderEntry } from './config.ts';

export interface ModelOptions { apiKey?: string }

/** The adapter owns requests, streaming, tool-call assembly, cancellation and usage metadata. */
export function createModel(entry: ProviderEntry, options: ModelOptions = {}): ChatOpenAI {
  validateEntry(entry);
  const { spec } = entry;
  const effort = spec.thinking === false ? 'none' : spec.reasoningEffort;
  const responses = protocolOf(entry) === 'responses';
  return new ChatOpenAI({
    model: spec.model,
    apiKey: options.apiKey || 'not-required',
    configuration: {
      baseURL: entry.baseUrl.replace(/\/+$/, ''),
    },
    useResponsesApi: responses,
    ...(effort ? { reasoning: { effort } as ChatOpenAIFields['reasoning'] } : {}),
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    // The adapter's generic reasoning field only recognizes OpenAI model names.
    modelKwargs: { store: false, ...(effort ? responses ? { reasoning: { effort } } : { reasoning_effort: effort } : {}) },
  });
}
