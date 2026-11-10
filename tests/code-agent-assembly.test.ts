import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCodeAgentAssembly } from '../core/agents/code-agent-assembly.ts';
import { CodeAgentKeeper } from '../core/agents/code-agent-keeper.ts';
import { codeAgentIsolationEvidence, type CodeTask } from '../core/agents/code-agent.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-code-agent-assembly.mjs', import.meta.url));
const runOptions = { shouldStop: () => false, onPermission: async () => false };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lingxi-code-assembly-'));
  const workspace = join(root, 'controlled-workspace');
  mkdirSync(workspace);
  const task: CodeTask = { id: 'task', incidentId: 'incident', prompt: '--literal-prompt', cwd: workspace,
    writableRoot: workspace, readRoots: [workspace], network: 'deny', acceptance: [] };
  return { root, workspace, task };
}

describe('code agent assembly', () => {
  it('does not inspect an external installation during normal application assembly', () => {
    const { root, workspace } = fixture();
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace,
      get dshInstall(): never { throw new Error('An unselected external installation must not be inspected'); },
    });
    expect(assembly.adapter?.id).toBe('builtin');
  });

  it('passes configured DSH model, route, profile and home through the existing Keeper to ACP', async () => {
    const { root, workspace, task } = fixture();
    const dshHome = join(root, 'app-owned-dsh-home');
    mkdirSync(join(dshHome, 'profiles', 'controlled-profile'), { recursive: true });
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshHome,
      dshInstall: { exe: process.execPath, cli: FAKE },
      config: { default: 'dsh', providers: { dsh: { kind: 'dsh-acp', profile: 'controlled-profile', model: 'controlled-model', modelProvider: 'controlled-route' } } },
    });
    const keeper = new CodeAgentKeeper({ backend: () => assembly.adapter });
    try {
      const out = await keeper.run(task, runOptions);
      expect(out).toMatchObject({ status: 'succeeded', ref: { provider: 'dsh' } });
      expect(JSON.parse(out.summary)).toMatchObject({ argv: ['--profile', 'controlled-profile', '--patch', join(root, 'dsh-code.patch.yml')], dshHome });
      const overlay = readFileSync(join(root, 'dsh-code.patch.yml'), 'utf8');
      expect(overlay).toContain('provider: "controlled-route"');
      expect(overlay).toContain('model: "controlled-model"');
      expect(overlay).toContain(workspace.replace(/\\/g, '/'));
      expect(readFileSync(join(dshHome, 'profiles', 'controlled-profile', 'node_modules', 'lingxi-read-fence', 'package.json'), 'utf8')).toContain('lingxi-read-fence');
    } finally { await keeper.stop(); }
  });

  it('passes configured Codex model/profile/command/args to an actual controlled child process', async () => {
    const { root, workspace, task } = fixture();
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { default: 'codex', providers: { codex: { kind: 'codex-cli', command: process.execPath, prefixArgs: [FAKE], model: 'chosen-model', profile: 'chosen-profile',
        sandboxMode: 'read-only', networkAccess: 'deny', args: ['--color', 'never'] } } },
    });
    const adapter = assembly.adapter!;
    const result = await adapter.run(task, runOptions);
    expect(JSON.parse(result.summary).argv).toEqual(['--ask-for-approval', 'never', '--model', 'chosen-model', '--profile', 'chosen-profile',
      '--config', 'sandbox_workspace_write.network_access=false', 'exec', '--skip-git-repo-check', '--json', '--sandbox', 'read-only', '--color', 'never', '--', '--literal-prompt']);
    const keeper = new CodeAgentKeeper({ backend: () => adapter });
    try { await expect(keeper.run(task, runOptions)).resolves.toMatchObject({ status: 'succeeded' }); }
    finally { await keeper.stop(); }
  });

  it('passes Claude model and advertised resume id without inventing a profile flag', async () => {
    const { root, workspace, task } = fixture();
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { default: 'claude', providers: { claude: { kind: 'claude-cli', command: process.execPath, prefixArgs: [FAKE], model: 'chosen-claude' } } } });
    const result = await assembly.adapter!.run({ ...task, resume: { provider: 'claude', runId: 'local-run', sessionId: 'provider-session' } }, runOptions);
    expect(JSON.parse(result.summary).argv).toEqual(['--resume', 'provider-session', '--model', 'chosen-claude', '-p', '--literal-prompt',
      '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk']);
  });

  it('keeps missing and disabled providers explicit instead of selecting another provider', async () => {
    const { root, workspace } = fixture();
    const missing = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: { default: 'dsh' } });
    expect(missing.adapter?.id).toBe('dsh');
    expect(await missing.adapter?.detect()).toMatchObject({ available: false, reason: expect.stringContaining('not found') });
    const builtin = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: {} });
    expect(await builtin.adapter?.detect()).toMatchObject({ id: 'builtin', available: false });
    // A deployment with no executor config follows the auto policy: the built-in one, never a silent DSH.
    const legacy = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null });
    expect(legacy.adapter?.id).toBe('builtin');
    expect(await legacy.adapter?.detect()).toMatchObject({ id: 'builtin', available: false });
    const disabled = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { default: 'dsh', providers: { dsh: { kind: 'dsh-acp', enabled: false } } } });
    expect(disabled.adapter).toBeNull();
  });

  it('reports configured isolation separately from end-to-end verification', () => {
    const { root, workspace } = fixture();
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: { exe: process.execPath, cli: FAKE }, config: { default: 'dsh' } });
    expect(codeAgentIsolationEvidence(assembly.adapter)).toMatchObject({ provider: 'dsh', source: 'dsh-configuration',
      reported: { sandbox: true, networkPolicy: true }, verification: { sandbox: 'unverified', networkPolicy: 'unverified' } });
    expect(codeAgentIsolationEvidence(null)).toBeNull();
    const cli = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: { default: 'codex' } });
    expect(codeAgentIsolationEvidence(cli.adapter)).toMatchObject({ provider: 'codex', source: 'unclaimed',
      reported: { sandbox: true, networkPolicy: true }, verification: { sandbox: 'unverified', networkPolicy: 'unverified' } });
  });

  it('rejects unsupported configuration instead of silently dropping options', () => {
    const { root, workspace } = fixture();
    expect(() => createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { providers: { claude: { kind: 'claude-cli', profile: 'unsupported' } } } })).toThrow('does not support a profile');
    expect(() => createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { providers: { custom: { enabled: false } } as never } })).toThrow('missing kind');
    expect(() => createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: 'dsh' as never })).toThrow('Invalid codeAgents configuration');
    expect(() => createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: { providers: null as never } })).toThrow('Invalid codeAgents.providers');
    expect(() => createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: { providers: {
      codex: { kind: 'codex-cli', model: 'one', args: ['--model=another'] },
    } } })).toThrow('model is specified in both');
  });

  it('retains overrides without kind for a known provider instead of silently using defaults', () => {
    const { root, workspace } = fixture();
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null,
      config: { default: 'dsh', providers: { dsh: { enabled: false, model: 'requested-model' } } as never } });
    expect(assembly.config.providers.dsh).toMatchObject({ kind: 'dsh-acp', enabled: false, model: 'requested-model' });
    expect(assembly.adapter).toBeNull();
  });

  it('rejects a workspace that contains the Host data directory', () => {
    const { root } = fixture();
    expect(() => createCodeAgentAssembly({ workspace: root, dataDir: join(root, 'private-data'), dshInstall: null })).toThrow('separate controlled directory');
  });

  it('does not start another provider or a fresh run for an unsupported resume', async () => {
    const { root, workspace, task } = fixture();
    let runs = 0;
    const assembly = createCodeAgentAssembly({ dataDir: root, workspace, dshInstall: null, config: {}, builtinExecutor: {
      capabilities: { sandbox: true, networkPolicy: true },
      run: async () => { runs++; return { ref: { provider: 'builtin', runId: 'new' }, status: 'succeeded', summary: '', resumed: false }; },
    } });
    const keeper = new CodeAgentKeeper({ backend: () => assembly.adapter });
    try {
      await expect(keeper.run({ ...task, resume: { provider: 'dsh', runId: 'old' } }, runOptions)).rejects.toThrow('code agent mismatch');
      await expect(keeper.run({ ...task, resume: { provider: 'builtin', runId: 'old' } }, runOptions)).rejects.toThrow('does not support resuming');
      expect(runs).toBe(0);
      expect((await keeper.run(task, runOptions)).status).toBe('succeeded');
      expect(runs).toBe(1);
    } finally { await keeper.stop(); }
  });
});
