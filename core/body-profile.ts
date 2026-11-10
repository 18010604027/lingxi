import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';

/** Build the Chromium profile switch for an explicitly isolated body launch. */
export function bodyUserDataArgs(userData: string | undefined): string[] {
  if (!userData) return [];
  if (!isAbsolute(userData)) throw new Error('BODY_USER_DATA must be an absolute path');
  return [`--user-data-dir=${resolve(userData)}`];
}

function canonicalNoLinks(value: string): string {
  const resolved = resolve(value);
  const { root } = parse(resolved);
  let current = root;
  for (const part of resolved.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('BODY_USER_DATA path must not contain symlinks or junctions');
      current = realpathSync.native(current);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return resolve(current);
}

/** Validate the launcher's fail-closed probe mode before spawning Electron. */
export function assertBodyUserDataWithinRoot(userData: string | undefined, expectedRoot: string | undefined): void {
  if (!userData || !expectedRoot || !isAbsolute(userData) || !isAbsolute(expectedRoot)) {
    throw new Error('BODY_BOOT_MARKER requires absolute BODY_USER_DATA and BODY_USER_DATA_EXPECTED_ROOT paths');
  }
  const actual = canonicalNoLinks(userData);
  const root = canonicalNoLinks(expectedRoot);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('BODY_USER_DATA must resolve inside BODY_USER_DATA_EXPECTED_ROOT');
  }
}

/** Validate Electron's effective app.getPath('userData') against the approved profile. */
export function assertBodyUserData(actual: string, expected: string): void {
  if (!isAbsolute(actual) || !isAbsolute(expected) || resolve(actual).toLowerCase() !== resolve(expected).toLowerCase()) {
    throw new Error('Electron effective userData does not match the approved absolute profile');
  }
}
