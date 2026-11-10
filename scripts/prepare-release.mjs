/** Copy only tracked product files into a fresh local candidate; never commit or push. */
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
// Only these new product files may join the tracked allowlist before their first commit.
files.push('EXTENDING.md', 'scripts/prepare-release.mjs', 'scripts/setup-app.ts', 'core/behavior/pack-resources.ts', 'tests/pack-setup.test.ts');
const top = new Set(['.gitattributes', '.gitignore', 'LICENSE', 'README.md', 'EXTENDING.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts']);
const single = new Set(['scripts/move-data.mjs', 'scripts/memory-replay.ts', 'scripts/scene-calibrate.ts', 'scripts/setup-app.ts', 'scripts/prepare-release.mjs', 'tools/migration-preview.mjs', 'tools/standalone-config.mjs', 'packs/README.md', 'packs/figure.schema.json', 'packs/check.ts']);
const allowed = (path) => top.has(path) || single.has(path) || /^(body|core|packages|tests|tray|workbench)\//.test(path)
  && !/(^|\/)(node_modules|build|dist|ref|\.tmp)(\/|$)/.test(path)
  && !/(^|\/)(dsh-plugin[^/]*|dsh-ui\.test\.js|memory-eval\.test\.ts|fixtures\/workarea\/README\.md|[^/]*\.(log|jsonl))$/.test(path);
const selected = [...new Set(files.filter(allowed))].sort();
const included = new Set(selected);
for (const required of [...top, 'core/start.ts', 'body/main.cjs', 'workbench/main.cjs', 'tray/main.cjs']) {
  if (!selected.includes(required)) throw new Error(`Missing release file: ${required}`);
}
// Refuse links before creating a candidate so local paths cannot pull in outside data.
for (const path of selected) {
  for (let part = path; part !== '.'; part = dirname(part)) {
    if (lstatSync(join(root, part)).isSymbolicLink()) throw new Error(`Release file uses a link: ${path}`);
  }
  if (!lstatSync(join(root, path)).isFile()) throw new Error(`Not a regular release file: ${path}`);
}
// A clean tree is only useful if its local imports still resolve inside the tree.
for (const file of selected.filter((file) => /\.(ts|mts|js|mjs|cjs)$/.test(file))) {
  const imports = ts.preProcessFile(readFileSync(join(root, file), 'utf8'), true, true).importedFiles;
  for (const entry of imports) {
    if (!entry.fileName.startsWith('.')) continue;
    const resolved = resolve(dirname(join(root, file)), entry.fileName);
    const candidates = [resolved, ...['.ts', '.js', '.mjs', '.cjs', '/index.ts', '/index.js'].map((suffix) => resolved + suffix)];
    if (!candidates.some((candidate) => included.has(relative(root, candidate).replaceAll('\\', '/')))) {
      throw new Error(`Release import is missing: ${file} -> ${entry.fileName}`);
    }
  }
}
const output = mkdtempSync(join(tmpdir(), 'lingxi-release-'));
for (const path of selected) {
  mkdirSync(dirname(join(output, path)), { recursive: true });
  copyFileSync(join(root, path), join(output, path));
}
writeFileSync(`${output}.manifest.txt`, selected.join('\n') + '\n');
writeFileSync(`${output}.sha256.json`, JSON.stringify(Object.fromEntries(selected.map((file) => [file, createHash('sha256').update(readFileSync(join(output, file))).digest('hex')])), null, 2));
console.log(JSON.stringify({ directory: output, manifest: `${output}.manifest.txt`, hashes: `${output}.sha256.json`, files: selected.length, source: 'current working tree; no commit or push' }, null, 2));
