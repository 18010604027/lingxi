import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  CodeAgentAdapter,
  CodeAgentAvailability,
  CodeAgentCapabilities,
  CodeAgentEvent,
  CodeAgentRunOptions,
  CodeRunRef,
  CodeRunResult,
  CodeTask,
} from './code-agent.ts';
import { emitCodeAgentStateActivity, emitRegisteredCodeToolActivity } from './code-agent.ts';

const execFileAsync = promisify(execFile);

export interface CliAdapterOptions {
  command: string;
  /** Arguments placed before provider-generated task arguments; useful for a wrapper or a fake process. */
  prefixArgs?: string[];
  extraArgs?: string[];
  model?: string;
  profile?: string;
  sandboxMode?: 'read-only' | 'workspace-write';
  networkAccess?: 'deny' | 'allow';
  detect?: (command: string) => Promise<boolean>;
}

export interface CliCommandAdapterOptions extends CliAdapterOptions {
  id: 'codex' | 'claude' | (string & {});
  label: string;
  capabilities: CodeAgentCapabilities;
  buildArgs: (task: CodeTask, options: CliAdapterOptions) => string[];
  spawnProcess?: (command: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;
}

/**
 * Shared line-process adapter for headless coding CLIs. It never parses human
 * terminal decoration: providers must emit JSONL/stream-json, and unknown JSON
 * is retained as a plain message for the run summary.
 */
export class CliCodeAgentAdapter implements CodeAgentAdapter {
  readonly id: CliCommandAdapterOptions['id'];
  readonly label: string;
  readonly capabilities: CodeAgentCapabilities;
  private readonly options: CliCommandAdapterOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private launching = false;
  private closeGeneration = 0;
  private childClosed: Promise<{ code: number | null; error: Error | null }> | null = null;
  private readonly exitListeners = new Set<(error: Error) => void>();

  constructor(options: CliCommandAdapterOptions) {
    this.options = options;
    this.id = options.id;
    this.label = options.label;
    this.capabilities = options.capabilities;
  }

  get running(): boolean { return this.child !== null || this.launching; }
  get takesImages(): boolean { return false; }

  async detect(): Promise<CodeAgentAvailability> {
    const available = await (this.options.detect ?? commandExists)(this.options.command);
    return {
      id: this.id,
      available,
      command: this.options.command,
      reason: available ? 'CLI found; authentication is checked when it runs' : `CLI not found: ${this.options.command}`,
    };
  }

  async start(): Promise<void> {
    // CLI providers are process-per-task. Keeping start in the common contract
    // lets the keeper use the same lifecycle without starting a hidden process.
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  async run(task: CodeTask, options: CodeAgentRunOptions): Promise<CodeRunResult> {
    if (this.child || this.launching) throw new Error(`${this.label} is already running`);
    if (task.resume && (task.resume.provider !== this.id || !this.capabilities.resume)) throw new Error(`${this.label} cannot resume this run`);
    const resumed = !!task.resume && this.capabilities.resume;
    const ref: CodeRunRef = resumed ? { ...task.resume! } : { provider: this.id, runId: `${this.id}-${crypto.randomUUID()}` };
    if (options.shouldStop()) return { ref, status: 'cancelled', summary: '', resumed: false };
    // Persist the task-bound run identity before starting a process that may cause side effects.
    options.onRunRef?.(ref);
    const args = [...(this.options.prefixArgs ?? []), ...this.options.buildArgs(task, this.options)];
    const spawnProcess = this.options.spawnProcess ?? ((command, argv, cwd) => spawn(command, argv, {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }));
    this.launching = true;
    const generation = this.closeGeneration;
    let child: ChildProcessWithoutNullStreams;
    try {
      const launch = this.options.spawnProcess ? { command: this.options.command, args } : await cliLaunch(this.options.command, args, this.id);
      if (generation !== this.closeGeneration || options.shouldStop()) return { ref, status: 'cancelled', summary: '', resumed: false };
      child = spawnProcess(launch.command, launch.args, task.cwd);
      this.child = child;
    } finally { this.launching = false; }
    this.childClosed = new Promise((resolve) => {
      let failure: Error | null = null;
      child.once('error', (cause) => { failure = cause instanceof Error ? cause : new Error(String(cause)); });
      // `close` follows process exit and the end of stdout/stderr.
      child.once('close', (code) => resolve({ code, error: failure }));
    });
    let spawned = false;
    let startCallbackError: Error | undefined;
    const emit = (event: CodeAgentEvent) => {
      try { options.onEvent?.(event); }
      catch (error) { console.warn(`[code-agent] event observer failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (event.type === 'tool') {
        const state = event.phase === 'started' ? 'started' : event.phase === 'updated' ? 'updated' : 'finished';
        emitRegisteredCodeToolActivity(task, options, ref, event.id, event.title, state);
      }
    };
    child.once('spawn', () => {
      spawned = true;
      try { options.onStarted?.(ref); }
      catch (error) {
        startCallbackError = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
      emitCodeAgentStateActivity(task, options, ref, 'started');
      emit({ type: 'started', run: ref });
    });
    // Prompts are argv data. A piped but open stdin makes Codex wait for more input.
    child.stdin.end();
    let stopped = false;
    let summary = '';
    let stderr = '';
    let runRefError: Error | undefined;
    const runRefStopReason: { value: 'run_ref_persist_failed' | 'resume_ref_mismatch' } = { value: 'run_ref_persist_failed' };
    let lineBuffer = '';
    const stream: CliStreamState = {};
    const decoder = new StringDecoder('utf8');
    const stopPoll = setInterval(() => {
      if (!stopped && options.shouldStop()) {
        stopped = true;
        child.kill();
      }
    }, 100);
    const read = (chunk: Buffer, channel: 'stdout' | 'stderr') => {
      if (channel === 'stderr') {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) emit({ type: 'text', channel: 'stderr', text: line });
        return;
      }
      lineBuffer += decoder.write(chunk);
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const result = parseJsonLine(line, emit, stream, (sessionId) => {
          if (task.resume?.sessionId && task.resume.sessionId !== sessionId) {
            runRefStopReason.value = 'resume_ref_mismatch';
            runRefError = new Error(`provider resumed a different session: expected ${task.resume.sessionId}, got ${sessionId}`);
            child.kill();
            return;
          }
          ref.sessionId = sessionId;
          try { options.onRunRef?.(ref); }
          catch (error) { runRefError = error instanceof Error ? error : new Error(String(error)); child.kill(); }
        });
        if (result) summary = result;
      }
    };
    child.stdout.on('data', (chunk: Buffer) => read(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => read(chunk, 'stderr'));
    let code: number | null = null;
    let error: Error | null = null;
    try {
      ({ code, error } = await this.childClosed);
    } finally {
      clearInterval(stopPoll);
      lineBuffer += decoder.end();
      if (lineBuffer.trim()) {
        const result = parseJsonLine(lineBuffer, emit, stream, (sessionId) => {
          if (task.resume?.sessionId && task.resume.sessionId !== sessionId) {
            runRefStopReason.value = 'resume_ref_mismatch';
            runRefError = new Error(`provider resumed a different session: expected ${task.resume.sessionId}, got ${sessionId}`);
            child.kill();
            return;
          }
          ref.sessionId = sessionId;
          try { options.onRunRef?.(ref); }
          catch (error) { runRefError = error instanceof Error ? error : new Error(String(error)); child.kill(); }
        });
        if (result) summary = result;
      }
      if (this.child === child) { this.child = null; this.childClosed = null; }
    }
    if (error) {
      if (!spawned) {
        const summary = error.message;
        emit({ type: 'finished', status: 'failed', summary });
        return { ref, status: 'failed', summary, stopReason: 'spawn_failed', resumed: false };
      }
      emitCodeAgentStateActivity(task, options, ref, 'unknown');
      for (const listener of this.exitListeners) listener(error);
      throw error;
    }
    if (runRefError) {
      const summary = runRefStopReason.value === 'resume_ref_mismatch'
        ? `CLI resume reference mismatch: ${runRefError.message}`
        : `CLI run reference could not be persisted: ${runRefError.message}`;
      emit({ type: 'finished', status: 'unknown', summary, exitCode: code ?? undefined });
      emitCodeAgentStateActivity(task, options, ref, 'unknown');
      return { ref, status: 'unknown', summary, stopReason: runRefStopReason.value, exitCode: code ?? undefined, resumed };
    }
    if (startCallbackError) {
      const summary = `CLI started but its start callback failed: ${startCallbackError.message}`;
      emit({ type: 'finished', status: 'unknown', summary, exitCode: code ?? undefined });
      emitCodeAgentStateActivity(task, options, ref, 'unknown');
      return { ref, status: 'unknown', summary, stopReason: 'start_callback_failed', exitCode: code ?? undefined, resumed };
    }
    // Killing the CLI is only a request to stop. It does not establish that
    // its child processes stopped or that an in-flight side effect did not run.
    // Preserve an explicit machine terminal result if it arrived in the race.
    const status = stream.terminal === 'failed' ? 'failed'
      : stream.terminal === 'succeeded' && code === 0 ? 'succeeded' : 'unknown';
    const finalSummary = summary || (stderr.trim() ? stderr.trim().slice(-2000) : '');
    emit({ type: 'finished', status, summary: finalSummary, exitCode: code ?? undefined });
    emitCodeAgentStateActivity(task, options, ref, status);
    return { ref, status, summary: finalSummary, ...(stopped && status === 'unknown' ? { stopReason: 'cancellation_unconfirmed' } : {}), exitCode: code ?? undefined, resumed };
  }

  async close(): Promise<void> {
    this.closeGeneration++;
    const child = this.child;
    if (!child) return;
    const closed = this.childClosed;
    child.kill();
    await closed;
  }
}

const CODEX_CAPABILITIES: CodeAgentCapabilities = {
  streaming: true, thoughts: true, resume: false, cancel: true, permissions: false,
  usage: true, structuredOutput: true, sandbox: true, networkPolicy: true,
};

const CLAUDE_CAPABILITIES: CodeAgentCapabilities = {
  streaming: true, thoughts: true, resume: true, cancel: true, permissions: false,
  usage: true, structuredOutput: true, sandbox: false, networkPolicy: false,
};

export class CodexCliAdapter extends CliCodeAgentAdapter {
  readonly taskNetworkPolicy: 'deny' | 'allow';
  constructor(options: CliAdapterOptions = { command: 'codex' }) {
    if (options.sandboxMode === 'read-only' && options.networkAccess === 'allow') {
      throw new Error('Codex read-only sandbox does not support enabling workspace network access');
    }
    super({ ...options, id: 'codex', label: 'Codex CLI', capabilities: CODEX_CAPABILITIES,
      buildArgs: (task, config) => codexArgs(task, config) });
    this.taskNetworkPolicy = options.networkAccess ?? 'deny';
  }
}

/** `--ask-for-approval` is a root option in current Codex CLI versions. */
export function codexArgs(task: CodeTask, config: CliAdapterOptions): string[] {
  return [
    '--ask-for-approval', 'never', ...(config.model ? ['--model', config.model] : []),
    ...(config.profile ? ['--profile', config.profile] : []),
    '--config', `sandbox_workspace_write.network_access=${config.networkAccess === 'allow' ? 'true' : 'false'}`,
    'exec', '--skip-git-repo-check', '--json', '--sandbox', config.sandboxMode ?? 'workspace-write',
    ...(config.extraArgs ?? []), '--', task.prompt,
  ];
}

export class ClaudeCodeAdapter extends CliCodeAgentAdapter {
  constructor(options: CliAdapterOptions = { command: 'claude' }) {
    if (options.profile) throw new Error('Claude CLI does not support a profile option');
    super({ ...options, id: 'claude', label: 'Claude Code CLI', capabilities: CLAUDE_CAPABILITIES,
      buildArgs: (task, config) => [
        ...(task.resume ? ['--resume', task.resume.sessionId ?? task.resume.runId] : []),
        ...(config.model ? ['--model', config.model] : []),
        '-p', task.prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', ...(config.extraArgs ?? []),
      ] });
  }
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Resolve known official npm shims without shell interpolation of the task prompt. */
async function cliLaunch(command: string, args: string[], id: string): Promise<{ command: string; args: string[] }> {
  if (process.platform !== 'win32' || (isAbsolute(command) && command.toLowerCase().endsWith('.exe'))) return { command, args };
  let paths: string[];
  try { paths = (await execFileAsync('where.exe', [command], { windowsHide: true })).stdout.trim().split(/\r?\n/); }
  catch { return { command, args }; }
  const exe = paths.find(path => path.toLowerCase().endsWith('.exe') && existsSync(path));
  if (exe) return { command: exe, args };
  const entry = id === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : id === 'claude' ? ['@anthropic-ai', 'claude-code', 'cli.js'] : null;
  if (entry) for (const path of paths) {
    const script = join(dirname(path), 'node_modules', ...entry);
    if (existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  }
  return { command, args };
}

interface CliStreamState { terminal?: 'succeeded' | 'failed'; sessionId?: string }

function parseJsonLine(line: string, emit?: (event: CodeAgentEvent) => void, state: CliStreamState = {}, onSessionId?: (sessionId: string) => void): string | null {
  let value: unknown;
  try { value = JSON.parse(line); } catch {
    if (line.trim()) emit?.({ type: 'text', channel: 'message', text: line });
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const item = object.item && typeof object.item === 'object' ? object.item as Record<string, unknown> : object;
  const kind = String(object.type ?? '').toLowerCase();
  const itemKind = String(item.type ?? kind).toLowerCase();
  const sessionId = stringOf(object.session_id) ?? stringOf(object.thread_id);
  if (sessionId && sessionId !== state.sessionId) { state.sessionId = sessionId; onSessionId?.(sessionId); }
  if (kind === 'turn.completed' || kind === 'result') state.terminal = object.is_error === true || (kind === 'result' && object.subtype && object.subtype !== 'success') ? 'failed' : 'succeeded';
  if (kind === 'turn.failed' || kind === 'error') {
    state.terminal = 'failed';
    const error = object.error && typeof object.error === 'object' ? object.error as Record<string, unknown> : object;
    emit?.({ type: 'error', code: kind, message: stringOf(error.message) ?? 'CLI reported an error', retryable: false });
  }
  const text = textOf(item) ?? textOf(object);
  const resultLine = kind === 'result' || kind.endsWith('.result') || kind.includes('turn.completed');
  const messageLine = itemKind.includes('assistant') || itemKind.includes('agent_message') || itemKind.includes('message');
  if (text && (!resultLine || messageLine)) {
    emit?.({ type: 'text', channel: itemKind.includes('thought') || itemKind.includes('reason') ? 'thought' : 'message', text });
  }
  if (kind.includes('tool') || kind === 'tool_use') {
    emit?.({ type: 'tool', phase: 'started', id: String(item.id ?? object.id ?? crypto.randomUUID()), title: String(item.name ?? item.title ?? 'tool'), input: item.input ?? item.arguments });
  }
  if (itemKind === 'command_execution' || itemKind === 'mcp_tool_call') {
    emit?.({ type: 'tool', phase: kind.endsWith('.completed') ? 'finished' : kind.endsWith('.updated') ? 'updated' : 'started',
      id: String(item.id ?? crypto.randomUUID()), title: String(item.command ?? item.tool ?? itemKind), input: item.arguments,
      output: item.aggregated_output ?? item.result });
  }
  const usage = object.usage ?? item.usage;
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    emit?.({ type: 'usage', inputTokens: numberOf(u.input_tokens ?? u.inputTokens), outputTokens: numberOf(u.output_tokens ?? u.outputTokens), cachedTokens: numberOf(u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens ?? u.cachedTokens) });
  }
  const result = stringOf(object.result) ?? (resultLine || messageLine ? text : null);
  return result;
}

function textOf(value: Record<string, unknown>): string | null {
  if (typeof value.text === 'string') return value.text;
  if (typeof value.result === 'string') return value.result;
  const content = value.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part === 'object' ? textOf(part as Record<string, unknown>) ?? '' : '').join('') || null;
  const message = value.message;
  if (message && typeof message === 'object') return textOf(message as Record<string, unknown>);
  return null;
}

function stringOf(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function numberOf(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
