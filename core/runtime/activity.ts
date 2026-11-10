import type { EventStoreReader } from '../contracts.ts';
import { readToolActivity, type ToolActivityCursor } from './activity-tools.ts';

export interface ActivityItem {
  id: string; source: string; position: string; at: string | null; role: string; kind: string; summary: string; detail?: string;
  state?: string; runId?: string; taskId?: string; callId?: string; outputId?: string; actionId?: string; interactionId?: string; x?: number; y?: number; from?: number; inputCursor?: number;
  attempt?: number; provider?: string;
}
export interface ActivityPage {
  available: boolean; items: ActivityItem[]; cursor: string; hasMore: boolean;
  sources: Array<{ id: string; status: 'available' | 'partial' | 'unavailable'; detail?: string }>;
  reset?: boolean;
}


const encode = (cursor: number) => Buffer.from(JSON.stringify({ v: 1, event: cursor })).toString('base64url');
const actionNames: Record<string, string> = { walk: '走路', run: '跑步', jump: '跳跃', wave: '挥手', sleep: '睡觉' };
function decode(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v === 1 && Number.isSafeInteger(value.event) && value.event >= 0) return value.event;
  } catch { /* Invalid cursors are not silently reset. */ }
  throw new Error('invalid activity cursor');
}

/** Whitelisted event facts only; no raw event text, tool args, or provider contents. */
export function readActivity(store: EventStoreReader, cursor?: string, limit = 50): ActivityPage {
  const start = decode(cursor);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid activity limit');
  const sources: ActivityPage['sources'] = [
    { id: 'events', status: 'partial', detail: 'Existing event history may omit unreadable segments.' },
    { id: 'tools', status: 'unavailable', detail: 'Tool activity projection is not connected.' },
    { id: 'agents', status: 'unavailable', detail: 'Published agent activity is not connected.' },
    { id: 'reasoning', status: 'unavailable', detail: 'No public reasoning summary source is connected.' },
  ];
  let latest: number;
  try { latest = store.latestCursor(); }
  catch {
    sources[0] = { id: 'events', status: 'unavailable', detail: '事件来源暂不可读取。' };
    return { available: false, items: [], cursor: encode(start), hasMore: false, sources };
  }
  if (start > latest) return { available: false, items: [], cursor: encode(start), hasMore: false, sources, reset: true };
  const end = Math.min(latest, start + 500);
  let events: ReturnType<EventStoreReader['range']>;
  try { events = store.range({ fromCursor: start + 1, toCursor: end }); }
  catch {
    sources[0] = { id: 'events', status: 'unavailable', detail: '事件来源暂不可读取。' };
    return { available: false, items: [], cursor: encode(start), hasMore: false, sources };
  }
  const items: ActivityItem[] = [];
  let position = start;
  for (const event of events) {
    if (event.cursor !== position + 1) {
      sources[0] = { id: 'events', status: 'partial', detail: 'Event cursor gap; activity cannot advance safely.' };
      return { available: true, items, cursor: encode(position), hasMore: false, sources, reset: true };
    }
    position = event.cursor;
    const base = { id: `event:${event.cursor}`, source: 'events', position: String(event.cursor), at: event.ts || null,
      role: 'body', ...(event.run ? { runId: event.run } : {}) };
    if (event.source === 'pet' && event.type === 'pet.action') {
      const meta = event.meta ?? {};
      const validState = ['submitted', 'started', 'arrived', 'done', 'completed', 'failed', 'wall', 'interrupted', 'replaced', 'unknown'].includes(String(meta.state));
      const action = typeof meta.action === 'string' && Object.hasOwn(actionNames, meta.action) ? actionNames[meta.action] : '身体动作';
      if (validState) items.push({ ...base, kind: 'body-motion', summary: action, state: String(meta.state),
        ...(typeof meta.actionId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(meta.actionId) ? { actionId: meta.actionId } : {}) });
    }
    else if (event.source === 'pet' && event.type === 'pet.interaction') {
      const meta = event.meta ?? {};
      const interactionId = typeof meta.interactionId === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(meta.interactionId) ? meta.interactionId : null;
      const kind = typeof meta.kind === 'string' && ['click', 'pet', 'drag-start', 'drag-move', 'drag-end'].includes(meta.kind) ? meta.kind : 'body interaction';
      const state = typeof meta.state === 'string' ? meta.state : 'unknown';
      if (interactionId) items.push({ ...base, kind: 'body-interaction', summary: kind === 'click' ? '身体被点击' : kind === 'pet' ? '正在抚摸身体' : kind === 'drag-start' ? '身体被拎起' : kind === 'drag-move' ? '拖动中' : '身体被放下', state,
        interactionId, ...(typeof meta.x === 'number' ? { x: meta.x } : {}), ...(typeof meta.y === 'number' ? { y: meta.y } : {}), ...(typeof meta.from === 'number' ? { from: meta.from } : {}) });
    }
    else if (event.source === 'pet' && event.type === 'pet.moved') items.push({ ...base, kind: 'body-motion', summary: '收到身体动作反馈' });
    else if (event.source === 'pet' && event.type === 'pet.output.receipt') {
      const meta = event.meta ?? {};
      const allowed = ['presented', 'paused', 'resumed', 'completed', 'interrupted', 'unknown'].includes(String(meta.state));
      if (allowed) items.push({ ...base, role: 'output', kind: 'output-receipt', summary: '收到输出回执', state: String(meta.state),
        ...(typeof meta.outputId === 'string' && /^[-\w:]{1,160}$/.test(meta.outputId) ? { outputId: meta.outputId } : {}) });
    }
    if (items.length >= limit) break;
  }
  if (items.length < limit && position !== end) {
    sources[0] = { id: 'events', status: 'partial', detail: 'Event cursor gap; activity cannot advance safely.' };
    return { available: true, items, cursor: encode(position), hasMore: false, sources, reset: true };
  }
  return { available: true, items, cursor: encode(position), hasMore: position < latest, sources };
}

/** Merge independent source positions without using wall-clock time as a cursor. */
export function readCombinedActivity(store: EventStoreReader, toolLog: { file: string; runId: string }, cursor?: string, limit = 50,
  agentSource?: (after: number, limit: number) => { items: Array<Record<string, unknown>>; sequence: number; hasMore: boolean; coverage: 'partial'; reset?: boolean },
  taskActivity?: () => ActivityItem[]): ActivityPage {
  let previous: { eventCursor?: string; tool?: ToolActivityCursor; agent?: number } = {};
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if ((value.v !== 2 && value.v !== 3) || (value.agent !== undefined && (!Number.isSafeInteger(value.agent) || value.agent < 0)) || (value.eventCursor !== undefined && typeof value.eventCursor !== 'string')
        || (value.tool !== undefined && (!Number.isSafeInteger(value.tool.offset) || value.tool.offset < 0 || typeof value.tool.fileId !== 'string' || typeof value.tool.runId !== 'string'))) throw new Error('bad cursor');
      previous = value;
    } catch { throw new Error('invalid activity cursor'); }
  }
  const events = readActivity(store, previous.eventCursor, limit);
  const tool = readToolActivity(toolLog.file, toolLog.runId, previous.tool, Math.max(0, limit - events.items.length));
  events.sources[1] = { id: 'tools', status: tool.status, detail: tool.status === 'partial' ? '仅当前运行的工具名称与返回状态；日志可能缺失。' : '工具日志暂不可读取。' };
  let agentSequence = previous.agent ?? 0, agentMore = false, agentReset = false;
  const agents: ActivityItem[] = [];
  if (agentSource) {
    try {
      const remaining = limit - events.items.length - tool.items.length;
      if (remaining > 0) {
        const page = agentSource(agentSequence, remaining);
        agentReset = !!page.reset; agentSequence = agentReset ? 0 : page.sequence; agentMore = page.hasMore || agentReset;
        for (const row of page.items) {
          if (typeof row.sequence !== 'number' || typeof row.state !== 'string') continue;
          if (row.kind === 'state') agents.push({ id: `agent:${row.sequence}`, source: 'agents', position: String(row.sequence), at: typeof row.created_at === 'string' ? row.created_at : null,
            role: typeof row.role === 'string' ? row.role : 'coder', kind: 'agent-state', summary: '', state: row.state,
            ...(typeof row.task_id === 'string' ? { taskId: row.task_id } : {}),
            ...(typeof row.attempt === 'number' ? { attempt: row.attempt } : {}),
            ...(['builtin', 'dsh', 'codex', 'claude'].includes(String(row.provider)) ? { provider: String(row.provider) } : {}) });
          else if (row.kind === 'tool' && typeof row.tool_name === 'string') agents.push({ id: `agent-tool:${row.sequence}`, source: 'agents', position: String(row.sequence), at: typeof row.created_at === 'string' ? row.created_at : null,
            role: typeof row.role === 'string' ? row.role : 'coder', kind: 'agent-tool', summary: row.tool_name, state: row.state,
            ...(typeof row.task_id === 'string' ? { taskId: row.task_id } : {}), ...(typeof row.call_id === 'string' ? { callId: row.call_id } : {}),
            ...(typeof row.attempt === 'number' ? { attempt: row.attempt } : {}),
            ...(['builtin', 'dsh', 'codex', 'claude'].includes(String(row.provider)) ? { provider: String(row.provider) } : {}) });
        }
      } else agentMore = true;
      events.sources[2] = { id: 'agents', status: 'partial', detail: '后台活动记录可能不完整。' };
    } catch { events.sources[2] = { id: 'agents', status: 'unavailable', detail: '后台活动暂不可读取。' }; }
  }
  const items = [...events.items, ...tool.items, ...agents, ...(taskActivity?.() ?? [])].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.source.localeCompare(b.source) || a.position.localeCompare(b.position, 'en', { numeric: true }));
  return { ...events, items, hasMore: events.hasMore || tool.hasMore || agentMore, ...(events.reset || tool.reset || agentReset ? { reset: true } : {}),
    cursor: Buffer.from(JSON.stringify({ v: 3, eventCursor: events.cursor, ...(tool.status === 'unavailable' && !previous.tool ? {} : { tool: tool.cursor }), agent: agentSequence })).toString('base64url') };
}
