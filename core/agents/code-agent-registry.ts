import { BuiltinCodeAgentAdapter } from './builtin-adapter.ts';
import type { CodeAgentAdapter, CodeAgentAvailability, CodeAgentId } from './code-agent.ts';
import { normalizeCodeAgents, type CodeAgentsConfig } from './code-agent-config.ts';
import { ClaudeCodeAdapter, CodexCliAdapter } from './cli-adapter.ts';

export interface CodeAgentRegistryOptions {
  config?: CodeAgentsConfig;
  dsh?: CodeAgentAdapter | null;
  builtin?: CodeAgentAdapter | null;
}

/** Builds and selects configured providers without exposing provider details to the control center. */
export class CodeAgentRegistry {
  readonly config: CodeAgentsConfig;
  private readonly providers = new Map<string, CodeAgentAdapter>();

  constructor(options: CodeAgentRegistryOptions = {}) {
    this.config = normalizeCodeAgents(options.config);
    const kinds: Record<string, string> = { builtin: 'builtin', dsh: 'dsh-acp', codex: 'codex-cli', claude: 'claude-cli' };
    for (const [id, config] of Object.entries(this.config.providers)) {
      if (config.enabled === false) continue;
      if (kinds[id] !== config.kind) throw new Error(`Unsupported code agent configuration: ${id}/${config.kind}`);
      if (config.modelProvider && config.kind !== 'dsh-acp') throw new Error(`${id} does not support modelProvider`);
      if (config.kind === 'claude-cli' && config.profile) throw new Error('Claude CLI does not support a profile option');
      if (config.kind === 'dsh-acp' && (config.args?.length || config.prefixArgs?.length)) throw new Error('DSH extra arguments are not supported; use explicit profile/model settings');
      if (config.kind === 'builtin' && (config.model || config.profile || config.command || config.args?.length || config.prefixArgs?.length)) throw new Error('Built-in model/profile/command options require a Host executor factory');
      const args = config.args ?? [];
      if ((config.kind === 'codex-cli' || config.kind === 'claude-cli') && config.model
        && args.some(arg => arg === '-m' || arg.startsWith('-m=') || arg === '--model' || arg.startsWith('--model='))) {
        throw new Error(`${id} model is specified in both model and args`);
      }
      if (config.kind === 'codex-cli' && config.profile
        && args.some(arg => arg === '-p' || arg.startsWith('-p=') || arg === '--profile' || arg.startsWith('--profile='))) {
        throw new Error('codex profile is specified in both profile and args');
      }
    }
    if (this.config.providers.builtin?.enabled !== false) this.providers.set('builtin', options.builtin ?? new BuiltinCodeAgentAdapter());
    if (options.dsh && this.config.providers.dsh?.enabled !== false) this.providers.set('dsh', options.dsh);
    const codex = this.config.providers.codex;
    if (codex?.enabled !== false) this.providers.set('codex', new CodexCliAdapter({ command: codex?.command ?? 'codex', prefixArgs: codex?.prefixArgs, extraArgs: codex?.args, model: codex?.model, profile: codex?.profile,
      sandboxMode: codex?.sandboxMode, networkAccess: codex?.networkAccess }));
    const claude = this.config.providers.claude;
    if (claude?.enabled !== false) this.providers.set('claude', new ClaudeCodeAdapter({ command: claude?.command ?? 'claude', prefixArgs: claude?.prefixArgs, extraArgs: claude?.args, model: claude?.model }));
  }

  get(id: CodeAgentId): CodeAgentAdapter | null { return this.providers.get(id) ?? null; }

  /** Detects all enabled providers without starting a task. */
  async detect(): Promise<CodeAgentAvailability[]> {
    return Promise.all([...this.providers.values()].map((provider) => provider.detect()));
  }

  /**
   * `auto` does not silently switch to an installed external CLI. It uses an
   * explicitly configured preference, then the host-owned builtin provider.
   */
  select(preferred?: CodeAgentId | null): CodeAgentAdapter | null {
    const id = preferred ?? (this.config.default === 'auto' ? this.config.preferredExternal : this.config.default);
    return id ? this.get(id) : this.get('builtin');
  }
}
