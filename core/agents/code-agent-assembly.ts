import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BuiltinCodeAgentAdapter, type BuiltinExecutor } from './builtin-adapter.ts';
import { normalizeCodeAgents, type CodeAgentsConfig } from './code-agent-config.ts';
import { CodeAgentRegistry } from './code-agent-registry.ts';
import type { CodeAgentAdapter, CodeAgentRunOptions, CodeRunResult, CodeTask } from './code-agent.ts';
import { DshAcpAdapter } from './dsh-adapter.ts';
import { DSH_MODEL, DshBackend, findDsh, mxcRunner, type DshInstall } from './dsh.ts';

export interface CodeAgentAssemblyOptions {
  config?: Partial<CodeAgentsConfig> | null;
  dataDir: string;
  /** Only the controlled code-home workspace, never the Host's data root. */
  workspace: string;
  /** Omit to detect the local installation; null explicitly marks DSH unavailable. */
  dshInstall?: DshInstall | null;
  /** Explicit adapter home; otherwise use the application's own directory. */
  dshHome?: string;
  builtinExecutor?: BuiltinExecutor | null;
  log?: (message: string) => void;
}

export interface CodeAgentAssembly {
  config: CodeAgentsConfig;
  registry: CodeAgentRegistry;
  /** Pass null through to the Host: undefined enables the legacy fallback. */
  adapter: CodeAgentAdapter | null;
  reason: string | null;
}

/** Compose existing adapters; the Host retains its current Keeper and task bus. */
export function createCodeAgentAssembly(options: CodeAgentAssemblyOptions): CodeAgentAssembly {
  // Only an explicitly selected adapter may discover an external application.
  const config = normalizeCodeAgents(options.config ?? { default: 'auto' });
  const selected = config.default === 'auto' ? config.preferredExternal ?? 'builtin' : config.default;
  const workspace = resolve(options.workspace);
  const dataWithinWorkspace = relative(workspace, resolve(options.dataDir));
  if (!options.workspace.trim() || !dataWithinWorkspace || (!isAbsolute(dataWithinWorkspace) && dataWithinWorkspace !== '..' && !dataWithinWorkspace.startsWith(`..${sep}`))) {
    throw new Error('Code agent workspace must be a separate controlled directory');
  }
  const dshConfig = config.providers.dsh;
  let dsh: CodeAgentAdapter | null = null;
  let missingDsh = false;
  // Only a configuration that selects DSH may look for its installation; the normal path never probes the machine.
  const wantsDsh = config.default === 'dsh' || config.preferredExternal === 'dsh';
  if (wantsDsh && dshConfig?.enabled !== false) {
    const install = selected === 'dsh' ? (options.dshInstall === undefined ? findDsh() : options.dshInstall) : null;
    if (install) {
      dsh = new DshAcpAdapter(new DshBackend({
        install: { ...install, exe: dshConfig?.command && dshConfig.command !== 'DeepSeek Harness.exe' ? dshConfig.command : install.exe },
        dataDir: options.dataDir, cwd: workspace, writableRoot: workspace, sandboxMode: 'workspace-write', role: 'code',
        profile: dshConfig?.profile, model: { provider: dshConfig?.modelProvider ?? DSH_MODEL.provider, model: dshConfig?.model ?? DSH_MODEL.model },
        dshHome: options.dshHome ?? join(options.dataDir, 'code-agent-dsh-home'),
        readFence: { only: [workspace] }, runner: mxcRunner('deny'), log: options.log,
      }));
    } else { dsh = new MissingDshAdapter(); missingDsh = true; }
  }
  const registry = new CodeAgentRegistry({ config, dsh, builtin: new BuiltinCodeAgentAdapter(options.builtinExecutor ?? null) });
  const adapter = registry.select();
  const reason = !adapter ? `Configured code agent ${selected} is disabled or not registered`
    : selected === 'dsh' && missingDsh ? 'DeepSeek Harness installation was not found'
      : null;
  return { config: registry.config, registry, adapter, reason };
}

/** A missing installation remains visible to settings and never becomes another provider. */
class MissingDshAdapter implements CodeAgentAdapter {
  readonly id = 'dsh';
  readonly label = 'DeepSeek Harness (ACP)';
  readonly running = false;
  readonly takesImages = false;
  readonly capabilities = { streaming: false, thoughts: false, resume: false, cancel: false, permissions: false,
    usage: false, structuredOutput: false, sandbox: false, networkPolicy: false };
  async detect() { return { id: this.id, available: false, reason: 'DeepSeek Harness installation was not found' }; }
  async start(): Promise<void> { throw new Error('DeepSeek Harness installation was not found'); }
  validateTask(): void { throw new Error('DeepSeek Harness installation was not found'); }
  onExit(): () => void { return () => {}; }
  async run(_task: CodeTask, _options: CodeAgentRunOptions): Promise<CodeRunResult> { throw new Error('DeepSeek Harness installation was not found'); }
  async close(): Promise<void> {}
}
