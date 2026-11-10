/** Lingxi application assembly: persona, local event source, behaviour, memory and background roles. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BaseMessage } from '@langchain/core/messages';
import { createModel, prepareMessages, protocolOf, type ProviderEntry } from 'lingxi-provider';
import type { Logger } from './contracts.ts';
import { seed, DEPLOYMENT, DISPLAY_NAME, SEED_ENDPOINT } from './seed.ts';
import { appLanguage as normalizeLanguage, modelLanguage } from './language.ts';
import { LingxiPersona } from './persona.ts';
import { Agents } from './agents/roles.ts';
import { behindState } from './behind.ts';
import { createCodeAgentAssembly } from './agents/code-agent-assembly.ts';
import { codeAgentIsolationEvidence, type CodeAgentAdapter } from './agents/code-agent.ts';
import type { CodeAgentsConfig } from './agents/code-agent-config.ts';
import { refreshCodeHome } from './agents/code-home.ts';
import { findDsh } from './agents/dsh.ts';
import { EMBED_MODEL } from './memory/embed.ts';
import { Rhythm, RHYTHM_DEFAULTS, SEE_PROMPT, WHERE_PROMPT } from './rhythm.ts';
import { glance } from './screen/look.ts';
import { closeInputFocusHelper } from './screen/win32.ts';
import { watchWorkarea, type WorkareaBody } from './daily/workarea.ts';
import { createPetWorld, type PetAssembly } from './pet/definition.ts';
import type { PetWorld } from './pet/world.ts';
import { API_FILE, apiAccess, startApi, type ActionSetting, type RuntimeSettings, type RuntimeSettingsChange, type WorkbenchSettings, type WorkbenchSettingsChange } from './pet/api.ts';
import { checkLibrary, libraryFromFigure, applyLibrary, clickActions, type ActionEntry } from './behavior/library.ts';
import { readActivity } from './runtime/activity.ts';
import { FrontStateJournal } from './runtime/front-state-journal.ts';
import { createLocalFront } from './runtime/local-app.ts';
import { runMemory } from './runtime/memory-runner.ts';
import { bindBodyInput } from './runtime/body-input.ts';
import { Consolidator } from './memory/consolidate.ts';
import { historySince } from './memory/events.ts';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const log: Logger = {
  debug: (message, fields) => console.debug(message, fields ?? ''),
  info: (message, fields) => console.info(message, fields ?? ''),
  warn: (message, fields) => console.warn(message, fields ?? ''),
  error: (message, fields) => console.error(message, fields ?? ''),
};

type AppConfig = {
  displayName?: string; language?: unknown; activeProvider?: string;
  worlds?: Record<string, { user?: string }>;
  context?: { maxTokens?: number; softRatio?: number; keepRatio?: number; firstTurn?: boolean };
  rounds?: { soft?: number; hard?: number };
  codeAgents?: { providers?: Record<string, Record<string, unknown>> };
  /** How she behaves in the world: obstacle avoidance is the person's switch, on unless turned off. */
  behavior?: { avoidance?: boolean };

};

function atomicJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(`${file}.tmp`, file);
}
function readSecret(file: string, name?: string): string {
  if (!name) return '';
  if (process.env[name]) return process.env[name]!;
  try {
    const line = readFileSync(file, 'utf8').split(/\r?\n/).find((row) => row.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/^(["'])(.*)\1$/, '$2') : '';
  } catch { return ''; }
}
function getProvider(home: string, config: AppConfig): { id: string; entry: ProviderEntry; key: string } {
  const id = config.activeProvider || SEED_ENDPOINT;
  const file = join(home, 'providers', id, 'config.json');
  const entry = JSON.parse(readFileSync(file, 'utf8')) as ProviderEntry;
  const key = readSecret(join(home, 'providers', id, '.env'), entry.secret);
  return { id, entry, key };
}
function writeSecret(file: string, name: string, value: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  let lines: string[] = [];
  try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith(`${name}=`)); } catch { /* create new file */ }
  lines.push(`${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}
function appEventsTrigger(event: { trigger?: string }): boolean {
  return event.trigger !== 'never' && event.trigger !== 'piggyback';
}

export interface NewBody { pet: PetAssembly; workarea: WorkareaBody }
export interface ApplicationHandle { close(): Promise<void> }
export async function main(opts: { newBody: NewBody; paused?: boolean; home: string; deployment?: string; modelsDir?: string }): Promise<ApplicationHandle> {
  const { newBody } = opts;
  const deployment = opts.deployment || DEPLOYMENT;
  const home = opts.home;
  const deployDir = join(home, deployment);
  const dataDir = join(deployDir, 'data');
  const memoryDir = join(deployDir, 'workspace');
  const modelsDir = opts.modelsDir;
  mkdirSync(dataDir, { recursive: true });
  seed(home, 'zh', deployment);
  const configFile = join(deployDir, 'config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as AppConfig;
  // Her figure and behaviour are already assembled, so the person's action changes go onto that same object and apply
  // to the next action; `pristineFigure` is what a reset puts back (the pack as it was read).
  const figure = newBody.pet.figure;
  const pristineFigure = structuredClone(figure);
  // The action library is a file in the deployment folder, edited with any editor; the pack only seeds it once.
  // Every read is checked: unusable entries are dropped with a note, a broken file falls back to the pack's own list,
  // and an empty library is a valid state (nothing for her to play).
  const libraryFile = join(deployDir, 'actions.json');
  const libraryProblems: string[] = [];
  let library: ActionEntry[] = [];
  const loadLibrary = (): void => {
    libraryProblems.splice(0, libraryProblems.length);
    if (!existsSync(libraryFile)) {
      library = libraryFromFigure(pristineFigure);
      atomicJson(libraryFile, library);
      return;
    }
    try {
      const checked = checkLibrary(JSON.parse(readFileSync(libraryFile, 'utf8')));
      library = checked.entries;
      libraryProblems.push(...checked.problems);
    } catch (error) {
      library = libraryFromFigure(pristineFigure);
      libraryProblems.push(`actions.json 读取失败：${(error as Error).message}`);
    }
  };
  loadLibrary();
  const clickActionsFor = (): string[] => clickActions(library);
  applyLibrary(figure, library);
  const dailyLayer = newBody.pet.daily as typeof newBody.pet.daily & { setClickActions?: (ids: readonly string[]) => void };
  dailyLayer?.setClickActions?.(clickActionsFor());
  const steering = newBody.pet.behavior as typeof newBody.pet.behavior & { setAvoidance?: (on: boolean) => void };
  steering.setAvoidance?.(config.behavior?.avoidance ?? true);
  const applyFigureSettings = (): void => {
    Object.assign(figure, structuredClone(pristineFigure));
    applyLibrary(figure, library);
  };
  const actionSettings = (): ActionSetting[] => library.map((entry) => ({ id: entry.id, clips: [...entry.clips], zh: [], about: entry.looks ?? '',
    when: entry.when ?? '', mood: [...(entry.mood ?? [])], source: 'person', fromPack: !!pristineFigure.words[entry.id] }));
  let selected = getProvider(home, config);
  let configured = !!selected.key;
  let paused = !!opts.paused || !configured;
  let frontModel = createModel(selected.entry, { apiKey: selected.key });
  let memoryEntry = { ...selected.entry, spec: { ...selected.entry.spec, thinking: false, reasoningEffort: 'none' } };
  const makeMemoryModel = () => createModel({ ...selected.entry, spec: { ...selected.entry.spec, thinking: false, reasoningEffort: 'none' } }, { apiKey: selected.key });
  let petWorld: PetWorld | null = null;
  let agents: Agents | null = null;
  let selectedCodeAgent: CodeAgentAdapter | null = null;
  let memoryTimer: NodeJS.Timeout | null = null;
  let stopWorkarea: (() => void) | null = null;
  let currentState: 'idle' | 'processing' | 'failed' = paused ? 'idle' : 'idle';
  let currentError = '';
  const language = () => normalizeLanguage(config.language);
  const userName = () => String(config.worlds?.['desktop-pet']?.user ?? '');
  const world = createPetWorld({ ...newBody.pet, userName, language: () => modelLanguage(language()), onQuestion: (question, state, channel) => {
    if (question.requestId) agents?.markPermissionQuestion(question, state, channel);
  }, onCreate: (created) => { petWorld = created; } }, 'UTC');
  petWorld = world;
  bindBodyInput(newBody.pet.link, () => petWorld);

  const persona = new LingxiPersona({ memoryDir, dataDir, ...(modelsDir ? { modelsDir: join(modelsDir, EMBED_MODEL.id) } : {}), log,
    ask: (system, text, image) => runMemory({ model: makeMemoryModel(), system, text, ...(image ? { image } : {}),
      sessionId: image ? 'memory-image' : 'memory', log, prepareMessages: (messages) => prepareMessages(messages, memoryEntry, { keepThinking: false }) }),
    ioTools: () => world.tools(),
  });
  persona.snapshot(process.env.LINGXI_VERSION ?? 'dev');
  const codeConfig = config.codeAgents as Partial<CodeAgentsConfig> | undefined;
  try {
    const drafts = join(memoryDir, 'control', 'drafts');
    mkdirSync(drafts, { recursive: true });
    const assembly = createCodeAgentAssembly({ config: codeConfig, dataDir, workspace: drafts,
      dshInstall: findDsh(), log: (message) => log.warn(message) });
    selectedCodeAgent = assembly.adapter;
    agents = new Agents({ dataDir, log, front: () => front?.source ?? null, model: () => frontModel,
      fileTools: () => persona.fileTools(), workspaceDir: memoryDir,
      say: async (line, motion) => {
        const result = await world.tools().find((tool) => tool.name === 'pet_say')!.handler({ script: `【${motion}】${line}`, hold: 12 }, { role: 'daily', log });
        return typeof result === 'string' || result.failed !== true;
      }, lastInteraction: () => persona.lastInteraction(), lookAt: (system, text, image) => persona.askImage(system, text, image),
      codeAgent: selectedCodeAgent, codeWorkspace: { cwd: join(memoryDir, 'control', 'drafts'), writableRoot: join(memoryDir, 'control', 'drafts') },
      prepareCode: () => refreshCodeHome(join(memoryDir, 'control', 'drafts'), APP_ROOT, memoryDir), frameworkControl: true,
    });
    persona.setAgents(agents);
  } catch (error) { log.error('Background roles could not be opened', { error }); }

  const currentModel = () => {
    try { return getProvider(home, config).entry.spec.model; } catch { return 'unknown'; }
  };
  const stateJournal = new FrontStateJournal(join(dataDir, 'front-state.sqlite'), (state) => {
    currentState = state.state;
    currentError = state.error ?? '';
    newBody.pet.link.send({ t: 'think', on: state.state === 'processing' } as never);
  });
  const front = createLocalFront({ model: frontModel, tools: persona.frontTools(world.tools()), log,
    eventFile: join(dataDir, 'events.sqlite'), checkpointPath: join(dataDir, 'conversation.sqlite'), sessionId: 'front',
    context: async ({ events }) => { await persona.onEvents(events); return persona.context(); },
    prepareMessages: (messages: BaseMessage[]) => prepareMessages(messages, selected.entry),
    onState: (state, detail) => { currentState = state; currentError = detail ?? ''; if (state === 'processing') stateJournal.processing([]);
      else if (state === 'idle') { stateJournal.idle([]); persona.onTurnEnded(); } else stateJournal.failed([], detail ?? 'unknown error'); },
    onUsage: (usage, sessionId) => { try { agents?.ledger.append({ role: 'front', actor: 'langchain', op: 'note', summary: 'model usage', why: JSON.stringify(usage), ref: sessionId }); } catch (error) { log.warn('Usage record failed', { error }); } },
    onWake: (event) => { if (!paused && appEventsTrigger(event)) void front.drain().catch((error) => log.warn('Front turn failed', { error })); },
  });
  const recordConfigChange = (changes: string[]): void => {
    if (!changes.length) return;
    void front.events.pushEvent({ type: 'app.config.changed', source: 'workbench', origin: 'internal',
      text: `[configuration changed] ${changes.join('; ')}`, meta: { kind: 'configuration-change', fields: changes } }, { trigger: 'piggyback' })
      .catch((error) => log.warn('Configuration change event could not be stored', { error }));
  };
  persona.setStore(front.events);
  await world.start({ pushEvent: (event, options) => front.events.pushEvent(event, options as never), store: front.events });
  if (agents) agents.start();
  const memory = persona.eventMemory;
  const consolidator = memory ? new Consolidator({ memory, ask: (system, text) => persona.askModel(system, text),
    cacheFile: join(dataDir, 'memory-llm-cache.jsonl'), ...(agents ? { judgments: agents.judgments } : {}), judge: 'front-provider' }) : null;
  if (memory) {
    const sync = () => { try { memory.sync(); } catch (error) { log.warn('Memory sync failed', { error }); return; }
      consolidator?.run().catch((error) => log.warn('Memory consolidation failed', { error }));
      persona.memoryVectors?.pass().catch((error) => log.warn('Memory vectors failed', { error })); };
    sync(); memoryTimer = setInterval(sync, 10 * 60_000); memoryTimer.unref();
  }
  persona.setLiveContext(() => {
    const body = world.state();
    return `[current state; time=${new Date().toISOString()}]\nYour name: ${config.displayName || DISPLAY_NAME}. What you call the person: ${userName() || '伙伴'}.\n`
      + `How your body feels: ${body.feeling || 'unknown'}. Front processing: ${currentState}${currentError ? ` (${currentError})` : ''}.`;
  });
  const envTemplate = readFileSync(fileURLToPath(new URL('./pet/ENV_PROMPT.md', import.meta.url)), 'utf8');
  persona.setEnvironment(() => envTemplate.replace(/\{\{([\w.]+)\}\}/g, (_all, key: string) => world.envPromptVars()[key] ?? ''));
  let rhythm: Rhythm | null = null;
  if (agents) {
    rhythm = new Rhythm({ glance: () => glance(), see: (jpeg, context) => persona.askImage(SEE_PROMPT, context, jpeg),
      note: (text) => persona.noteOwn(text, 'glance'), wake: (text) => persona.noteOwn(text, 'rhythm'),
      topicsToday: () => persona.topicsToday(), spokenToday: () => persona.spokenToday(),
      count: (outcome) => agents?.ledger.count('daily', 'rhythm', outcome) });
    agents.look = async (reminder) => { if (process.env.LINGXI_RHYTHM !== 'off') await rhythm?.beat(reminder.params ?? RHYTHM_DEFAULTS.params); };
    agents.petX = () => newBody.workarea.x();
    const screenAccess = process.env.LINGXI_SCREEN_ACCESS !== 'off';
    const workareaAccess = screenAccess || process.env.LINGXI_WORKAREA_ACCESS === 'on';
    if (workareaAccess) {
      const workarea = watchWorkarea({ dataDir, agents, body: newBody.workarea });
      agents.foreground = () => workarea.foreground(); agents.currentLook = () => workarea.currentLook(); stopWorkarea = () => workarea.stop();
    } else { agents.foreground = () => null; agents.currentLook = () => null; }
    if (screenAccess) agents.screen = async () => {
      const view = await glance();
      if ('away' in view) return `[nobody there] the screen is ${view.away === 'locked' ? 'locked' : 'idle'}`;
      let seen = '';
      try { seen = await persona.askImage(WHERE_PROMPT, view.foreground ?? '', view.jpeg); } catch { seen = '(could not read the picture)'; }
      const width = view.display?.width ?? 0;
      const span = (window: { rect: { x: number; width: number } }) => width ? ` — ${Math.round(window.rect.x / width * 100)}–${Math.round((window.rect.x + window.rect.width) / width * 100)}% of the width` : '';
      return [`What they are doing: ${seen}`, `In front: ${view.foregroundApp ?? 'unknown'} (${view.foreground ?? ''})`,
        `Windows on the screen in front (display ${view.display?.index ?? '?'}):`,
        ...view.windows.filter((window) => window.display === view.display?.index).slice(0, 10).map((window) => `${window.foreground ? '*' : '-'} ${window.title.slice(0, 70)}${span(window)}`),
        `The pet stands at ${newBody.workarea.x() === null ? 'an unknown spot' : `${Math.round(newBody.workarea.x()! * 100)}% of its screen width`}.`].join('\n');
    };
    else agents.screen = async () => '[screen access disabled]';
  }

  const access = apiAccess(dataDir);
  const baseWorkbenchSettings = (): Omit<WorkbenchSettings, 'behavior' | 'actions' | 'actionsApply' | 'actionLibrary' | 'actionLibraryFile' | 'libraryProblems'> => ({
    profile: { name: config.displayName || DISPLAY_NAME, user: userName(), constitution: persona.readConstitution() },
    conversation: { language: language(), context: { maxTokens: config.context?.maxTokens ?? 128_000, softRatio: config.context?.softRatio ?? .85,
      keepRatio: config.context?.keepRatio ?? .25, firstTurn: config.context?.firstTurn ?? false },
      rounds: { soft: config.rounds?.soft ?? 20, hard: config.rounds?.hard ?? 40 },
      apply: { context: '保存后立即用于后续请求。', rounds: '轮次设置在下次启动后生效。' } },
  });
  const workbenchSettings = (): WorkbenchSettings => {
    // The library is a file: reading the page re-reads it, so an edit shows up on the next refresh without a button.
    loadLibrary();
    applyFigureSettings();
    dailyLayer?.setClickActions?.(clickActionsFor());
    return {
    ...baseWorkbenchSettings(),
    behavior: { avoidance: config.behavior?.avoidance ?? true, apply: '保存后立即生效。' },
    actions: actionSettings(),
    actionsApply: '保存后立即用于新的动作。',
    actionLibrary: JSON.stringify(library, null, 2),
    actionLibraryFile: libraryFile,
    libraryProblems,
  };
  };
  const apiServer = await startApi(access, {
    status: () => { const body = world.state(); return { name: config.displayName || DISPLAY_NAME, paused, body: { connected: body.connected, x: body.x }, feeling: body.feeling,
      ...('feelingState' in body ? { feelingState: body.feelingState } : {}), front: { state: currentState, inputCursors: [], ...(currentError ? { error: currentError } : {}) },
      model: { name: currentModel(), configured } }; },
    behind: () => agents ? { ...behindState(agents), codeAgentIsolation: codeAgentIsolationEvidence(selectedCodeAgent) } : null,
    settings: () => ({ name: config.displayName || DISPLAY_NAME, user: userName() }),
    runtimeSettings: (): RuntimeSettings => ({ model: { provider: config.activeProvider || SEED_ENDPOINT, protocol: protocolOf(selected.entry), apiUrl: selected.entry.baseUrl,
      model: selected.entry.spec.model, keyConfigured: configured }, executor: { provider: null, sandboxMode: null, networkAccess: null, taskDirectory: agents ? join(memoryDir, 'control', 'drafts') : null,
      description: codeAgentIsolationEvidence(selectedCodeAgent)?.detail ?? '没有已配置的代码执行器。' },
      apply: { model: { requiresRestart: false, message: '保存后立即用于下一次模型请求。' }, executor: { requiresRestart: true, message: '执行器更改将在下次启动后生效。' } } }),
    saveRuntimeSettings: (change: RuntimeSettingsChange): RuntimeSettings => {
      const modelChange = change.model ?? {};
      const configChanges: string[] = [];
      if (Object.keys(modelChange).length) {
        const entry = structuredClone(selected.entry);
        if (modelChange.protocol !== undefined && modelChange.protocol !== protocolOf(selected.entry)) { entry.options = { ...entry.options, protocol: modelChange.protocol as NonNullable<ProviderEntry['options']>['protocol'] }; configChanges.push('model protocol updated'); }
        if (modelChange.apiUrl !== undefined && modelChange.apiUrl !== selected.entry.baseUrl) { entry.baseUrl = modelChange.apiUrl; configChanges.push('model endpoint updated'); }
        if (modelChange.model !== undefined && modelChange.model !== selected.entry.spec.model) { entry.spec = { ...entry.spec, model: modelChange.model }; configChanges.push('model name updated'); }
        if (modelChange.apiKey !== undefined && modelChange.apiKey !== '') {
          const secretName = entry.secret || 'LINGXI_API_KEY';
          entry.secret = secretName;
          writeSecret(join(home, 'providers', selected.id, '.env'), secretName, modelChange.apiKey);
          process.env[secretName] = modelChange.apiKey;
          configChanges.push('model credentials updated');
        }
        atomicJson(join(home, 'providers', selected.id, 'config.json'), entry);
        const key = modelChange.apiKey && modelChange.apiKey !== '' ? modelChange.apiKey : selected.key;
        selected = { ...selected, entry, key };
        configured = !!key;
        memoryEntry = { ...entry, spec: { ...entry.spec, thinking: false, reasoningEffort: 'none' } };
        frontModel = createModel(entry, { apiKey: key });
        front.setModel(frontModel);
        if (configured && !opts.paused) {
          paused = false;
          if (front.events.pending().some((event) => event.contextDelivery !== 'archive-only')) void front.drain().catch((error) => log.warn('Front resume failed', { error }));
        } else if (!configured) paused = true;
      }
      if (change.executor && Object.keys(change.executor).length) {
        const codex = config.codeAgents?.providers?.codex ?? {};
        config.codeAgents ??= { providers: {} };
        config.codeAgents.providers ??= {};
        config.codeAgents.providers.codex = { ...codex,
          ...(change.executor.sandboxMode !== undefined ? { sandboxMode: change.executor.sandboxMode } : {}),
          ...(change.executor.networkAccess !== undefined ? { networkAccess: change.executor.networkAccess } : {}) };
        atomicJson(configFile, config);
      }
      recordConfigChange(configChanges);
      return { model: { provider: config.activeProvider || SEED_ENDPOINT, protocol: protocolOf(selected.entry), apiUrl: selected.entry.baseUrl,
        model: selected.entry.spec.model, keyConfigured: configured }, executor: { provider: selectedCodeAgent?.id ?? null,
        sandboxMode: null, networkAccess: null, taskDirectory: agents ? join(memoryDir, 'control', 'drafts') : null,
        description: codeAgentIsolationEvidence(selectedCodeAgent)?.detail ?? '没有已配置的代码执行器。' },
        apply: { model: { requiresRestart: false, message: '保存后立即用于下一次模型请求。' }, executor: { requiresRestart: true, message: '执行器更改将在下次启动后生效。' } } };
    },
    workbenchSettings, saveWorkbenchSettings: async (change: WorkbenchSettingsChange) => {
      const profile = change.profile; const conversation = change.conversation;
      const configChanges: string[] = [];
      if (profile?.constitution !== undefined && profile.constitution !== persona.readConstitution()) { await persona.saveConstitution(profile.constitution); configChanges.push('persona instructions updated'); }
      if (profile?.name !== undefined && profile.name !== (config.displayName || DISPLAY_NAME)) { config.displayName = profile.name; configChanges.push('display name updated'); }
      if (profile?.user !== undefined && profile.user !== userName()) { config.worlds ??= {}; config.worlds['desktop-pet'] = { ...config.worlds['desktop-pet'], user: profile.user }; configChanges.push('person address updated'); }
      if (conversation?.language !== undefined && conversation.language !== config.language) { config.language = conversation.language; configChanges.push('conversation language updated'); }
      if (conversation?.context) {
        const next = { ...config.context, ...conversation.context };
        if (JSON.stringify(next) !== JSON.stringify(config.context ?? {})) { config.context = next; configChanges.push('conversation context updated'); }
      }
      if (conversation?.rounds) {
        const next = { ...config.rounds, ...conversation.rounds };
        if (JSON.stringify(next) !== JSON.stringify(config.rounds ?? {})) { config.rounds = next; configChanges.push('conversation rounds updated'); }
      }
      if (change.behavior?.avoidance !== undefined && change.behavior.avoidance !== (config.behavior?.avoidance ?? true)) {
        config.behavior = { ...(config.behavior ?? {}), avoidance: change.behavior.avoidance };
        steering.setAvoidance?.(change.behavior.avoidance);
        configChanges.push('obstacle avoidance updated');
      }
      atomicJson(configFile, config); recordConfigChange(configChanges); return workbenchSettings();
    },
    asks: () => world.pendingAsks(), memory: () => memory ? { available: true, episodes: memory.episodesSince(Date.now() - 7 * 86_400_000).slice(-40) } : { available: false, episodes: [] },
    history: () => { memory?.sync(); return memory ? { available: true, cursor: front.events.latestCursor(), lines: memory.recentLines(80) } : { available: false, lines: [] }; },
    historySince: (after) => historySince(front.events, after), outputs: (after) => world.outputs(after), outputReceipt: (id) => world.outputReceipt(id),
    activity: (cursor, limit) => readActivity(front.events, cursor, limit), tasks: () => agents ? behindState(agents) : null,
    noteTask: (id, note) => agents?.bus.update(id, note) ?? false, cancelTask: (id) => agents?.bus.cancel(id) ?? false,
    recoverTask: (id, action) => agents?.bus.recover(id, action) ?? false,
    say: (text) => world.typed(text), answer: (question, text, id) => world.answered(question, text, id),
    revoke: (kind) => { const revoked = agents?.permissionRules.remove(kind) ?? false; return { revoked, behind: agents ? behindState(agents) : null }; },
    save: (change) => { if (change.name !== undefined) config.displayName = change.name; if (change.user !== undefined) { config.worlds ??= {}; config.worlds['desktop-pet'] = { ...config.worlds['desktop-pet'], user: change.user }; } atomicJson(configFile, config); return { name: config.displayName || DISPLAY_NAME, user: userName() }; },
  });
  log.info(`Local API ready at http://127.0.0.1:${access.port}/lingxi/ (${join(dataDir, API_FILE)})`);

  let closePromise: Promise<void> | null = null;
  const stop = () => closePromise ??= (async () => {
    paused = true;
    front.events.setOnWake(null);
    if (memoryTimer) clearInterval(memoryTimer);
    stopWorkarea?.();
    await closeInputFocusHelper();
    try { await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve())); }
    finally { try { await agents?.closeAsync(); } finally {
      try { await front.waitForIdle(); } finally { try { await world.stop(); } finally { try { await front.close(); } finally { await persona.close(); stateJournal.close(); } } }
    } }
  })();
  if (!paused && configured) void front.drain().catch((error) => log.warn('Front startup drain failed', { error }));
  return { close: stop };
}
