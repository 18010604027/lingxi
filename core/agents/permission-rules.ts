/**
 * Standing answers to the background's permission requests: when the person answers a request
 * with "this kind is fine from now on", later requests of the same kind are allowed without asking them again. They
 * are listed in the console's `behind` panel, where the person can take one back.
 *
 * A kind is who asks, with which tool, on what: the folder a file call targets, or the first word of a command. That
 * is what the question shows as "the same kind", so the person knows what they allow. Kept in `permission-rules.json`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PermissionRule { kind: string; at: string; example: string }

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'file', 'dir', 'directory'];
const COMMAND_KEYS = ['command', 'script', 'cmd'];

/** The kind of a request: `<who> · <tool> · <folder or command word>`. */
export function permissionKind(who: string, tool: string, input: unknown): string {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const path = PATH_KEYS.map((k) => args[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const command = COMMAND_KEYS.map((k) => args[k]).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const on = path ? dirname(path.replace(/\\/g, '/'))
    : command ? command.trim().split(/\s+/)[0]!.toLowerCase()
      : '';
  return [who, tool, on].filter(Boolean).join(' · ');
}

export class PermissionRules {
  private readonly file: string;
  private rules: PermissionRule[];

  constructor(dir: string) {
    this.file = join(dir, 'permission-rules.json');
    this.rules = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as PermissionRule[] : [];
  }

  allows(kind: string): boolean {
    return this.rules.some((r) => r.kind === kind);
  }

  add(kind: string, example: string, now = new Date()): void {
    if (this.allows(kind)) return;
    this.rules.push({ kind, at: now.toISOString(), example: example.slice(0, 200) });
    this.save();
  }

  /** Takes a rule back; false when there was none. */
  remove(kind: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.kind !== kind);
    if (this.rules.length === before) return false;
    this.save();
    return true;
  }

  list(): PermissionRule[] {
    return [...this.rules];
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.rules, null, 2));
  }
}
