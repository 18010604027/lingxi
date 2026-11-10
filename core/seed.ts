/** First-run files of the app's deployment. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appLanguage, APP_LANGUAGES, type AppLanguage } from './language.ts';
import { EARLIER_PERSONAS } from './seed-history.ts';

/** The deployment's folder under the Lingxi data root. */
export const DEPLOYMENT = process.env.LINGXI_DEPLOYMENT ?? 'lingxi';
export const CONSOLE_PORT = 17788;
export const DISPLAY_NAME = '灵犀';
/** The provider module identifier used in endpoint configuration. */
const MODULE = 'lingxi';
/** The module ids earlier versions named: `deepseek` and, before this one, `coo`. */
const OLD_MODULE = 'deepseek';
/** The endpoint a new install starts on: DeepSeek is the one service the provider lists. */
export const SEED_ENDPOINT = 'deepseek';
/** Its config: DeepSeek's API, the fast model that reads images, thinking on; the key goes into the endpoint's `.env`. */
export const SEED_ENTRY = {
  kind: MODULE,
  baseUrl: 'https://api.deepseek.com',
  secret: 'DEEPSEEK_API_KEY',
  spec: { model: 'deepseek-flash', thinking: true, reasoningEffort: 'high' },
  multimodal: true,
  pricing: [] as unknown[],
  options: {},
};
/** When computer use asks first (`worlds.desktop-pet.cua.permission`): new installs get it written out, so a config without it is from before and keeps the default it had. */
const CUA_ASK = 'ask-once';
const OLD_CUA_ASK = 'ask-each-turn';
const SEED_DIR = fileURLToPath(new URL('./seed/', import.meta.url));
/** The self-description she starts from, in `SEED_DIR/persona/<id>.<language>.md`, one per app language. */
export const PERSONAS = ['lingxi'] as const;
export type PersonaId = typeof PERSONAS[number];
/** The workspace file that holds her self-description. */
const CONSTITUTION = 'CONSTITUTION.md';
export const personaFile = (id: PersonaId, language: AppLanguage) => join(SEED_DIR, 'persona', `${id}.${language}.md`);

/**
 * Writes the first-run files that are missing. A new deployment config gets `language` and an
 * endpoint without a key: DeepSeek's, the one service the provider lists. Existing files are left as the
 * operator made them, except a self-description
 * still exactly as a version seeded it, which becomes the same persona in the config's `language`
 * (`followLanguage`), endpoints of the old `deepseek` module, which now belong
 * to `lingxi`, a config of computer use as its own World (`worlds.cua`), whose section, whether it was on
 * included, moves to `worlds.desktop-pet.cua`, a config without a computer-use `permission`, which
 * keeps the earlier permission value when an existing configuration already has one, and normalizes legacy
 * console keys during migration.
 */
export function seed(home: string, language: AppLanguage, deployment = DEPLOYMENT): void {
  const deploy = join(home, deployment);
  const workspace = join(deploy, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, 'providers'), { recursive: true });
  const write = (file: string, value: unknown) => { if (!existsSync(file)) writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
  write(join(deploy, 'deployment.json'), { app: 'lingxi' });
  const config = join(deploy, 'config.json');
  const upgrading = existsSync(config);
  if (!upgrading) {
    const endpoint = join(home, 'providers', SEED_ENDPOINT);
    mkdirSync(endpoint, { recursive: true });
    write(join(endpoint, 'config.json'), SEED_ENTRY);
    write(config, {
      displayName: DISPLAY_NAME,
      language,
      activeProvider: SEED_ENDPOINT,
      providerSchemaVersion: 3,
      web: { port: CONSOLE_PORT },
      worlds: { 'desktop-pet': { cua: { permission: CUA_ASK } } },
    });
  }
  const configured = appLanguage((JSON.parse(readFileSync(config, 'utf8')) as { language?: unknown }).language);
  // a new deployment starts as Lingxi; the introduction can still change it
  if (!existsSync(join(workspace, CONSTITUTION))) copyFileSync(personaFile('lingxi', configured), join(workspace, CONSTITUTION));
  // the console shows it as the bot's avatar
  if (!existsSync(join(deploy, 'avatar.png'))) copyFileSync(join(SEED_DIR, 'avatar.png'), join(deploy, 'avatar.png'));
  followLanguage(workspace, configured);
  moveEndpointsToLingxi(join(home, 'providers'));
  if (upgrading) {
    moveCuaIntoPet(config);
    keepCuaAsking(config);
    moveTerminalToConsole(deploy, config);
  }
}

type Section = Record<string, unknown>;
type WorldSections = { worlds?: Record<string, Section | undefined> };

/** Normalize legacy console keys and folders while preserving already migrated values. */
function moveTerminalToConsole(deploy: string, file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections & { logging?: Section };
  let changed = false;
  const old = config.worlds?.terminal;
  if (config.worlds && old) {
    config.worlds.console = { ...old, ...config.worlds.console };
    delete config.worlds.terminal;
    changed = true;
  }
  const logging = config.logging;
  if (logging && 'console' in logging) {
    logging.stdout ??= logging.console;
    delete logging.console;
    changed = true;
  }
  if (changed) writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  const prompts = join(deploy, 'worlds', 'terminal');
  if (existsSync(prompts) && !existsSync(join(deploy, 'worlds', 'console'))) renameSync(prompts, join(deploy, 'worlds', 'console'));
}

/** `worlds.cua` becomes `worlds.desktop-pet.cua`; a key already there stays as it is. */
function moveCuaIntoPet(file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections;
  const old = config.worlds?.cua;
  if (!config.worlds || !old) return;
  const pet = config.worlds['desktop-pet'] ?? {};
  config.worlds['desktop-pet'] = { ...pet, cua: { ...old, ...pet.cua as Section | undefined } };
  delete config.worlds.cua;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function keepCuaAsking(file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections;
  const pet = config.worlds?.['desktop-pet'];
  const cua = pet?.cua as Section | undefined;
  if (cua?.permission !== undefined) return;
  config.worlds = { ...config.worlds, 'desktop-pet': { ...pet, cua: { ...cua, permission: OLD_CUA_ASK } } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function moveEndpointsToLingxi(providers: string): void {
  for (const dir of readdirSync(providers, { withFileTypes: true })) {
    const file = join(providers, dir.name, 'config.json');
    if (!dir.isDirectory() || !existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, 'utf8')) as { kind?: string };
    if (config.kind !== OLD_MODULE && config.kind !== 'coo') continue;
    config.kind = MODULE;
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  }
}

/** SHA-256 of a file's text with line endings as LF; null when it is missing. */
const hashOf = (file: string) => (existsSync(file) ? createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex') : null);

/** Each shipped self-description by the SHA-256 of its text; computed on first use. */
let shipped: Map<string, PersonaId> | null = null;

/**
 * The persona whose shipped self-description the workspace's is, in any language, exactly; null for one
 * the person or she changed. Self-descriptions earlier versions shipped (seed-history.ts) count as theirs.
 */
export function personaOf(workspace: string): PersonaId | null {
  const hash = hashOf(join(workspace, CONSTITUTION));
  shipped ??= new Map(PERSONAS.flatMap((id) => APP_LANGUAGES.map((l) => [hashOf(personaFile(id, l))!, id] as const)));
  return hash === null ? null : shipped.get(hash) ?? EARLIER_PERSONAS[hash] ?? null;
}

/** Puts persona `id` in `language` in place of the workspace's self-description; the bot reads it from its next prefix on. */
export function applyPersona(workspace: string, id: PersonaId, language: AppLanguage): void {
  copyFileSync(personaFile(id, language), join(workspace, CONSTITUTION));
}

/**
 * Puts the same persona in `language` in place of a self-description still exactly as a version shipped it;
 * one the person or she changed stays. The bot reads the new one from its next session on.
 */
export function followLanguage(workspace: string, language: AppLanguage): void {
  const id = personaOf(workspace);
  if (id && hashOf(join(workspace, CONSTITUTION)) !== hashOf(personaFile(id, language))) applyPersona(workspace, id, language);
}
