import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBodyUserData, assertBodyUserDataWithinRoot, bodyUserDataArgs } from '../core/body-profile.ts';

describe('isolated Electron body profile', () => {
  it('passes an absolute profile to Chromium before app startup', () => {
    expect(bodyUserDataArgs('C:\\temp\\lingxi\\electron-user-data'))
      .toEqual(['--user-data-dir=C:\\temp\\lingxi\\electron-user-data']);
    expect(bodyUserDataArgs(undefined)).toEqual([]);
    expect(() => bodyUserDataArgs('relative\\profile')).toThrow('absolute path');
  });

  it('accepts only the expected absolute effective userData path', () => {
    expect(() => assertBodyUserData('C:\\temp\\lingxi\\electron-user-data', 'C:\\temp\\lingxi\\electron-user-data')).not.toThrow();
    expect(() => assertBodyUserData('C:\\Users\\person\\AppData\\Roaming\\ds-pet-body', 'C:\\temp\\lingxi\\electron-user-data')).toThrow();
    expect(() => assertBodyUserData('relative\\profile', 'C:\\temp\\lingxi\\electron-user-data')).toThrow();
  });

  it('fails closed before launch unless the profile is inside the absolute expected root', () => {
    expect(() => assertBodyUserDataWithinRoot(undefined, 'C:\\temp\\lingxi')).toThrow('requires absolute');
    expect(() => assertBodyUserDataWithinRoot('relative\\profile', 'C:\\temp\\lingxi')).toThrow('requires absolute');
    expect(() => assertBodyUserDataWithinRoot('C:\\temp\\other\\profile', 'C:\\temp\\lingxi')).toThrow('inside');
    expect(() => assertBodyUserDataWithinRoot('C:\\temp\\lingxi\\profile', 'C:\\temp\\lingxi')).not.toThrow();
  });

  it('rejects a profile that escapes the expected root through a symlink or junction', () => {
    const root = mkdtempSync(join(tmpdir(), 'lingxi-profile-probe-'));
    try {
      const approved = join(root, 'approved');
      const outside = join(root, 'outside');
      mkdirSync(approved);
      mkdirSync(outside);
      const link = join(approved, 'redirect');
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => assertBodyUserDataWithinRoot(join(link, 'profile'), approved)).toThrow('symlinks or junctions');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
