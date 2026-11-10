/**
 * Cases for the control center: anything the daily layer cannot settle by its own
 * rules goes to the control center as a case, with all it needs to decide well, not as a line of text.
 *
 * A case holds what kind of matter it is (`kind`) and about what (`key`), the question, the facts in sections, pictures
 * with what is marked on them, and the shape of the answer. The control center answers with `case_decide`; each kind
 * registers how its answers are checked, applied and told back as history. The decisions on the same kind and key are
 * kept, and every new case on them carries them as its last section: how this was decided before, and what came of it.
 *
 * Kept under `cases/<id>/` (case.json and the pictures) and in `cases.sqlite` (the decisions).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from '../sqlite.ts';

export interface CaseImage { label: string; legend: string; jpeg: Uint8Array }
export interface CaseSection { title: string; lines: string[] }
export interface CaseInput {
  kind: string;
  key: string;
  question: string;
  sections: CaseSection[];
  images: CaseImage[];
}
export interface StoredCase extends Omit<CaseInput, 'images'> {
  id: string;
  at: string;
  images: Array<{ label: string; legend: string; file: string }>;
}
export interface Decision { caseId: string; at: string; answer: Record<string, unknown>; applied: string }

/** What a kind of case knows of its answers. */
export interface CaseKind {
  /** The answer's shape, in words and as a JSON example, for the control center. */
  answerFormat: string;
  /** Checks an answer; returns what is wrong with it, or null when it is fine. */
  check(answer: Record<string, unknown>): string | null;
  /** Applies a checked answer; returns what was done, in a line. */
  apply(c: StoredCase, answer: Record<string, unknown>): string;
  /** One past decision as a line of history. */
  describe(d: Decision): string;
}

/** Past decisions shown with a new case, newest last. */
const HISTORY = 8;

export class Cases {
  private readonly db: Db;
  private readonly kinds = new Map<string, CaseKind>();
  private next = 0;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = openDb(join(dir, 'cases.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS decision (case_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL,
      answer TEXT NOT NULL, applied TEXT NOT NULL); CREATE INDEX IF NOT EXISTS decision_key ON decision (kind, key, at);`);
  }

  register(kind: string, k: CaseKind): void {
    this.kinds.set(kind, k);
  }

  /** Stores a case with the decisions made before on the same matter added as its last section. */
  open(input: CaseInput): StoredCase {
    const id = `case-${Date.now().toString(36)}-${(this.next++).toString(36)}`;
    const at = new Date().toISOString();
    const folder = join(this.dir, id);
    mkdirSync(folder, { recursive: true });
    const images = input.images.map((im, i) => {
      const file = join(folder, `${i + 1}.jpg`);
      writeFileSync(file, im.jpeg);
      return { label: im.label, legend: im.legend, file };
    });
    const before = this.history(input.kind, input.key);
    const kind = this.kinds.get(input.kind);
    const sections = [...input.sections, {
      title: 'How this was decided before (newest last), and what was done',
      lines: before.length ? before.map((d) => kind ? kind.describe(d) : `${d.at.slice(0, 16)} ${JSON.stringify(d.answer)} → ${d.applied}`) : ['(never decided before)'],
    }];
    const c: StoredCase = { id, at, kind: input.kind, key: input.key, question: input.question, sections, images };
    writeFileSync(join(folder, 'case.json'), JSON.stringify(c, null, 2));
    return c;
  }

  get(id: string): StoredCase | null {
    const file = join(this.dir, id, 'case.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as StoredCase : null;
  }

  /** The pictures of a case, as bytes. */
  images(c: StoredCase): Array<{ label: string; legend: string; jpeg: Uint8Array }> {
    return c.images.map((im) => ({ label: im.label, legend: im.legend, jpeg: new Uint8Array(readFileSync(im.file)) }));
  }

  /** The case as the control center reads it, the pictures named where they go. */
  render(c: StoredCase): string {
    const kind = this.kinds.get(c.kind);
    return [
      `[case ${c.id}] ${c.kind} · ${c.key}`,
      `Question: ${c.question}`,
      ...c.sections.flatMap((s) => ['', `## ${s.title}`, ...s.lines.map((l) => `- ${l}`)]),
      ...(c.images.length ? ['', '## Pictures (attached in this order)', ...c.images.map((im, i) => `${i + 1}. ${im.label}: ${im.legend}`)] : []),
      '', '## Your answer',
      `Call case_decide with case_id "${c.id}" and the answer as JSON. Be concrete: name what you see and where, in the units asked for.`,
      kind?.answerFormat ?? '(free form)',
    ].join('\n');
  }

  /** Checks and applies an answer to a case and keeps it as a decision; returns what was done, or what was wrong. */
  decide(id: string, answer: Record<string, unknown>): { ok: boolean; text: string } {
    const c = this.get(id);
    if (!c) return { ok: false, text: `no case ${id}` };
    const kind = this.kinds.get(c.kind);
    const wrong = kind?.check(answer) ?? null;
    if (wrong) return { ok: false, text: wrong };
    const applied = kind ? kind.apply(c, answer) : 'kept as said';
    this.db.prepare(`INSERT INTO decision (case_id, kind, key, at, answer, applied) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (case_id) DO UPDATE SET at = excluded.at, answer = excluded.answer, applied = excluded.applied`)
      .run(id, c.kind, c.key, new Date().toISOString(), JSON.stringify(answer), applied);
    return { ok: true, text: applied };
  }

  /** The latest cases, newest first, each with its decision when it has one. */
  recent(limit = 10): Array<StoredCase & { decision: Decision | null }> {
    const ids = readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('case-')).map((d) => d.name);
    const cases = ids.map((id) => this.get(id)).filter((c): c is StoredCase => c !== null).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
    return cases.map((c) => {
      const r = this.db.prepare('SELECT case_id, at, answer, applied FROM decision WHERE case_id = ?').get(c.id) as { case_id: string; at: string; answer: string; applied: string } | undefined;
      return { ...c, decision: r ? { caseId: r.case_id, at: r.at, answer: JSON.parse(r.answer) as Record<string, unknown>, applied: r.applied } : null };
    });
  }

  /** The decisions on a kind and key, newest last. */
  history(kind: string, key: string, limit = HISTORY): Decision[] {
    return (this.db.prepare('SELECT case_id, at, answer, applied FROM decision WHERE kind = ? AND key = ? ORDER BY at DESC LIMIT ?').all(kind, key, limit) as Array<{ case_id: string; at: string; answer: string; applied: string }>)
      .reverse().map((r) => ({ caseId: r.case_id, at: r.at, answer: JSON.parse(r.answer) as Record<string, unknown>, applied: r.applied }));
  }

  close(): void {
    this.db.close();
  }
}

/** The case a task carries, from the `[case <id>]` its body starts with; null when none. */
export function caseIdOf(body: string): string | null {
  return /^\[case (case-[a-z0-9-]+)\]/.exec(body)?.[1] ?? null;
}

/** Legacy work-area cases predate the TaskBus internal label; only daily-origin tasks carrying a real workarea case count. */
export function isInternalWorkareaCaseTask(task: { from: string; body: string }, cases: Pick<Cases, 'get'>): boolean {
  if (task.from !== 'daily') return false;
  const id = caseIdOf(task.body);
  return id !== null && cases.get(id)?.kind === 'workarea';
}
