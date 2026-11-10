/**
 * The record of judgments: every time a model or a rule decides something the person may later confirm or overturn
 * (which kind a reminder is, whether two talks are the same thread, whether to hand a task on), the full input, who
 * judged (model, prompt version), the output and its confidence are appended; when the answer becomes known (the
 * person said so, or it was found wrong later), a label row is appended that points back. Nothing is rewritten.
 *
 * It is learning material: to measure a new model on the same cases, to fit the small models of the daily layer
 * (the thread-link calibrator first), and to grow the data even when nothing changes. Inputs are stored whole, not as
 * references, so a case still makes sense after the raw log it came from is gone. Files are JSONL per kind, one line
 * per row, small enough to keep forever.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Judged {
  /** What is judged, one file each: `reminder-kind`, `thread-link`, `delegate`… */
  kind: string;
  /** Everything the judge saw, self-contained. */
  input: unknown;
  output: unknown;
  /** 0–1 when the judge gives one. */
  confidence?: number;
  /** Numbers a small model can learn from: similarities, overlaps, time gaps. */
  features?: Record<string, number>;
  /** Who judged: `deepseek-flash`, `rule:reminder-engine@1`, `person`. */
  judge: string;
  promptVersion?: string;
  /** Where it happened, for joining with the ledger. */
  incidentId?: string;
}

export interface Judgment extends Judged { type: 'judgment'; id: string; ts: string }

export interface Label {
  type: 'label';
  ts: string;
  target: string;
  /** The right answer as now known, in the judgment's own output shape when possible. */
  label: unknown;
  /** Whether the judgment was right. */
  agrees: boolean;
  /** `person` when they answered or corrected it; `later` when a later event showed it; `rule` for an automatic check. */
  source: 'person' | 'later' | 'rule';
  note?: string;
}

export class Judgments {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dir: string, now: () => Date = () => new Date()) {
    this.dir = dir;
    this.now = now;
    mkdirSync(dir, { recursive: true });
  }

  /** Records a judgment; returns its id, for the label that comes later. */
  record(j: Judged): string {
    const row: Judgment = { type: 'judgment', id: `j-${randomUUID()}`, ts: this.now().toISOString(), ...j };
    this.append(j.kind, row);
    return row.id;
  }

  /** Records what the answer turned out to be. */
  label(kind: string, target: string, l: Omit<Label, 'type' | 'ts' | 'target'>): void {
    this.append(kind, { type: 'label', ts: this.now().toISOString(), target, ...l });
  }

  /** Every judgment of a kind with its latest label, if any: the training and evaluation set. */
  cases(kind: string): Array<Judgment & { latest: Label | null }> {
    const file = this.file(kind);
    if (!existsSync(file)) return [];
    const judgments = new Map<string, Judgment & { latest: Label | null }>();
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let row: Judgment | Label;
      try { row = JSON.parse(raw) as Judgment | Label; } catch { continue; }
      if (row.type === 'judgment') judgments.set(row.id, { ...row, latest: null });
      else { const j = judgments.get(row.target); if (j) j.latest = row; }
    }
    return [...judgments.values()];
  }

  /** How often the labelled judgments of a kind were right, overall and per judge. */
  agreement(kind: string): { labelled: number; agreed: number; byJudge: Record<string, { labelled: number; agreed: number }> } {
    const out = { labelled: 0, agreed: 0, byJudge: {} as Record<string, { labelled: number; agreed: number }> };
    for (const c of this.cases(kind)) {
      if (!c.latest) continue;
      const j = (out.byJudge[c.judge] ??= { labelled: 0, agreed: 0 });
      out.labelled++; j.labelled++;
      if (c.latest.agrees) { out.agreed++; j.agreed++; }
    }
    return out;
  }

  private file(kind: string): string {
    if (!/^[a-z0-9-]+$/.test(kind)) throw new Error(`kind must be kebab-case: ${kind}`);
    return join(this.dir, `${kind}.jsonl`);
  }

  private append(kind: string, row: Judgment | Label): void {
    appendFileSync(this.file(kind), `${JSON.stringify(row)}\n`);
  }
}
