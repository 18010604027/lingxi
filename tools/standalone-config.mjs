export function mergeStandaloneDeployment(priorConfig, webPort) {
  const defaults = {
    displayName: '灵犀', language: 'zh', activeProvider: 'local',
    web: { port: webPort, theme: 'mint' }, paths: { memory: 'workspace', data: 'data' },
    worlds: { pet: { enabled: true } },
    codeAgents: { default: 'codex', preferredExternal: null, providers: {
      codex: { kind: 'codex-cli', command: 'codex', enabled: true, sandboxMode: 'workspace-write', networkAccess: 'deny' },
      dsh: { kind: 'dsh-acp', enabled: false },
    } },
  };
  const prior = priorConfig && typeof priorConfig === 'object' && !Array.isArray(priorConfig) ? priorConfig : {};
  const codeAgents = prior.codeAgents && typeof prior.codeAgents === 'object' && !Array.isArray(prior.codeAgents) ? prior.codeAgents : {};
  const providers = codeAgents.providers && typeof codeAgents.providers === 'object' && !Array.isArray(codeAgents.providers) ? codeAgents.providers : {};
  const codex = providers.codex && typeof providers.codex === 'object' && !Array.isArray(providers.codex) ? providers.codex : {};
  return {
    ...defaults,
    ...prior,
    web: { ...defaults.web, ...(prior.web && typeof prior.web === 'object' ? prior.web : {}), port: webPort },
    codeAgents: {
      ...defaults.codeAgents,
      ...codeAgents,
      providers: { ...defaults.codeAgents.providers, ...providers,
        codex: { ...defaults.codeAgents.providers.codex, ...codex } },
    },
  };
}

export function hasStoredSecret(contents, secretName) {
  return contents.split(/\r?\n/).some((line) => {
    const separator = line.indexOf('=');
    return separator > 0 && line.slice(0, separator).trim() === secretName && line.slice(separator + 1).trim().length > 0;
  });
}
