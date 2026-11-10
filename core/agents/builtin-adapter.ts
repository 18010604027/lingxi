import type {
  CodeAgentAdapter,
  CodeAgentAvailability,
  CodeAgentCapabilities,
  CodeAgentRunOptions,
  CodeRunResult,
  CodeTask,
} from './code-agent.ts';

/** A host-owned executor can be plugged in without changing the provider contract. */
export interface BuiltinExecutor {
  /** The Host must explicitly declare the policies its executor actually enforces. */
  capabilities?: Pick<CodeAgentCapabilities, 'sandbox' | 'networkPolicy'>;
  run(task: CodeTask, options: CodeAgentRunOptions): Promise<CodeRunResult>;
}

const CAPABILITIES: CodeAgentCapabilities = {
  streaming: false,
  thoughts: false,
  resume: false,
  cancel: true,
  permissions: true,
  usage: false,
  structuredOutput: true,
  sandbox: true,
  networkPolicy: true,
};

/**
 * Minimal host-owned fallback. The model/tool loop is injected by the Host;
 * this adapter deliberately does not grow a second coding harness.
 */
export class BuiltinCodeAgentAdapter implements CodeAgentAdapter {
  readonly id = 'builtin' as const;
  readonly label = 'Lingxi built-in code agent';
  get capabilities(): CodeAgentCapabilities {
    return { ...CAPABILITIES, sandbox: this.executor?.capabilities?.sandbox === true, networkPolicy: this.executor?.capabilities?.networkPolicy === true };
  }

  constructor(private readonly executor: BuiltinExecutor | null = null) {}

  get running(): boolean { return false; }
  get takesImages(): boolean { return false; }

  async detect(): Promise<CodeAgentAvailability> {
    return {
      id: this.id,
      available: this.executor !== null,
      reason: this.executor ? 'Host executor is configured; model authentication has not been checked' : 'Host executor is not configured',
    };
  }

  async start(): Promise<void> {
    if (!this.executor) throw new Error('Built-in code agent is not configured');
  }

  validateTask(): void {
    if (!this.executor) throw new Error('Built-in code agent Host executor is not configured');
  }

  onExit(): () => void { return () => {}; }

  async run(task: CodeTask, options: CodeAgentRunOptions): Promise<CodeRunResult> {
    if (!this.executor) throw new Error('Built-in code agent is not configured');
    return this.executor.run(task, options);
  }

  async close(): Promise<void> {}
}
