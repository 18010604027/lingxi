/**
 * A figure pack: one folder the person provides, holding the clips and the table that says what they mean.
 *
 *   <pack>/figure.json     the figure table: sizes, hit box, idle/held clips, moves, action words, vocabulary
 *   <pack>/clips/*.webm    the clips it names (`LINGXI_CLIPS` may point at another folder instead)
 *
 * No pack ships with this repository: which figure she is, and what her clips show, is the person's own data. The
 * format is documented in `packs/README.md`, with a machine-readable copy in `packs/figure.schema.json`.
 *
 * Which pack: `LINGXI_PACK` (a folder path, or an id under `<root>/packs`), else the path noted in `~/.lingxi/pack`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Figure } from './plan.ts';

export interface Pack {
  dir: string;
  figure: Figure;
  /** Where the clips are: the pack's own `clips/`, or `LINGXI_CLIPS` when someone points it elsewhere. */
  clips: string;
}

const HOW = 'no figure pack configured: set LINGXI_PACK to the folder holding figure.json, or write that path into ~/.lingxi/pack (format: packs/README.md)';

/** A bare id means `<root>/packs/<id>`; anything with a separator is a path, taken from `root` when relative. */
function asPath(root: string, idOrPath: string): string {
  if (/[\\/]/.test(idOrPath)) return resolve(root, idOrPath);
  return join(root, 'packs', idOrPath);
}

/** Where the pack is, without reading it. Throws when the person has not named one. */
export function packDir(root: string, idOrPath = process.env.LINGXI_PACK ?? '', notedPath = join(homedir(), '.lingxi', 'pack')): string {
  if (idOrPath) return asPath(root, idOrPath);
  const chosen = existsSync(notedPath) ? readFileSync(notedPath, 'utf8').trim() : '';
  if (chosen) return asPath(root, chosen);
  throw new Error(HOW);
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Field-by-field check of a figure table; the message names the field so a person can fix their pack. */
export function checkFigure(figure: unknown, where: string): Figure {
  const fail = (field: string, wanted: string): never => {
    throw new Error(`figure pack ${where}: ${field} ${wanted} (format: packs/README.md)`);
  };
  if (!isObject(figure)) fail('figure.json', 'must be an object');
  const f = figure as Record<string, unknown>;
  if (!isString(f.name) || !f.name.trim()) fail('name', 'must be a non-empty string');
  if (!isNumber(f.refWidth) || f.refWidth <= 0) fail('refWidth', 'must be a positive number');
  if (!isNumber(f.bodyWidth) || f.bodyWidth <= 0) fail('bodyWidth', 'must be a positive number');
  if (f.nativeFacing !== 'left' && f.nativeFacing !== 'right') fail('nativeFacing', 'must be "left" or "right"');
  for (const field of ['idle', 'held']) {
    const list = f[field];
    if (!Array.isArray(list) || !list.every(isString) || list.length === 0) fail(field, 'must be a non-empty array of clip names');
  }
  if (!Array.isArray(f.noMirror) || !f.noMirror.every(isString)) fail('noMirror', 'must be an array of clip names (use [] when none)');
  if (f.canvas !== undefined) {
    const canvas = f.canvas;
    if (!isObject(canvas) || !isNumber(canvas.width) || !isNumber(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
      fail('canvas', 'must be { width, height } with positive numbers');
    }
  }
  if (!isObject(f.moves)) fail('moves', 'must be an object');
  const moves = f.moves as Record<string, unknown>;
  const move = (value: unknown, field: string): void => {
    if (!isObject(value)) fail(field, 'must be an object');
    const m = value as Record<string, unknown>;
    if (!isString(m.clip) || !m.clip.trim()) fail(`${field}.clip`, 'must be a clip file name');
    for (const key of ['leadSec', 'tailSec', 'minDist', 'maxDist']) {
      if (!isNumber(m[key]) || (m[key] as number) < 0) fail(`${field}.${key}`, 'must be a number of zero or more');
    }
    if (m.segment !== undefined) {
      const segment = m.segment;
      if (!isObject(segment) || !isNumber(segment.startSec) || !isNumber(segment.endSec) || segment.endSec <= segment.startSec) {
        fail(`${field}.segment`, 'must be { startSec, endSec } with endSec after startSec');
      }
    }
  };
  if (!Array.isArray(moves.walk) || moves.walk.length === 0) fail('moves.walk', 'must be a non-empty array of moves');
  (moves.walk as unknown[]).forEach((entry, i) => move(entry, `moves.walk[${i}]`));
  if (!Array.isArray(moves.run)) fail('moves.run', 'must be an array of moves');
  (moves.run as unknown[]).forEach((entry, i) => move(entry, `moves.run[${i}]`));
  if (moves.teleport !== undefined && typeof moves.teleport !== 'boolean') fail('moves.teleport', 'must be true or false');
  if (moves.cross !== undefined) move(moves.cross, 'moves.cross');
  if (!isObject(f.words)) fail('words', 'must be an object of action word to clip names');
  for (const [word, clips] of Object.entries(f.words as Record<string, unknown>)) {
    if (!Array.isArray(clips) || clips.length === 0 || !clips.every(isString)) fail(`words.${word}`, 'must be a non-empty array of clip names');
  }
  if (f.vocab !== undefined) {
    if (!isObject(f.vocab)) fail('vocab', 'must be an object');
    for (const [word, entry] of Object.entries(f.vocab as Record<string, unknown>)) {
      if (!isObject(entry)) fail(`vocab.${word}`, 'must be an object');
      const e = entry as Record<string, unknown>;
      if (e.kind !== 'motion' && e.kind !== 'expression') fail(`vocab.${word}.kind`, 'must be "motion" or "expression"');
      if (!Array.isArray(e.zh) || !e.zh.every(isString)) fail(`vocab.${word}.zh`, 'must be an array of Chinese names');
      if (!isString(e.about)) fail(`vocab.${word}.about`, 'must be a sentence on what it looks like');
    }
  }
  return figure as Figure;
}

/** The pack's figure and clips; a missing or malformed pack fails here with the folder and the field. */
export function loadPack(root: string, idOrPath?: string): Pack {
  const dir = packDir(root, idOrPath);
  const file = join(dir, 'figure.json');
  if (!existsSync(file)) throw new Error(`figure pack ${dir}: no figure.json (format: packs/README.md)`);
  let figure: unknown;
  try {
    figure = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`figure pack ${dir}: figure.json is not valid JSON (${(error as Error).message})`);
  }
  return { dir, figure: checkFigure(figure, dir), clips: process.env.LINGXI_CLIPS ?? join(dir, 'clips') };
}

/** What the person changed about one action in the workbench; the pack file itself is never written. */
export interface ActionOverride {
  /** The clips this action plays, in the person's order; an empty or missing list keeps the pack's. */
  clips?: string[];
  /** Chinese names the front may use. */
  zh?: string[];
  about?: string;
  when?: string;
  /** How the action feels, as free tags; the selectors match on them. */
  mood?: string[];
}

const cleanList = (list: unknown): string[] | undefined => {
  if (!Array.isArray(list)) return undefined;
  const items = list.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

/**
 * Puts the person's action settings on top of the pack, in place: the behaviour system and the front keep the same
 * figure object, so the change applies to the next action without a restart. Only the fields someone set change.
 */
const sameList = (a?: string[], b?: string[]): boolean => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** True when this override says exactly what the pack already says, so it need not be kept. */
export function isRedundantOverride(packFigure: Figure, id: string, override: ActionOverride | null): boolean {
  if (!override) return false;
  const vocab = packFigure.vocab?.[id];
  if (override.clips && !sameList(override.clips, packFigure.words[id])) return false;
  if (override.zh && !sameList(override.zh, vocab?.zh)) return false;
  if (override.mood && !sameList(override.mood, vocab?.mood)) return false;
  if (override.about !== undefined && override.about !== (vocab?.about ?? '')) return false;
  if (override.when !== undefined && override.when !== (vocab?.when ?? '')) return false;
  return true;
}

export function applyActionOverrides(figure: Figure, overrides: Record<string, ActionOverride> | undefined): Figure {  if (!overrides) return figure;
  for (const [id, override] of Object.entries(overrides)) {
    if (!override || typeof override !== 'object') continue;
    const clips = cleanList(override.clips);
    if (clips) figure.words[id] = clips;
    const base = figure.vocab?.[id] ?? { kind: 'motion' as const, zh: [], about: '' };
    const zh = cleanList(override.zh) ?? base.zh;
    const about = typeof override.about === 'string' && override.about.trim() ? override.about.trim() : base.about;
    const when = typeof override.when === 'string' && override.when.trim() ? override.when.trim() : base.when;
    const mood = cleanList(override.mood) ?? base.mood;
    figure.vocab = { ...(figure.vocab ?? {}), [id]: { ...base, zh, about, when, ...(mood ? { mood } : {}) } };
  }
  return figure;
}
