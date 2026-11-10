/** Adapt explicitly selected business tools without changing their permissions or handlers. */
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { ToolCallContext, ToolDef } from '../contracts.ts';

export class SerialToolGate {
  private tail: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  /** Wait for already accepted handlers to settle, including one that ignored cancellation. */
  async drain(): Promise<void> { await this.tail; }
}

export interface AdaptToolOptions { gate?: SerialToolGate; onStart?: (tool: ToolDef) => void; onFailure?: (error: unknown, tool: ToolDef) => void }

export function adaptTool(def: ToolDef, context: Omit<ToolCallContext, 'callId' | 'signal'>, options: AdaptToolOptions = {}): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: def.name,
    description: def.description,
    schema: def.parameters,
    returnDirect: def.endsTurn ?? false,
    func: async (args, _manager, config) => {
      const call = config as typeof config & { toolCall?: { id?: string } };
      config?.signal?.throwIfAborted();
      const invoke = async () => {
        config?.signal?.throwIfAborted();
        options.onStart?.(def);
        const result = await def.handler(args as Record<string, unknown>, {
          ...context,
          ...(call?.toolCall?.id ? { callId: call.toolCall.id } : {}),
          ...(config?.signal ? { signal: config.signal } : {}),
        });
        if (typeof result === 'string') return result;
        if (result.failed) throw new Error(result.text);
        if (result.blobs?.length) throw new Error(`Tool ${def.name} returned attachments that this adapter cannot preserve`);
        return result.text;
      };
      try { return await (options.gate ? options.gate.run(invoke) : invoke()); }
      catch (error) { options.onFailure?.(error, def); throw error; }
    },
  });
}
