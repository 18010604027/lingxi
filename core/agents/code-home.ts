/**
 * The code agent's own folder, the only one open to it: its drafts, with copies of what it
 * works from put beside them before each task, so it never reaches outside:
 * - `_source/`: the pet's source, without dependencies, build output, data or the design notes;
 * - `_playbook/`: the standards, rules and catalog it follows.
 * The copies are mirrored (what was removed at the source goes here too), so an edit it made to them is undone by the
 * next task; they never go back.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What of the source is copied, top level. */
export const SOURCE_DIRS = ['core', 'body', 'workbench', 'tray', 'packs', 'packages', 'scripts', 'tests', 'tools'];
export const SOURCE_FILES = ['package.json', 'tsconfig.json', 'vitest.config.ts', 'README.md'];
/** Never copied, at any depth. */
export const SKIP_DIRS = ['node_modules', 'build', 'dist', '.git', 'scratch', 'data'];
/** The playbook, under the pet's workspace. */
export const PLAYBOOK = [['control', 'standards'], ['control', 'rules'], ['daily', 'catalog']];

/** Mirrors one folder; robocopy's exit codes under 8 are success. */
async function mirror(from: string, to: string): Promise<void> {
  if (!existsSync(from)) return;
  if (process.platform !== 'win32') {
    mkdirSync(to, { recursive: true });
    await run('rsync', ['-a', '--delete', ...SKIP_DIRS.flatMap((d) => ['--exclude', d]), `${from}/`, `${to}/`]);
    return;
  }
  try {
    await run('robocopy', [from, to, '/MIR', '/XD', ...SKIP_DIRS, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (typeof code !== 'number' || code >= 8) throw err;
  }
}

/** Brings the copies in the code agent's folder up to date with the source and the playbook. */
export async function refreshCodeHome(home: string, sourceRoot: string, workspace: string): Promise<void> {
  const source = join(home, '_source');
  mkdirSync(source, { recursive: true });
  for (const dir of SOURCE_DIRS) await mirror(join(sourceRoot, dir), join(source, dir));
  if (process.platform === 'win32') {
    try {
      await run('robocopy', [sourceRoot, source, ...SOURCE_FILES, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1'], { windowsHide: true });
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (typeof code !== 'number' || code >= 8) throw err;
    }
  } else {
    await run('cp', SOURCE_FILES.map((f) => join(sourceRoot, f)).filter(existsSync).concat(source));
  }
  for (const parts of PLAYBOOK) await mirror(join(workspace, ...parts), join(home, '_playbook', parts.join('-')));
}
