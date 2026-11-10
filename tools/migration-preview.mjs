#!/usr/bin/env node
/**
 * Read-only migration inventory. It never copies, renames or parses file contents.
 * Provider and secret-looking paths are counted as omitted so the report cannot
 * accidentally expose credentials or personal text.
 */
import { readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const at = process.argv.indexOf('--from');
if (at < 0 || !process.argv[at + 1] || process.argv[at + 1].startsWith('--')) throw new Error('Specify a deployment directory with --from');
const from = resolve(process.argv[at + 1]);
if (!existsSync(from) || !lstatSync(from).isDirectory()) throw new Error('Deployment directory must exist and must not be a symbolic link');
const categories = [['workspace', 'workspace'], ['data', 'data']];
const secretPart = /^(?:\.env(?:\..*)?|\.git|providers?)$|secret|token|key|cookie|credential/i;

function walk(dir, out) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (secretPart.test(entry.name)) { out.omitted++; continue; }
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) { out.files++; out.bytes += lstatSync(file).size; }
    else out.omitted++;
  }
}

function inventory(label, path) {
  const totals = { files: 0, bytes: 0, omitted: 0 };
  const exists = existsSync(path);
  if (exists && lstatSync(path).isDirectory()) walk(path, totals);
  else if (exists) totals.omitted++;
  return { category: label, path: label, exists, ...totals };
}

// These flags are only file-presence hints. A WAL may contain committed data,
// and a lock file alone cannot prove that a process is alive.
const dataDir = join(from, 'data');
function hint(name) {
  if (!existsSync(dataDir) || !lstatSync(dataDir).isDirectory()) return null;
  const path = join(dataDir, name);
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? true : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
const hints = { taskWalPresent: hint('bus.sqlite-wal'), instanceLockPresent: hint('instance.lock') };
const report = { version: 1, readOnly: true, entries: categories.map(([label, suffix]) => inventory(label, join(from, suffix))), hints, uninspected: ['providers', 'extensions'] };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
