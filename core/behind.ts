/**
 * What goes on behind the pet, for the console's `behind` panel (notice.ts, webui/client.ts): the work the back of
 * her mind and the code agent are doing now, what they just finished, the cases handed to the control center and
 * how they were decided, the decisions recorded lately, and the kinds of request the person allowed from now on. Read
 * from the task bus, the cases, the ledger and the permission rules; nothing here changes anything.
 */
import type { Agents } from './agents/roles.ts';
import { isInternalTask } from './agents/bus.ts';
import { isInternalWorkareaCaseTask } from './agents/cases.ts';

export interface BehindTask {
  id: string; to: string; from: string; status: string;
  runnerId: string;
  codeProvider: string | null;
  /** A completed task was sent to the old front without a durable receipt. */
  deliveryUnconfirmed: boolean;
  deliveryRetryable: boolean;
  /** How the pet thinks of it, or the first line of the task. */
  what: string;
  /** What the worker last said it was doing. */
  progress: string | null;
  createdAt: string; settledAt: string | null;
  /** The first lines of what came of it. */
  result: string | null;
  /** Original notes for interrupted or failed work; whether they were handled is not known. */
  notesToReview: string[];
}
export interface BehindCase { id: string; kind: string; question: string; at: string; decided: { at: string; applied: string; verdict: string | null } | null }
export interface BehindDecision { ts: string; role: string; summary: string; why: string | null }
export interface BehindRule { kind: string; at: string; example: string }
export interface BehindState { at: string; open: BehindTask[]; done: BehindTask[]; cases: BehindCase[]; decisions: BehindDecision[]; rules: BehindRule[]; permissions: Array<{ id: string; taskId: string; state: string; createdAt: string }> }

const short = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The panel's state now: open tasks, the ten last finished, the ten last cases, and the decisions of the last three days. */
export function behindState(agents: Agents, now = new Date()): BehindState {
  const unconfirmed = new Set(agents.bus.unconfirmedFrontResults().map((task) => task.id));
  const retryable = new Set(agents.bus.retryableFrontResults().map((task) => task.id));
  const view = (t: ReturnType<Agents['bus']['list']>[number]): BehindTask => ({
    id: t.id, to: t.to, from: t.from, status: t.status, runnerId: t.runnerId, codeProvider: t.codeProvider, deliveryUnconfirmed: unconfirmed.has(t.id), deliveryRetryable: retryable.has(t.id),
    what: short(t.label ?? t.body.split('\n')[0], 120), progress: t.progress ? short(t.progress, 160) : null,
    createdAt: t.createdAt, settledAt: t.settledAt,
    // Failure and unknown details are recovery evidence. Keep them intact so the person can decide whether to replay;
    // ordinary completed output remains bounded for the panel.
    result: t.result ? (['unknown', 'failed', 'cancelled'].includes(t.status) ? t.result : short(t.result, 400)) : null,
    notesToReview: ['unknown', 'failed', 'cancelled'].includes(t.status) ? [...t.notes] : [],
  });
  const all = agents.bus.list().filter((t) => !isInternalTask(t) && !isInternalWorkareaCaseTask(t, agents.cases));
  const open = all.filter((t) => t.status === 'queued' || t.status === 'running' || t.status === 'unknown').map(view);
  const done = all.filter((t) => t.status !== 'queued' && t.status !== 'running' && t.status !== 'unknown')
    .sort((a, b) => (b.settledAt ?? b.createdAt).localeCompare(a.settledAt ?? a.createdAt)).slice(0, 10).map(view);
  const cases = agents.cases.recent(10).map((c) => ({
    id: c.id, kind: c.kind, question: short(c.question, 200), at: c.at,
    decided: c.decision ? { at: c.decision.at, applied: short(c.decision.applied, 200), verdict: typeof c.decision.answer.verdict === 'string' ? c.decision.answer.verdict : null } : null,
  }));
  const from = new Date(now.getTime() - 3 * 86_400_000).toISOString();
  const decisions = agents.ledger.range(from, now.toISOString()).filter((e) => e.op === 'decision').slice(-20).reverse()
    .map((e) => ({ ts: e.ts, role: e.role, summary: short(e.summary, 200), why: e.why ? short(e.why, 200) : null }));
  return { at: now.toISOString(), open, done, cases, decisions, rules: agents.permissionRules.list(), permissions: agents.pendingPermissions() };
}
