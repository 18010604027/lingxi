/** Validate the resources required by a selected pack before starting any windows. */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Pack } from './pack.ts';

const require = createRequire(import.meta.url);
const { loadMotion } = require('../../body/motion-loader.cjs') as {
  loadMotion(env: { BODY_MOTION: string }): { source: string };
};

export function validatePackResources(pack: Pack): { motion: string; clips: string[] } {
  const names = new Set([...pack.figure.idle, ...pack.figure.held, ...pack.figure.noMirror]);
  for (const move of [...pack.figure.moves.walk, ...pack.figure.moves.run, ...(pack.figure.moves.cross ? [pack.figure.moves.cross] : [])]) names.add(move.clip);
  for (const clips of Object.values(pack.figure.words)) for (const name of clips) names.add(name);
  const missing: string[] = [];
  for (const name of names) {
    if (!name.trim() || /[\\/]/.test(name) || name === '.' || name === '..') throw new Error(`Invalid clip name in figure pack: ${name}`);
    try { if (!statSync(join(pack.clips, `${name}.webm`)).isFile()) missing.push(name); }
    catch { missing.push(name); }
  }
  if (missing.length) throw new Error(`figure pack ${pack.dir}: missing clips in ${pack.clips}: ${missing.join(', ')}`);
  const motion = loadMotion({ BODY_MOTION: join(pack.dir, 'motion.cjs') }).source;
  return { motion, clips: [...names] };
}
