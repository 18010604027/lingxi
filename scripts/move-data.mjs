/**
 * Moves her data from where the old app's development run keeps it to her own place:
 *
 *   build/data/home/companion   →  build/lingxi-pet/home/lingxi     (config, memory, ledger, plans, cases, judgments,
 *                                                                    reminders, the roles' DSH sessions, workspace)
 *   build/data/home/providers   →  build/lingxi-pet/home/providers  (the model endpoint and its key)
 *   build/data/extensions       →  build/lingxi-pet/extensions
 *
 * The old place is only read, never changed, so it stays as the backup. Run it again and the new place is first put
 * aside (`build/lingxi-pet.before-<time>`), then made again from the old one: it can be run as often as needed until
 * the old app is gone. Not moved: what only the old app used (its introduction, notices, console
 * theme, telemetry, alarms) and the speech models (`home/models`, fetched again when voice comes back).
 *
 * The roles behind her keep their DSH sessions in folders named after their working directories (the workspace, the
 * code agent's drafts in it); the folders are renamed for the new place so they pick up where they were.
 *
 *   node scripts/move-data.mjs [--from build/data] [--to build/lingxi-pet]
 */
import { cpSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const FROM = resolve(ROOT, arg('--from', join('build', 'data')));
const TO = resolve(ROOT, arg('--to', join('build', 'lingxi-pet')));
export const OLD_DEPLOYMENT = 'companion';
export const DEPLOYMENT = 'lingxi';
/** Files of the old deployment only the old app read. */
const OLD_APP_ONLY = new Set(['guide.json', 'notice.json', 'theme.json', 'telemetry.json', 'telemetry-id', 'alarms.json']);

/** DSH's folder name for a working directory: separators and the drive colon as dashes, between `--`. */
export const sessionKey = (dir) => `--${dir.replace(/[:\\/]+/g, '-').replace(/-+$/, '')}--`;

/** Whether the process that holds the app's instance lock is still running. */
function lockHeld(file) {
  if (!existsSync(file)) return false;
  try {
    process.kill(JSON.parse(readFileSync(file, 'utf8')).pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const oldDeploy = join(FROM, 'home', OLD_DEPLOYMENT);
if (!existsSync(oldDeploy)) { console.error(`Nothing to move: ${oldDeploy} is not there`); process.exit(1); }
for (const lock of [join(oldDeploy, 'data', 'instance.lock'), join(TO, 'home', DEPLOYMENT, 'data', 'instance.lock')]) {
  if (lockHeld(lock)) { console.error(`She is running (${lock}); stop her first`); process.exit(1); }
}

if (existsSync(TO)) {
  const aside = `${TO}.before-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(TO, aside);
  console.log(`the earlier move put aside: ${aside}`);
}

const newDeploy = join(TO, 'home', DEPLOYMENT);
cpSync(oldDeploy, newDeploy, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(oldDeploy.length + 1);
    return !(OLD_APP_ONLY.has(rel) || rel === join('data', 'instance.lock'));
  },
});
if (existsSync(join(FROM, 'home', 'providers'))) cpSync(join(FROM, 'home', 'providers'), join(TO, 'home', 'providers'), { recursive: true });
if (existsSync(join(FROM, 'extensions'))) cpSync(join(FROM, 'extensions'), join(TO, 'extensions'), { recursive: true });

// the roles' DSH sessions follow their working directories (the workspace, the code agent's drafts inside it)
const keyBody = (dir) => sessionKey(dir).slice(2, -2);
for (const kind of ['dsh-sessions', 'dsh-code-sessions']) {
  const dir = join(newDeploy, 'data', kind);
  if (!existsSync(dir)) continue;
  const from = `--${keyBody(oldDeploy)}-`.toLowerCase();
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().startsWith(from)) continue;
    const to = `--${keyBody(newDeploy)}-${name.slice(from.length)}`;
    renameSync(join(dir, name), join(dir, to));
    console.log(`${kind}: ${name} → ${to}`);
  }
}
console.log(`moved: ${oldDeploy} → ${newDeploy}`);
