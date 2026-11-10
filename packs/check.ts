/** Check pack resources through the same validation as the launcher. */
import { resolve } from 'node:path';
import { loadPack } from '../core/behavior/pack.ts';
import { validatePackResources } from '../core/behavior/pack-resources.ts';

const folder = process.argv[2];
if (!folder) {
  console.error('usage: pnpm check:pack <pack folder>');
  process.exit(2);
}
try {
  const pack = loadPack(resolve(folder), resolve(folder));
  const resources = validatePackResources(pack);
  console.log(`figure pack ${pack.dir}\n  name: ${pack.figure.name}\n  clips folder: ${pack.clips}\n  clips named: ${resources.clips.length}\n  motion module: ${resources.motion}\nok`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
