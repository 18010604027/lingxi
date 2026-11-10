import type { AcpMcpServer } from './mcp.ts';
import { DshBackend, type PermissionAsk } from './dsh.ts';
import { commandExists } from './cli-adapter.ts';
import type {
  CodeAgentAdapter,
  CodeAgentEvent,
  CodeAgentAvailability,
  CodeAgentCapabilities,
  CodeAgentRunOptions,
  CodePermissionRequest,
  CodeRunRef,
  CodeRunResult,
  CodeTask,
} from './code-agent.ts';
import { emitCodeAgentStateActivity, emitRegisteredCodeToolActivity } from './code-agent.ts';

/** Provider-specific task data accepted by the DSH ACP adapter. */
export interface DshTaskMetadata {
  mcpServers?: AcpMcpServer[];
}

const CAPABILITIES: CodeAgentCapabilities = {
  streaming: true,
  thoughts: false,
  resume: true,
  cancel: true,
  permissions: true,
  usage: false,
  structuredOutput: false,
  sandbox: false,
  networkPolicy: false,
};

/** ACP stop reasons are provider data; only explicit normal completion is success. */
export function codeStatusOfDshStopReason(reason: string): CodeRunResult['status'] {
  const value = reason.trim().toLowerCase();
  if (value === 'cancelled') return 'cancelled';
  if (value === 'end_turn') return 'succeeded';
  if (value === 'max_tokens' || value === 'max_turn_requests' || value === 'refusal') return 'failed';
  return 'unknown';
}

/**
 * The first external provider adapter. DSH owns ACP, the profile and the
 * sandbox; the rest of the app sees only CodeTask and CodeRunResult.
 */
export class DshAcpAdapter implements CodeAgentAdapter {
  readonly id = 'dsh' as const;
  readonly label = 'DeepSeek Harness (ACP)';
  get capabilities(): CodeAgentCapabilities {
    return { ...CAPABILITIES, ...this.backend.isolationConfiguration };
  }

  constructor(private readonly backend: DshBackend) {}

  get running(): boolean { return this.backend.running; }
  get takesImages(): boolean { return this.backend.takesImages; }

  validateTask(task: CodeTask): void { this.backend.validateWorkspace(task); }

  async detect(): Promise<CodeAgentAvailability> {
    const available = await commandExists(this.backend.executable);
    return {
      id: this.id,
      available,
      command: this.backend.executable,
      reason: available ? 'DSH executable found; ACP, authentication and task isolation require separate checks' : 'Configured DSH executable was not found',
    };
  }

  start(): Promise<void> { return this.backend.start(); }
  onExit(listener: (error: Error) => void): () => void { return this.backend.onExit(listener); }
  close(): Promise<void> { return this.backend.close(); }

  async run(task: CodeTask, options: CodeAgentRunOptions): Promise<CodeRunResult> {
    if (task.resume?.provider && task.resume.provider !== this.id) throw new Error('DSH cannot resume a run from another provider');
    const emit = (event: CodeAgentEvent) => {
      try { options.onEvent?.(event); }
      catch (error) { console.warn(`[code-agent] event observer failed: ${error instanceof Error ? error.message : String(error)}`); }
    };
    let started: CodeRunRef | undefined;
    let out;
    try {
      out = await this.backend.run(
      task.prompt,
      options.shouldStop,
      async (ask) => {
        const request = this.permission(ask, started);
        emit({ type: 'permission', request });
        return options.onPermission(request);
      },
      task.resume?.sessionId ?? task.resume?.runId ?? null,
      this.mcpServers(task),
      options.images ?? [],
      (sessionId) => {
        started = { provider: this.id, runId: sessionId, sessionId };
        options.onStarted?.(started);
        // Persist the ACP session before any later result can be treated as recoverable.
        options.onRunRef?.(started);
        emitCodeAgentStateActivity(task, options, started, 'started');
        emit({ type: 'started', run: started });
      },
      (update) => {
        const event: CodeAgentEvent = update.type === 'text'
          ? { type: 'text', channel: 'message', text: update.text }
          : { type: 'tool', phase: 'started', id: update.id, title: update.title, input: update.input };
        emit(event);
        const ref = started ?? task.resume;
        if (update.type === 'tool' && ref) emitRegisteredCodeToolActivity(task, options, ref, update.id, update.title, 'started');
      },
      true,
      );
    } catch (error) {
      const ref = started ?? { provider: this.id, runId: task.resume?.runId ?? `dsh-${crypto.randomUUID()}`, ...(task.resume?.sessionId ? { sessionId: task.resume.sessionId } : {}) };
      const status: CodeRunResult['status'] = started ? 'unknown' : 'failed';
      const summary = error instanceof Error ? error.message : String(error);
      emit({ type: 'finished', status, summary });
      emitCodeAgentStateActivity(task, options, ref, status);
      return { ref, status, summary, stopReason: 'connection_lost', resumed: false };
    }
    const ref = started ?? { provider: this.id, runId: out.sessionId, sessionId: out.sessionId };
    const status = codeStatusOfDshStopReason(out.stopReason);
    emit({ type: 'finished', status, summary: out.text });
    emitCodeAgentStateActivity(task, options, ref, status);
    return { ref, status, summary: out.text, stopReason: out.stopReason, resumed: out.resumed };
  }

  private permission(ask: PermissionAsk, started: CodeRunRef | undefined): CodePermissionRequest {
    return {
      run: started ?? { provider: this.id, runId: ask.sessionId, sessionId: ask.sessionId },
      title: ask.title,
      detail: ask.detail,
      input: ask.input,
      said: ask.said,
    };
  }

  private mcpServers(task: CodeTask): AcpMcpServer[] {
    const metadata = task.metadata as DshTaskMetadata | undefined;
    return metadata?.mcpServers ?? [];
  }
}
