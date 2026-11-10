/** Exports only generated grey images; invoke with an explicit disposable output directory. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateSamples } from './generate.ts';

const destination = process.argv[2];
if (!destination) throw new Error('Usage: pnpm exec tsx tests/fixtures/workarea/generate-cli.ts scratch/workarea');
const directory = resolve(destination);
mkdirSync(directory, { recursive: true });
const labels = generateSamples().map(({ gray, ...label }) => {
  const file = `${label.id.replaceAll('/', '-')}.pgm`;
  const header = Buffer.from(`P5\n${label.width} ${label.height}\n255\n`);
  writeFileSync(join(directory, file), Buffer.concat([header, gray]));
  return { ...label, file };
});
writeFileSync(join(directory, 'labels.json'), JSON.stringify(labels, null, 2));
console.info(`${labels.length} synthetic grey strips: ${directory}`);
