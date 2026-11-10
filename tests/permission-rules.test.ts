import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermissionRules, permissionKind } from '../core/agents/permission-rules.ts';

describe('standing answers to permission requests', () => {
  it('names a kind by who asks, the tool, and the folder or the command word', () => {
    expect(permissionKind('code agent', 'write', { path: String.raw`D:\pet\src\a.ts` })).toBe('code agent · write · D:/pet/src');
    expect(permissionKind('code agent', 'pwsh', { command: 'npm install left-pad' })).toBe('code agent · pwsh · npm');
    expect(permissionKind('control center', 'something', null)).toBe('control center · something');
  });

  it('keeps what the person allowed from now on across a restart, and takes it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const rules = new PermissionRules(dir);
    rules.add('code agent · pwsh · npm', 'pwsh {"command":"npm install left-pad"}');
    rules.add('code agent · pwsh · npm', 'again');
    expect(new PermissionRules(dir).list()).toEqual([expect.objectContaining({ kind: 'code agent · pwsh · npm', example: 'pwsh {"command":"npm install left-pad"}' })]);
    expect(rules.allows('code agent · pwsh · npm')).toBe(true);
    expect(rules.remove('code agent · pwsh · npm')).toBe(true);
    expect(rules.remove('code agent · pwsh · npm')).toBe(false);
    expect(new PermissionRules(dir).allows('code agent · pwsh · npm')).toBe(false);
  });
});
