import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { ActivityItem } from './activity.ts';

export interface ToolActivityCursor { offset: number; fileId: string; runId: string }
export interface ToolActivityResult { items: ActivityItem[]; cursor: ToolActivityCursor; hasMore: boolean; status: 'partial' | 'unavailable'; reset?: boolean }
const knownTools: Record<string, string> = { pet_act: '身体动作', pet_say: '身体发言', pet_ask: '提出问题', delegate_task: '委派任务', task_status: '查询任务', task_note: '补充任务', cancel_task: '取消任务' };

/** Read only known front tools from a host-selected run; private args and results stay outside the activity projection. */
export function readToolActivity(file: string, runId: string, prior: ToolActivityCursor | undefined, limit: number): ToolActivityResult {
  const fallback = prior ?? { offset: 0, fileId: '', runId };
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return { items: [], cursor: fallback, hasMore: false, status: 'unavailable' }; }
  try {
    const stat = fstatSync(fd);
    const fileId = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (prior && (prior.runId !== runId || prior.fileId !== fileId || prior.offset > stat.size)) {
      return { items: [], cursor: prior, hasMore: false, status: 'partial', reset: true };
    }
    let offset = prior?.offset ?? 0;
    const bytes = Buffer.alloc(stat.size - offset);
    let read = 0;
    while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, offset + read); if (!count) break; read += count; }
    const items: ActivityItem[] = [];
    let index = 0;
    while (index < read && items.length < limit) {
      const end = bytes.indexOf(10, index); if (end < 0 || end >= read) break;
      const position = offset; let entry: any;
      try { entry = JSON.parse(bytes.subarray(index, end).toString('utf8')); }
      catch { return { items, cursor: { offset, fileId, runId }, hasMore: false, status: 'partial', reset: true }; }
      offset += end + 1 - index; index = end + 1;
      const label = Object.hasOwn(knownTools, entry.tool) ? knownTools[entry.tool] : undefined;
      if (!label || entry.run !== runId) continue;
      items.push({ id: `tool:${runId}:${position}`, source: 'tools', position: String(position), at: typeof entry.ts === 'string' ? entry.ts : null,
        role: 'front', kind: 'tool', summary: label, state: entry.failed === true ? 'failed' : 'returned', runId,
        ...(typeof entry.call === 'string' && /^[-\w:]{1,160}$/.test(entry.call) ? { callId: entry.call } : {}) });
    }
    return { items, cursor: { offset, fileId, runId }, hasMore: offset < stat.size && index < read && bytes.indexOf(10, index) >= 0, status: 'partial' };
  } catch { return { items: [], cursor: fallback, hasMore: false, status: 'unavailable' }; }
  finally { closeSync(fd); }
}
