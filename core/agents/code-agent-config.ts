import type { CodeAgentId } from './code-agent.ts';

export type CodeAgentProviderKind = 'builtin' | 'dsh-acp' | 'codex-cli' | 'claude-cli';

export interface CodeAgentProviderConfig {
  kind: CodeAgentProviderKind;
  command?: string;
  enabled?: boolean;
  profile?: string;
  model?: string;
  /** Provider route for DSH; CLI providers use their own configured account. */
  modelProvider?: string;
  /** Codex CLI workspace permission profile. Supported by the codex-cli provider only. */
  sandboxMode?: 'read-only' | 'workspace-write';
  /** Codex CLI network setting for workspace-write. */
  networkAccess?: 'deny' | 'allow';
  /** Wrapper arguments before generated CLI options (for example a Node entry point). */
  prefixArgs?: string[];
  args?: string[];
}

export interface CodeAgentsConfig {
  /** `auto` keeps provider selection out of the prompt and in this config. */
  default: 'auto' | CodeAgentId;
  preferredExternal: CodeAgentId | null;
  providers: Record<string, CodeAgentProviderConfig>;
}

export const DEFAULT_CODE_AGENTS: CodeAgentsConfig = {
  default: 'auto',
  preferredExternal: null,
  providers: {
    builtin: { kind: 'builtin', enabled: true },
    dsh: { kind: 'dsh-acp', command: 'DeepSeek Harness.exe', enabled: true },
    codex: { kind: 'codex-cli', command: 'codex', enabled: true, sandboxMode: 'workspace-write', networkAccess: 'deny' },
    claude: { kind: 'claude-cli', command: 'claude', enabled: true },
  },
};

/** Merge persisted settings without allowing a partial object to erase defaults. */
export function normalizeCodeAgents(input: Partial<CodeAgentsConfig> | null | undefined): CodeAgentsConfig {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new Error('Invalid codeAgents configuration');
  for (const field of ['default', 'preferredExternal'] as const) {
    const value = input?.[field];
    if (value !== undefined && !(field === 'preferredExternal' && value === null)
      && (typeof value !== 'string' || !value.trim())) throw new Error(`Invalid codeAgents.${field}`);
  }
  if (input?.providers !== undefined && (input.providers === null || typeof input.providers !== 'object' || Array.isArray(input.providers))) throw new Error('Invalid codeAgents.providers');
  const providers: Record<string, CodeAgentProviderConfig> = Object.fromEntries(
    Object.entries(DEFAULT_CODE_AGENTS.providers).map(([id, config]) => [id, { ...config }]),
  );
  for (const [id, value] of Object.entries(input?.providers ?? {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid code agent provider configuration: ${id}`);
    for (const field of ['kind', 'command', 'profile', 'model', 'modelProvider', 'sandboxMode', 'networkAccess'] as const) {
      if (value[field] !== undefined && (typeof value[field] !== 'string' || !value[field]!.trim())) throw new Error(`Invalid code agent ${id}.${field}`);
    }
    if (value.sandboxMode !== undefined && value.sandboxMode !== 'read-only' && value.sandboxMode !== 'workspace-write') throw new Error(`Invalid code agent ${id}.sandboxMode`);
    if (value.networkAccess !== undefined && value.networkAccess !== 'deny' && value.networkAccess !== 'allow') throw new Error(`Invalid code agent ${id}.networkAccess`);
    if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`Invalid code agent ${id}.enabled`);
    for (const field of ['args', 'prefixArgs'] as const) {
      if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field]!.some(arg => typeof arg !== 'string'))) throw new Error(`Invalid code agent ${id}.${field}`);
    }
    // Persisted settings may intentionally omit kind when overriding a built-in
    // provider. Infer only that known provider's kind; never drop its options.
    const kind = typeof value.kind === 'string' ? value.kind : providers[id]?.kind;
    if (!kind) throw new Error(`Invalid code agent provider configuration: ${id} is missing kind`);
    if ((value.sandboxMode !== undefined || value.networkAccess !== undefined) && kind !== 'codex-cli') {
      throw new Error(`Codex sandbox settings are unsupported for provider ${id}`);
    }
    providers[id] = {
      ...providers[id],
      ...value,
      kind,
      args: value.args ? [...value.args] : providers[id]?.args,
      prefixArgs: value.prefixArgs ? [...value.prefixArgs] : providers[id]?.prefixArgs,
    };
  }
  return {
    default: input?.default ?? DEFAULT_CODE_AGENTS.default,
    preferredExternal: input?.preferredExternal ?? DEFAULT_CODE_AGENTS.preferredExternal,
    providers,
  };
}
