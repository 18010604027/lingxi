/**
 * The ACP process backend for an external code agent. DSH owns the profile,
 * model, session store, tools, sandbox and approvals; the Host only passes a
 * task and handles the normalized permission callback. The old control-center
 * profile remains available for compatibility with existing migrations and
 * tests, but production wiring uses DSH for code tasks only.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpConnection, type AcpLaunch } from './acp.ts';
import type { AcpMcpServer } from './mcp.ts';

export const DSH_PROFILE = 'ds-control';
/** The DSH profile the code agent runs on: its own tools and sandbox, apart from the control center's. */
export const DSH_CODE_PROFILE = 'ds-code';
/** DSH's own route for the account signed in in DSH Desktop. */
export const DSH_MODEL = { provider: 'deepseek-account', model: 'deepseek-flash' };

const PERSONA = [
  'You are the control center behind a desktop pet, running in DeepSeek Harness. You wake when the pet hands you a task and',
  'stop when it is handled. Your working directory {{cwd}} is the pet\'s workspace.',
  'Before deciding anything, work out what the person wants. The pet relays their words as said; read them for the outcome',
  'they are after, not the literal words, with what came before (incident_history) and the screen (screen_glance) when it is',
  'about the screen. Record that reading in one line with record_decision, then choose the way. "Stop blocking my typing", for',
  "one, is about where the pet walks over the place they type, not a spot to pin it to. If the pet's reading in the task",
  'differs from the words, trust the words.',
  'Handle what is in front of you now. When something should be done by a script or a small model from now on, give it to a',
  'subagent and keep its output under control/drafts/: nothing there goes live until a separate test and promotion step passes it.',
  'Keep your own notes under control/ so the next takeover knows what you knew. You have no shell and no file tools of your',
  "own here: read the workspace with the pet's read_file, list_files, glob_files and grep_files, and write with its",
  'control_write, which takes paths under control/ only. You are not a coding agent: do not study how the pet is built;',
  'decide what should happen, and leave how to build it to a code agent.',
  "The pet's own tools are on the MCP server named pet: reminders, the ledger of this incident, recording decisions, telling the",
  'pet something before you finish. Record each real decision with its reason. Say what you are doing with report_progress when',
  'you start and when it changes, in a few plain words.',
  'Your final message is delivered to the pet as the result: say what you did, what you decided and why, briefly. Use the',
  'pet\'s tell_front only for what must reach the person before you finish, never to repeat your result.',
].join(' ');

const CODE_PERSONA = [
  'You are the code agent behind a desktop pet, running in DeepSeek Harness. The control center hands you a task; you',
  'write the code for it, test it, and report. Your working directory {{cwd}} is your own folder and the only one open to',
  "you. In it: _source/, a copy of the pet's source made fresh before each task (read it; changes to it are thrown away),",
  '_playbook/, the standards, rules and catalog you follow, and your drafts: put each task in a folder of its own, named',
  'for what it does, with its code, its tests and a README saying what it does, how it is wired in and what it does not',
  'cover. Nothing outside this folder is yours to read or write; a refusal there is not a problem to work around.',
  'Run your tests with node in PowerShell (node --test and the test files) and say in your report which ran and what they',
  'gave; a test that',
  'never ran does not count. Nothing you write goes live by itself: a separate test and promotion step decides that.',
  'When you truly need something outside your folder (installing a package, writing elsewhere, the network, touching the',
  'running pet), ask for the wider access the denial offers, once, and only after saying in a line what it is for and',
  'why nothing smaller will do: the person answers it, and a refusal stands.',
  'Your final message is delivered to the control center as the result: what you wrote and where, what the tests gave, and',
  'what is left, briefly.',
].join(' ');

export interface DshInstall {
  /** `DeepSeek Harness.exe`, which runs the CLI as Node when `ELECTRON_RUN_AS_NODE` is set, as DSH's own dsh.cmd does. */
  exe: string;
  cli: string;
}

/** The installed DSH Desktop: `LINGXI_DSH_DIR` if set, else the install location Windows recorded; null when none. */
export function findDsh(env: NodeJS.ProcessEnv = process.env): DshInstall | null {
  const dirs: string[] = [];
  if (env.LINGXI_DSH_DIR) dirs.push(env.LINGXI_DSH_DIR);
  else if (process.platform === 'win32') dirs.push(...registryInstallDirs());
  for (const dir of dirs) {
    const exe = join(dir, 'DeepSeek Harness.exe');
    const cli = join(dir, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    if (existsSync(exe)) return { exe, cli };
  }
  return null;
}

function registryInstallDirs(): string[] {
  const dirs: string[] = [];
  for (const root of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg', ['query', `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'DeepSeek Harness', '/d'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const m of out.matchAll(/InstallLocation\s+REG_SZ\s+(.+)/g)) dirs.push(m[1]!.trim());
    } catch { /* no entry under this root */ }
  }
  return dirs;
}

export interface PermissionAsk {
  sessionId: string;
  /** What DSH wants to do, as it describes the tool call. */
  title: string;
  /** The tool call's arguments, as JSON, cut to a few hundred characters. */
  detail: string;
  /** The tool call's arguments as given. */
  input?: unknown;
  /** What the agent last said before the call: usually why it asks. */
  said?: string;
}

export interface DshRunResult { text: string; sessionId: string; stopReason: string; resumed: boolean }

interface Live {
  chunks: string[];
  onPermission: (ask: PermissionAsk) => Promise<boolean>;
  onUpdate?: (update: { type: 'text'; text: string } | { type: 'tool'; id: string; title: string; input?: unknown }) => void;
  /** The tool calls DSH announced, by id: a permission request names only the id. */
  calls: Map<string, { title: string; input: unknown }>;
}

export interface DshOptions {
  install: DshInstall;
  /** Where the overlay patch is written. */
  dataDir: string;
  /** The working directory of every session: the pet's workspace. */
  cwd: string;
  dshHome?: string;
  /** Which profile this is: legacy control compatibility or the code agent (its tools, writes fenced to `writableRoot`). */
  role?: 'control' | 'code';
  /** Another profile and persona for a code-role agent, as the development tasks of tools/dsh-dev use (`ds-dev`). */
  profile?: string;
  persona?: string;
  /** The only folders the code agent's file tools may open (dsh-read-fence.mjs). */
  readFence?: { only: string[]; deny?: string[] };
  /** The command DSH runs each confined shell call through, its sandbox arguments appended (dsh-mxc-runner.mjs). */
  runner?: string[];
  model?: { provider: string; model: string };
  log?: (message: string) => void;
  /** The one directory DSH's sandbox lets the control center write without approval; the session cwd when absent. */
  writableRoot?: string;
  /** DSH's sandbox mode; `read-only` makes every write ask for approval. */
  sandboxMode?: 'read-only' | 'workspace-write';
  /** Replaces the DSH launch, for tests that stand a fake ACP agent in for DSH. */
  launch?: () => AcpLaunch;
}

export class DshBackend {
  private conn: AcpConnection | null = null;
  private starting: Promise<AcpConnection> | null = null;
  private readonly sessions = new Map<string, Live>();
  private readonly opts: DshOptions;
  private readonly exitListeners = new Set<(error: Error) => void>();

  constructor(opts: DshOptions) {
    this.opts = opts;
  }

  /** Whether DSH said, when it started, that a prompt may carry images. */
  takesImages = false;

  get running(): boolean { return !!this.conn && !this.conn.closed && !this.starting; }
  get executable(): string { return this.opts.install.exe; }
  /** Configuration evidence only; actual OS isolation still requires an end-to-end check. */
  get isolationConfiguration(): { sandbox: boolean; networkPolicy: boolean } {
    const runner = this.opts.runner;
    const configuredRunner = !this.opts.launch && runner?.length && resolve(runner[1] ?? '') === resolve(fileURLToPath(new URL('./dsh-mxc-runner.mjs', import.meta.url)));
    const root = resolve(this.opts.cwd);
    const fenced = this.opts.role === 'code' && this.opts.sandboxMode === 'workspace-write'
      && !!this.opts.writableRoot && resolve(this.opts.writableRoot) === root
      && this.opts.readFence?.only.length === 1 && resolve(this.opts.readFence.only[0]!) === root;
    const sandbox = !!configuredRunner && !!fenced;
    const networkArgs = runner?.filter((arg) => arg.startsWith('--network=')) ?? [];
    return { sandbox, networkPolicy: sandbox && networkArgs.length === 1 && networkArgs[0] === '--network=deny' };
  }
  /** Check the task package against the paths actually used by the fixed DSH profile. */
  validateWorkspace(task: { cwd: string; writableRoot: string; readRoots: string[] }): void {
    const same = (a: string, b: string) => resolve(a) === resolve(b);
    const fence = this.opts.readFence?.only ?? [];
    if (!task.cwd || !task.writableRoot || !this.opts.writableRoot
      || !same(task.cwd, this.opts.cwd) || !same(task.writableRoot, this.opts.writableRoot)
      || task.readRoots.length !== fence.length
      || task.readRoots.some((root, index) => !root || !same(root, fence[index]!))) {
      throw new Error('DSH task workspace does not match its configured isolation');
    }
  }
  async start(): Promise<void> { await this.connection(); }
  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /**
   * Runs one task and returns the agent's messages; `shouldStop` cancels it at any time. With `resume` the task goes
   * into that session, so one incident stays one session in DSH; a session that cannot be resumed is replaced by a new
   * one, and `resumed` says which happened. `mcpServers` are the tools the session may call back into the pet with.
   */
  async run(text: string, shouldStop: () => boolean, onPermission: (ask: PermissionAsk) => Promise<boolean>,
    resume: string | null = null, mcpServers: AcpMcpServer[] = [], images: Uint8Array[] = [], onStarted?: (sessionId: string) => void,
    onUpdate?: Live['onUpdate'], strictResume = false): Promise<DshRunResult> {
    const conn = await this.connection();
    let sessionId = '';
    let resumed = false;
    if (resume) {
      try {
        await conn.request('session/resume', { sessionId: resume, cwd: this.opts.cwd, mcpServers });
        sessionId = resume;
        resumed = true;
      } catch (error) {
        if (strictResume) throw new Error(`DSH could not resume session ${resume}: ${(error as Error).message}`);
        this.opts.log?.(`[dsh] could not resume session ${resume}; starting a new one: ${(error as Error).message}`);
      }
    }
    if (!sessionId) sessionId = (await conn.request<{ sessionId: string }>('session/new', { cwd: this.opts.cwd, mcpServers })).sessionId;
    const live: Live = { chunks: [], onPermission, onUpdate, calls: new Map() };
    this.sessions.set(sessionId, live);
    const watch = setInterval(() => { if (shouldStop()) { clearInterval(watch); conn.notify('session/cancel', { sessionId }); } }, 250);
    try {
      // Session creation already succeeded. Cleanup must still run if the host
      // cannot record that fact in its start callback.
      onStarted?.(sessionId);
      // pictures go as ACP image blocks when DSH said it takes them; otherwise the text says how to look at them instead
      const pictures = this.takesImages ? images.map((jpeg) => ({ type: 'image', mimeType: 'image/jpeg', data: Buffer.from(jpeg).toString('base64') })) : [];
      const { stopReason } = await conn.request<{ stopReason: string }>('session/prompt', { sessionId, prompt: [{ type: 'text', text }, ...pictures] });
      // each chunk is one committed message: the last is the agent's answer, the earlier ones its narration on the way
      return { text: live.chunks.filter((c) => c.trim()).at(-1) ?? '', sessionId, stopReason, resumed };
    } finally {
      clearInterval(watch);
      this.sessions.delete(sessionId);
      conn.request('session/close', { sessionId }).catch(() => {});
    }
  }

  /**
   * Deletes stored sessions untouched for `days`, as the ledger drops its details: DSH never deletes session files.
   * What was decided stays in the ledger. Returns how many went.
   */
  pruneSessions(days: number, now = Date.now()): number {
    const root = this.sessionsRoot();
    if (!existsSync(root)) return 0;
    let removed = 0;
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const session of readdirSync(join(root, project.name), { withFileTypes: true })) {
        const dir = join(root, project.name, session.name);
        if (!session.isDirectory() || this.sessions.has(session.name) || now - newest(dir) < days * 86_400_000) continue;
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  sessionsRoot(): string {
    return join(this.opts.dataDir, this.opts.role === 'code' ? 'dsh-code-sessions' : 'dsh-sessions');
  }

  async close(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    await conn?.close();
  }

  private connection(): Promise<AcpConnection> {
    if (this.starting) return this.starting;
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.starting ??= this.open().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async open(): Promise<AcpConnection> {
    const conn = new AcpConnection(this.opts.launch?.() ?? this.launch(), {
      onNotification: (method, params) => this.notified(method, params),
      onRequest: (method, params) => this.asked(method, params),
      onStray: (line) => this.opts.log?.(`[dsh] ${line}`),
      onExit: (error) => {
        this.opts.log?.(`[dsh] ${error.message}`);
        for (const listener of this.exitListeners) listener(error);
      },
    });
    this.conn = conn;
    try {
      const init = await conn.request<{ agentCapabilities?: { promptCapabilities?: { image?: boolean } } }>('initialize', { protocolVersion: 1, clientCapabilities: {} });
      this.takesImages = init?.agentCapabilities?.promptCapabilities?.image === true;
      return conn;
    } catch (error) {
      if (this.conn === conn) this.conn = null;
      await conn.close();
      throw error;
    }
  }

  private launch(): AcpLaunch {
    const home = this.opts.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
    mkdirSync(this.opts.dataDir, { recursive: true });
    const code = this.opts.role === 'code';
    const profile = this.opts.profile ?? (code ? DSH_CODE_PROFILE : DSH_PROFILE);
    const patch = join(this.opts.dataDir, code ? 'dsh-code.patch.yml' : 'dsh-control.patch.yml');
    writeFileSync(patch, overlay(this.opts.model ?? DSH_MODEL, this.sessionsRoot(), this.opts.writableRoot ?? this.opts.cwd, this.opts.sandboxMode ?? 'workspace-write',
      code ? { persona: this.opts.persona ?? CODE_PERSONA, disabled: CODE_DISABLED_TOOLS, readFence: this.opts.readFence, runner: this.opts.runner } : undefined));
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home };
    let fresh = existsSync(join(home, 'profiles', profile)) ? [] : ['--from-default-profile', 'acp'];
    if (code && this.opts.readFence) {
      // the fence must be in place before the first session: make the profile now, then put the plugin into it
      if (fresh.length) {
        execFileSync(this.opts.install.exe, ['--expose-internals', this.opts.install.cli, '--profile', profile, ...fresh, '--dump-config'],
          { env, stdio: 'ignore', windowsHide: true, timeout: 60_000 });
        fresh = [];
      }
      installReadFence(join(home, 'profiles', profile));
    }
    return {
      command: this.opts.install.exe,
      args: ['--expose-internals', this.opts.install.cli, '--profile', profile, ...fresh, '--patch', patch],
      env,
    };
  }

  private notified(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return;
    const live = this.sessions.get(String(params.sessionId));
    const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; rawInput?: unknown } | undefined;
    if (live && update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = update.content.text ?? '';
      live.chunks.push(text);
      live.onUpdate?.({ type: 'text', text });
    }
    if (live && update?.sessionUpdate === 'tool_call' && update.toolCallId) {
      live.calls.set(update.toolCallId, { title: update.title ?? 'a tool call', input: update.rawInput });
      live.onUpdate?.({ type: 'tool', id: update.toolCallId, title: update.title ?? 'a tool call', input: update.rawInput });
    }
  }

  private async asked(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== 'session/request_permission') throw new Error(`not supported: ${method}`);
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; name?: string }>;
    const pick = (allow: boolean) => options.find((o) => (allow ? o.kind?.startsWith('allow') : o.kind?.startsWith('reject')))?.optionId;
    const live = this.sessions.get(String(params.sessionId));
    const named = (params.toolCall ?? {}) as { toolCallId?: string; title?: string; rawInput?: unknown; kind?: string };
    // DSH names only the call's id; what the call is came before as a tool_call update
    const seen = named.toolCallId ? live?.calls.get(named.toolCallId) : undefined;
    const call = { title: named.title ?? seen?.title ?? named.kind, rawInput: named.rawInput ?? seen?.input };
    let allow = false;
    if (live) {
      try {
        // an escalation carries the agent's reason in its own fields; the rest is what the call does
        const args = call.rawInput && typeof call.rawInput === 'object' ? { ...call.rawInput as Record<string, unknown> } : null;
        const why = args ? [args.justification, args.description].filter((v): v is string => typeof v === 'string' && v.trim() !== '').join(' — ') : '';
        if (args) for (const k of ESCALATION_KEYS) delete args[k];
        allow = await live.onPermission({
          sessionId: String(params.sessionId),
          title: call.title ?? 'a tool call',
          detail: call.rawInput === undefined ? '' : JSON.stringify(args ?? call.rawInput).slice(0, 600),
          input: call.rawInput,
          said: (why || live.chunks.filter((c) => c.trim()).at(-1)?.trim() || '').slice(-400),
        });
      } catch { allow = false; }
    }
    const optionId = pick(allow);
    return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
  }
}

/** DSH tool entries turned off for the control center (ids from `dsh --dump-config`). */
export const DISABLED_TOOLS = ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-plugin-manager'];
/** The plugin that keeps the code agent's file tools out of private folders, by the package name DSH loads it under. */
const READ_FENCE_PLUGIN = 'lingxi-read-fence';

/**
 * Puts the read fence into a DSH profile as a package (DSH loads plugins from the profile's node_modules), fresh
 * from `dsh-read-fence.mjs` at every start so the profile never runs an old copy.
 */
export function installReadFence(profileDir: string): void {
  const dir = join(profileDir, 'node_modules', READ_FENCE_PLUGIN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: READ_FENCE_PLUGIN, version: '0.0.0', private: true, type: 'module', exports: './index.mjs' }));
  copyFileSync(fileURLToPath(new URL('./dsh-read-fence.mjs', import.meta.url)), join(dir, 'index.mjs'));
}

/** How the shell runner marks a failure of its own, as against a failure of the command it ran. */
export const RUNNER_FAILURE = 'mxc-runner:';

/**
 * The code agent's shell runner (dsh-mxc-runner.mjs) as DSH starts it: under Node, the one the pet runs on, or the
 * one on the PATH when the pet runs inside Electron. `network` is whether its commands may reach the network; off for
 * now, to be weighed again later (TODO).
 */
export function mxcRunner(network: 'allow' | 'deny' = 'deny', deny: string[] = []): string[] {
  let node = process.execPath;
  if (process.versions.electron) {
    try { node = execFileSync('where', ['node'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0]!.trim() || 'node'; } catch { node = 'node'; }
  }
  return [node, fileURLToPath(new URL('./dsh-mxc-runner.mjs', import.meta.url)), `--network=${network}`, ...deny.map((d) => `--deny=${d}`)];
}

/** The fields of a tool call that ask for a wider sandbox and say why, rather than say what the call does. */
const ESCALATION_KEYS = ['justification', 'description', 'sandbox_permissions'];
/** For the code agent only plugin installs are off: its shell and file tools are fenced by DSH's sandbox instead. */
export const CODE_DISABLED_TOOLS = ['tool-plugin-manager'];

/** The latest modification time of anything in `dir`, in epoch ms. */
function newest(dir: string): number {
  let latest = statSync(dir).mtimeMs;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    latest = Math.max(latest, e.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return latest;
}

/**
 * The overlay patch: the persona (the control center's unless `agent` gives another), the model route of DSH's ACP bridge, the session store moved to
 * `sessionsRoot` (so the pet's background sessions stay out of the session list of DSH Desktop and its other
 * profiles), the tools turned off, and DSH's write sandbox rooted at `writableRoot`, so a write anywhere else is refused
 * unless the person approves a wider one for that call.
 */
export function overlay(model: { provider: string; model: string }, sessionsRoot: string, writableRoot: string,
  sandboxMode: 'read-only' | 'workspace-write' = 'workspace-write', agent?: { persona: string; disabled: string[]; readFence?: { only: string[]; deny?: string[] }; runner?: string[] }): string {
  const slash = (p: string) => JSON.stringify(p.replace(/\\/g, '/'));
  return [
    '# Written by lingxi-pet at each start; edits here are overwritten.',
    '- id: system-prompt',
    '  config:',
    `    persona: ${JSON.stringify(agent?.persona ?? PERSONA)}`,
    '- id: acp',
    "  name: '@deepseek-ai/dsh-acp'",
    '  inject: [acpAppStartup]',
    '  config:',
    `    provider: ${JSON.stringify(model.provider)}`,
    `    model: ${JSON.stringify(model.model)}`,
    '- id: session-persistence-jsonl',
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(sessionsRoot.replace(/\\/g, '/'))}`,
    // the control center: no shell, no file tools of its own, no plugin installs; it reads through the pet's tools
    ...(agent?.disabled ?? DISABLED_TOOLS).flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    `    mode: ${sandboxMode}`,
    `    workspaceRoot: ${JSON.stringify(writableRoot.replace(/\\/g, '/'))}`,
    // a plugin the bundles do not mount goes in with an insert entry; a bare entry only patches an existing id
    ...(agent?.readFence ? [
      '- insert:',
      '    - id: read-fence',
      `      name: ${JSON.stringify(READ_FENCE_PLUGIN)}`,
      '      config:',
      `        only: [${agent.readFence.only.map(slash).join(', ')}]`,
      ...(agent.readFence.deny?.length ? [`        deny: [${agent.readFence.deny.map(slash).join(', ')}]`] : []),
    ] : []),
    // the shell's sandbox: our runner in place of DSH's own, which fences writes only
    ...(agent?.runner ? [
      '- id: sandbox',
      '  config:',
      `    runnerCommand: [${agent.runner.map(slash).join(', ')}]`,
      `    runnerFailureSignatures: [${JSON.stringify(RUNNER_FAILURE)}]`,
    ] : []),
    '',
  ].join('\n');
}
