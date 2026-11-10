import assert from 'node:assert/strict';
import test from 'node:test';
import { hasStoredSecret, mergeStandaloneDeployment } from '../tools/standalone-config.mjs';

test('standalone reopen keeps model and Codex settings while refreshing only the web port', () => {
  const saved = {
    displayName: '小灵',
    activeProvider: 'local',
    web: { port: 1234, theme: 'night' },
    providersMarker: 'preserved',
    codeAgents: { default: 'codex', providers: { codex: { sandboxMode: 'read-only', networkAccess: 'deny', command: 'codex-custom' } } },
  };
  const next = mergeStandaloneDeployment(saved, 5678);
  assert.equal(next.displayName, '小灵');
  assert.equal(next.providersMarker, 'preserved');
  assert.deepEqual(next.web, { port: 5678, theme: 'night' });
  assert.deepEqual(next.codeAgents.providers.codex, {
    kind: 'codex-cli', command: 'codex-custom', enabled: true, sandboxMode: 'read-only', networkAccess: 'deny',
  });
});

test('standalone defaults fill missing Codex sandbox settings without replacing saved values', () => {
  const next = mergeStandaloneDeployment({ codeAgents: { providers: { codex: { kind: 'codex-cli', command: 'codex' } } } }, 5678);
  assert.equal(next.codeAgents.providers.codex.sandboxMode, 'workspace-write');
  assert.equal(next.codeAgents.providers.codex.networkAccess, 'deny');
  assert.equal(next.codeAgents.providers.codex.command, 'codex');
});

test('stored API key detection recognizes only a non-empty exact variable assignment', () => {
  assert.equal(hasStoredSecret('# LINGXI_LOCAL_KEY=old\nLINGXI_LOCAL_KEY=secret-value\n', 'LINGXI_LOCAL_KEY'), true);
  assert.equal(hasStoredSecret('OTHER_KEY=secret-value\nLINGXI_LOCAL_KEY=\n', 'LINGXI_LOCAL_KEY'), false);
});
