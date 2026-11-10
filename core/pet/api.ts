/**
 * The application's local API for the independent workbench and optional clients. It listens on
 * 127.0.0.1 only and every request carries the token (`X-Lingxi-Token`); the port and token are kept in the data
 * directory (`lingxi-api.json`, made on first start). Clients connect through their local host bridge.
 *
 *   GET  /lingxi/status    her name, whether she is paused, the body (there or not, where), how she feels
 *   GET  /lingxi/behind    what the roles behind her are doing (behind.ts), null when they are not running
 *   GET  /lingxi/settings  what she is called and what she calls the person
 *   GET  /lingxi/asks      the questions she asked that the person has not answered yet (newest last); permission-linked rows carry requestId
 *   GET  /lingxi/memory    what she remembers lately: her topic cards of the last days, newest last
 *   GET  /lingxi/history   recent interaction lines from the shared EventMemory projection
 *   GET  /lingxi/history-since?after=<cursor>  newly projected interaction events after a cursor
 *   GET  /lingxi/outputs?after=<cursor>  durable text and actual channel receipts, independent of body playback
 *   POST /lingxi/output-receipt { id }: this workbench rendered the output while visible; not proof of reading
 *   GET  /lingxi/tasks      current and recent task projections
 *   POST /lingxi/task-note  { id, note }: add a user clarification to an open task
 *   POST /lingxi/task-cancel { id }: request cancellation of an open task
 *   POST /lingxi/task-recover { id, action }: explicitly resume or abandon an interrupted task
 *   POST /lingxi/say       { text }: the person says something to her; she hears it at once
 *   POST /lingxi/answer    { question, text, questionId? }: the person answers a question she asked; questionId deduplicates retries and requestId is an optional UI association
 *   POST /lingxi/revoke    { kind }: take back a "same kind from now on" the back was allowed (the behind panel's
 *                          revoke); answers the fresh behind state
 *   POST /lingxi/settings  { name?, user? }: what she is called and what she calls the person; saved and answered back
 *
 * The model's key is not here: how she reaches a model is DSH's own connection (the person's call, 10-28).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';

export const API_FILE = 'lingxi-api.json';
export const API_PORT = 4317;
/** Longest message taken, in characters. */
const TEXT_MAX = 2000;

/** Supplied by the running host; an absent value means the processing state is unknown. */
export interface FrontState { state: 'idle' | 'processing' | 'failed'; inputCursors: number[]; error?: string; updatedAt?: string }

export interface ApiDeps {
  status(): { name: string; paused: boolean; body: { connected: boolean; x: number }; feeling: string; feelingState?: { codes: string[]; text: string; summary: string }; model?: { name: string; configured: boolean }; front?: FrontState };
  behind(): unknown;
  settings(): { name: string; user: string };
  /** Current model connection without returning the secret itself. */
  runtimeSettings?(): RuntimeSettings;
  /** Workbench-only profile, character and conversation settings. */
  workbenchSettings?(): WorkbenchSettings;
  saveWorkbenchSettings?(change: WorkbenchSettingsChange): Promise<WorkbenchSettings> | WorkbenchSettings;
  /** Persists model connection fields; an empty apiKey keeps the stored secret. */
  saveRuntimeSettings?(change: RuntimeSettingsChange): RuntimeSettings;
  /** Questions waiting for an answer; the page draws a button for each option. */
  asks(): unknown;
  /** What she remembers lately; `available: false` while the memory is not open. */
  memory(): unknown;
  history(): unknown;
  historySince?(after: number): unknown;
  outputs?(after: number): unknown;
  activity?(cursor?: string, limit?: number): unknown | Promise<unknown>;
  outputReceipt?(id: string): Promise<boolean>;
  tasks(): unknown;
  noteTask(id: string, note: string): boolean;
  cancelTask(id: string): boolean;
  recoverTask(id: string, action: 'resume' | 'cancel'): boolean;
  say(text: string): Promise<boolean>;
  answer(question: string, text: string, questionId?: string): Promise<boolean>;
  /** Takes a kind of permission back; `behind` is the state afterwards, for the panel to draw. */
  revoke(kind: string): { revoked: boolean; behind: unknown };
  /** Writes what changed and answers the settings as they now are; a field left out keeps its value. */
  save(change: { name?: string; user?: string }): { name: string; user: string };
}

export interface ActionSetting {
  id: string;
  /** The clips this action plays, as set now (the person's override, or the pack's). */
  clips: string[];
  zh: string[];
  /** Free mood tags the action carries, if the pack or the person set any. */
  mood: string[];
  /** Whether this row comes from the pack or was changed here (person), so the page can offer a reset. */
  source: 'pack' | 'person';
  about: string;
  when: string;
}

export interface WorkbenchSettings {
  profile: { name: string; user: string; constitution: string };
  conversation: {
    language: 'zh' | 'en';
    context: { maxTokens: number; softRatio: number; keepRatio: number; firstTurn: boolean };
    rounds: { soft: number; hard: number };
    apply: { context: string; rounds: string };
  };
  /** How she behaves in the world; `apply` says when a change takes effect. */
  behavior: { avoidance: boolean; apply: string };
  /** The pack's actions as they are now, for the settings page to edit. */
  actions: ActionSetting[];
  actionsApply: string;
  /** The person's action library as text (read-only here; it is a file on disk). */
  actionLibrary: string;
  /** Where that file is. */
  actionLibraryFile: string;
  /** Entries dropped while loading the library, with the reason. */
  libraryProblems: string[];
}

export interface WorkbenchSettingsChange {
  profile?: { name?: string; user?: string; constitution?: string };
  conversation?: {
    language?: 'zh' | 'en';
    context?: Partial<WorkbenchSettings['conversation']['context']>;
    rounds?: Partial<WorkbenchSettings['conversation']['rounds']>;
  };
  behavior?: { avoidance?: boolean };
  /** Per-action changes by action id; null puts that action back to the pack's values. */
  actions?: Record<string, { clips?: string[]; zh?: string[]; mood?: string[]; about?: string; when?: string } | null>;

}

export interface RuntimeSettings {
  model: { provider: string; protocol: string; apiUrl: string; model: string | null; keyConfigured: boolean };
  executor: { provider: string | null; sandboxMode: string | null; networkAccess: string | null; taskDirectory: string | null; description: string };
  apply: {
    model: { requiresRestart: boolean; message: string };
    executor: { requiresRestart: boolean; message: string };
  };
}

export interface RuntimeSettingsChange {
  model?: { protocol?: string; apiUrl?: string; model?: string; apiKey?: string };
  executor?: { provider?: string; sandboxMode?: string; networkAccess?: string };
}

/** The port and token, made the first time and kept. */
export function apiAccess(dataDir: string): { port: number; token: string } {
  const file = join(dataDir, API_FILE);
  if (existsSync(file)) {
    let kept: { port?: unknown; token?: unknown } | undefined;
    try { kept = JSON.parse(readFileSync(file, 'utf8')) as { port?: unknown; token?: unknown }; }
    catch { /* made again below */ }
    if (kept && typeof kept.token === 'string' && kept.token.length >= 32) {
      if (typeof kept.port !== 'number' || !Number.isInteger(kept.port) || kept.port < 1 || kept.port > 65535) {
        throw new Error('Invalid port in local API access file');
      }
      return { port: kept.port, token: kept.token };
    }
  }
  const access = { port: API_PORT, token: randomBytes(24).toString('hex') };
  writeFileSync(file, `${JSON.stringify(access, null, 2)}\n`, { mode: 0o600 });
  return access;
}

const sameToken = (got: unknown, token: string) => {
  if (typeof got !== 'string') return false;
  const candidate = Buffer.from(got);
  const expected = Buffer.from(token);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
};

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, TEXT_MAX) : '');

/** Starts the API; resolves to the server once it listens. */
export async function startApi(access: { port: number; token: string }, deps: ApiDeps): Promise<Server> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    if (!sameToken(req.headers['x-lingxi-token'], access.token)) { send(401, { error: 'unauthorized' }); return; }
    const path = (req.url ?? '').split('?')[0];
    void (async () => {
      if (req.method === 'GET' && path === '/lingxi/status') return send(200, deps.status());
      if (req.method === 'GET' && path === '/lingxi/behind') return send(200, deps.behind());
      if (req.method === 'GET' && path === '/lingxi/settings') return send(200, deps.settings());
      if (req.method === 'GET' && path === '/lingxi/workbench-settings') {
        return deps.workbenchSettings ? send(200, deps.workbenchSettings()) : send(501, { error: 'workbench settings unavailable' });
      }
      if (req.method === 'GET' && path === '/lingxi/runtime-settings') {
        return deps.runtimeSettings ? send(200, deps.runtimeSettings()) : send(501, { error: 'runtime settings unavailable' });
      }
      if (req.method === 'GET' && path === '/lingxi/asks') return send(200, deps.asks());
      if (req.method === 'GET' && path === '/lingxi/memory') return send(200, deps.memory());
      if (req.method === 'GET' && path === '/lingxi/history') return send(200, deps.history());
      if (req.method === 'GET' && path === '/lingxi/activity') {
        const query = new URL(req.url ?? '', 'http://localhost').searchParams;
        const cursor = query.get('cursor') ?? undefined;
        const rawLimit = query.get('limit');
        if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)) || Number(rawLimit) < 1)) return send(400, { error: 'invalid page size' });
        return deps.activity ? send(200, await deps.activity(cursor, rawLimit === null ? undefined : Number(rawLimit))) : send(501, { error: 'activity unavailable' });
      }
      if (req.method === 'GET' && path === '/lingxi/outputs') {
        const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('after') ?? '0';
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return send(400, { error: 'invalid cursor' });
        return deps.outputs ? send(200, deps.outputs(Number(raw))) : send(501, { error: 'shared output unavailable' });
      }
      if (req.method === 'POST' && path === '/lingxi/output-receipt') {
        const body = await readJson(req);
        const id = text(body?.id);
        if (!id) return send(400, { error: 'id is empty' });
        return deps.outputReceipt ? send(200, { recorded: await deps.outputReceipt(id) }) : send(501, { error: 'shared output unavailable' });
      }
      if (req.method === 'GET' && path === '/lingxi/history-since') {
        const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('after');
        if (raw === null || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return send(400, { error: 'invalid cursor' });
        return deps.historySince ? send(200, deps.historySince(Number(raw))) : send(501, { error: 'incremental history unavailable' });
      }
      if (req.method === 'GET' && path === '/lingxi/tasks') return send(200, deps.tasks());
      if (req.method === 'POST' && (path === '/lingxi/say' || path === '/lingxi/answer')) {
        const body = await readJson(req);
        const said = text(body?.text);
        if (!said) return send(400, { error: 'text is empty' });
        if (path === '/lingxi/say') return send(200, { delivered: await deps.say(said) });
        const question = text(body?.question);
        if (!question) return send(400, { error: 'question is empty' });
        const questionId = text(body?.questionId) || undefined;
        return send(200, { delivered: await deps.answer(question, said, questionId) });
      }
      if (req.method === 'POST' && path === '/lingxi/revoke') {
        const body = await readJson(req);
        const kind = text(body?.kind);
        if (!kind) return send(400, { error: 'kind is empty' });
        return send(200, deps.revoke(kind));
      }
      if (req.method === 'POST' && (path === '/lingxi/task-note' || path === '/lingxi/task-cancel')) {
        const body = await readJson(req);
        const id = text(body?.id);
        if (!id) return send(400, { error: 'id is empty' });
        if (path === '/lingxi/task-note') {
          const note = text(body?.note);
          if (!note) return send(400, { error: 'note is empty' });
          return send(200, { updated: deps.noteTask(id, note) });
        }
        return send(200, { cancelling: deps.cancelTask(id) });
      }
      if (req.method === 'POST' && path === '/lingxi/task-recover') {
        const body = await readJson(req);
        const id = text(body?.id);
        const action = body?.action === 'resume' || body?.action === 'cancel' ? body.action : null;
        if (!id || !action) return send(400, { error: 'id and action are required' });
        return send(200, { recovered: deps.recoverTask(id, action) });
      }
      if (req.method === 'POST' && path === '/lingxi/settings') {
        const body = await readJson(req);
        const name = body?.name === undefined ? undefined : text(body.name).slice(0, 40);
        const user = body?.user === undefined ? undefined : text(body.user).slice(0, 40);
        if (name === '' || user === '') return send(400, { error: 'a name cannot be empty' });
        if (name === undefined && user === undefined) return send(400, { error: 'nothing to change' });
        return send(200, deps.save({ ...(name !== undefined ? { name } : {}), ...(user !== undefined ? { user } : {}) }));
      }
      if (req.method === 'POST' && path === '/lingxi/workbench-settings') {
        if (!deps.saveWorkbenchSettings) return send(501, { error: 'workbench settings unavailable' });
        const body = await readJson(req);
        const profile = body?.profile;
        const conversation = body?.conversation;
        if (profile !== undefined && (!profile || typeof profile !== 'object' || Array.isArray(profile))) return send(400, { error: 'invalid profile settings' });
        if (conversation !== undefined && (!conversation || typeof conversation !== 'object' || Array.isArray(conversation))) return send(400, { error: 'invalid conversation settings' });
        const p = profile as Record<string, unknown> | undefined;
        const c = conversation as Record<string, unknown> | undefined;
        const clean = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
        const name = p?.name === undefined ? undefined : clean(p.name);
        const user = p?.user === undefined ? undefined : clean(p.user);
        const constitution = p?.constitution === undefined ? undefined : clean(p.constitution);
        if ((p?.name !== undefined && !name) || (p?.user !== undefined && !user) || (p?.constitution !== undefined && !constitution)) return send(400, { error: 'profile settings cannot be empty' });
        if ((name?.length ?? 0) > 40 || (user?.length ?? 0) > 40 || (constitution?.length ?? 0) > 12_000) return send(400, { error: 'profile setting is too long' });
        const language = c?.language === 'zh' || c?.language === 'en' ? c.language : undefined;
        if (c?.language !== undefined && language === undefined) return send(400, { error: 'unsupported language' });
        const number = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
        const context = c?.context && typeof c.context === 'object' && !Array.isArray(c.context) ? c.context as Record<string, unknown> : undefined;
        const rounds = c?.rounds && typeof c.rounds === 'object' && !Array.isArray(c.rounds) ? c.rounds as Record<string, unknown> : undefined;
        const maxTokens = number(context?.maxTokens, 8_000, 2_000_000);
        const softRatio = number(context?.softRatio, .1, 1);
        const keepRatio = number(context?.keepRatio, .05, .9);
        const soft = number(rounds?.soft, 1, 1000);
        const hard = number(rounds?.hard, 1, 2000);
        const firstTurn = context?.firstTurn;
        if ((context?.maxTokens !== undefined && maxTokens === undefined) || (context?.softRatio !== undefined && softRatio === undefined)
          || (context?.keepRatio !== undefined && keepRatio === undefined) || (rounds?.soft !== undefined && soft === undefined)
          || (rounds?.hard !== undefined && hard === undefined) || (firstTurn !== undefined && typeof firstTurn !== 'boolean')) return send(400, { error: 'invalid conversation settings' });
        if (hard !== undefined && soft !== undefined && hard < soft) return send(400, { error: 'hard rounds must be at least soft rounds' });
        const behavior = body?.behavior;
        if (behavior !== undefined && (!behavior || typeof behavior !== 'object' || Array.isArray(behavior))) return send(400, { error: 'invalid behavior settings' });
        const avoidance = (behavior as Record<string, unknown> | undefined)?.avoidance;
        if (avoidance !== undefined && typeof avoidance !== 'boolean') return send(400, { error: 'avoidance must be true or false' });
        const rawActions = body?.actions;
        if (rawActions !== undefined && (!rawActions || typeof rawActions !== 'object' || Array.isArray(rawActions))) return send(400, { error: 'invalid action settings' });
        const actions: NonNullable<WorkbenchSettingsChange['actions']> = {};
        const clipList = (value: unknown): string[] | undefined => {
          if (value === undefined) return undefined;
          if (!Array.isArray(value) || value.length > 40) return undefined;
          const items = value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
          if (!items.length || items.some((item) => item.length > 120) || items.length !== value.length) return undefined;
          return items;
        };
        for (const [id, value] of Object.entries((rawActions ?? {}) as Record<string, unknown>)) {
          if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return send(400, { error: 'invalid action id' });
          if (value === null) { actions[id] = null; continue; }
          if (!value || typeof value !== 'object' || Array.isArray(value)) return send(400, { error: 'invalid action settings' });
          const entry = value as Record<string, unknown>;
          const clips = clipList(entry.clips);
          const zh = clipList(entry.zh);
          const mood = clipList(entry.mood);
          const about = entry.about === undefined ? undefined : clean(entry.about);
          const when = entry.when === undefined ? undefined : clean(entry.when);
          if ((entry.clips !== undefined && clips === undefined) || (entry.zh !== undefined && zh === undefined)
            || (entry.mood !== undefined && mood === undefined)
            || (entry.about !== undefined && !about) || (entry.when !== undefined && !when)
            || (about?.length ?? 0) > 200 || (when?.length ?? 0) > 200) return send(400, { error: 'invalid action settings' });
          actions[id] = { ...(clips !== undefined ? { clips } : {}), ...(zh !== undefined ? { zh } : {}), ...(mood !== undefined ? { mood } : {}),
            ...(about !== undefined ? { about } : {}), ...(when !== undefined ? { when } : {}) };
        }
        if ([name, user, constitution, language, maxTokens, softRatio, keepRatio, soft, hard, firstTurn].every((v) => v === undefined)
          && avoidance === undefined && rawActions === undefined ) return send(400, { error: 'nothing to change' });
        return send(200, await deps.saveWorkbenchSettings({
          ...(name !== undefined || user !== undefined || constitution !== undefined ? { profile: { ...(name !== undefined ? { name } : {}), ...(user !== undefined ? { user } : {}), ...(constitution !== undefined ? { constitution } : {}) } } : {}),
          ...(language !== undefined || maxTokens !== undefined || softRatio !== undefined || keepRatio !== undefined || firstTurn !== undefined || soft !== undefined || hard !== undefined ? { conversation: {
            ...(language !== undefined ? { language } : {}),
            ...(maxTokens !== undefined || softRatio !== undefined || keepRatio !== undefined || firstTurn !== undefined ? { context: { ...(maxTokens !== undefined ? { maxTokens } : {}), ...(softRatio !== undefined ? { softRatio } : {}), ...(keepRatio !== undefined ? { keepRatio } : {}), ...(typeof firstTurn === 'boolean' ? { firstTurn } : {}) } } : {}),
            ...(soft !== undefined || hard !== undefined ? { rounds: { ...(soft !== undefined ? { soft } : {}), ...(hard !== undefined ? { hard } : {}) } } : {}),
          } } : {}),
          ...(avoidance !== undefined ? { behavior: { avoidance } } : {}),
          ...(rawActions !== undefined ? { actions } : {}),
        }));
      }
      if (req.method === 'POST' && path === '/lingxi/runtime-settings') {
        if (!deps.saveRuntimeSettings) return send(501, { error: 'runtime settings unavailable' });
        const body = await readJson(req);
        const model = body?.model;
        const executor = body?.executor;
        if (model !== undefined && (!model || typeof model !== 'object' || Array.isArray(model))) return send(400, { error: 'invalid model settings' });
        if (executor !== undefined && (!executor || typeof executor !== 'object' || Array.isArray(executor))) return send(400, { error: 'invalid executor settings' });
        const field = (value: Record<string, unknown> | undefined, key: string): string | undefined => value?.[key] === undefined ? undefined : text(value[key]);
        const protocol = field(model as Record<string, unknown> | undefined, 'protocol');
        const apiUrl = field(model as Record<string, unknown> | undefined, 'apiUrl');
        const modelName = field(model as Record<string, unknown> | undefined, 'model');
        const apiKey = field(model as Record<string, unknown> | undefined, 'apiKey');
        const provider = field(executor as Record<string, unknown> | undefined, 'provider');
        const sandboxMode = field(executor as Record<string, unknown> | undefined, 'sandboxMode');
        const networkAccess = field(executor as Record<string, unknown> | undefined, 'networkAccess');
        if (protocol === '' || apiUrl === '' || modelName === '' || provider === '' || sandboxMode === '' || networkAccess === '') return send(400, { error: 'runtime setting cannot be empty' });
        if ([protocol, apiUrl, modelName, apiKey, provider, sandboxMode, networkAccess].every((value) => value === undefined)) return send(400, { error: 'nothing to change' });
        return send(200, deps.saveRuntimeSettings({
          ...(model ? { model: { ...(protocol !== undefined ? { protocol } : {}), ...(apiUrl !== undefined ? { apiUrl } : {}), ...(modelName !== undefined ? { model: modelName } : {}), ...(apiKey !== undefined ? { apiKey } : {}) } } : {}),
          ...(executor ? { executor: { ...(provider !== undefined ? { provider } : {}), ...(sandboxMode !== undefined ? { sandboxMode } : {}), ...(networkAccess !== undefined ? { networkAccess } : {}) } } : {}),
        }));
      }
      send(404, { error: 'not found' });
    })().catch((err: unknown) => send(500, { error: (err as Error).message }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(access.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return server;
}
