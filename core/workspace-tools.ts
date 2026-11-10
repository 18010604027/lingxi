/** Text memory files owned by Lingxi, with an explicit filesystem root and ordinary Git snapshots. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { Logger, ToolDef, ToolOutcome } from './contracts.ts';

export interface GitAuthor { name: string; email: string }
const APP: GitAuthor = { name: 'lingxi-pet', email: 'app@persona.local' };
const SELF: GitAuthor = { name: 'lingxi', email: 'lingxi@persona.local' };
const BACK: GitAuthor = { name: 'background', email: 'background@persona.local' };

export class WorkspaceFiles {
  readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly gitPresent: boolean;
  constructor(root: string, private readonly log?: Logger) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
    Object.assign(this.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_TERMINAL_PROMPT: '0' });
    try { execFileSync('git', ['--version'], { env: this.env, stdio: 'ignore', windowsHide: true }); this.gitPresent = true; }
    catch { this.gitPresent = false; }
  }

  private inside(path: string): string {
    const rel = relative(this.root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path leaves the workspace');
    if (rel.split(/[\\/]/).some((part) => part.toLowerCase() === '.git')) throw new Error('Git internals are not memory files');
    return rel.replace(/\\/g, '/');
  }

  path(input: string): string {
    if (isAbsolute(input) || /^[a-z]:/i.test(input) || input.includes('\0')) throw new Error('Use a relative workspace path');
    const target = resolve(this.root, input || '.');
    this.inside(target);
    let parent = target;
    const suffix: string[] = [];
    while (!existsSync(parent)) {
      // A dangling link must not become a write target after its destination appears.
      try { if (lstatSync(parent).isSymbolicLink()) throw new Error('Dangling links are not memory paths'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
    const actual = resolve(realpathSync(parent), ...suffix);
    this.inside(actual);
    return actual;
  }

  files(dir = ''): string[] {
    const start = this.path(dir);
    const found: string[] = [];
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) continue;
        const file = join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) found.push(this.inside(file));
      }
    };
    walk(start);
    return found;
  }

  private git(args: string[], author = APP): string {
    const empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
    return execFileSync('git', ['-C', this.root, '-c', `safe.directory=${this.root}`, '-c', `core.hooksPath=${empty}`,
      '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, ...args],
    { env: this.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
  }

  gitAvailable(): boolean { return this.gitPresent; }

  private ensureRepo(): boolean {
    if (!this.gitPresent) return false;
    const dotgit = join(this.root, '.git');
    if (existsSync(dotgit) && (!lstatSync(dotgit).isDirectory() || lstatSync(dotgit).isSymbolicLink())) {
      throw new Error('Workspace Git must belong to this directory');
    }
    if (!existsSync(dotgit)) this.git(['init', '--quiet']);
    const ignore = this.path('.gitignore');
    const text = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
    if (!text.split(/\r?\n/).includes('blobs/')) writeFileSync(ignore, `${text}${text && !text.endsWith('\n') ? '\n' : ''}blobs/\n`);
    this.git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', 'blobs']);
    try { this.git(['rev-parse', '--verify', 'HEAD']); }
    catch { this.git(['add', '--all', '--', '.']); this.git(['commit', '--quiet', '--allow-empty', '-m', 'checkpoint0']); }
    return true;
  }

  commit(message: string, author = APP): void {
    try {
      if (!this.ensureRepo() || !this.git(['status', '--porcelain'])) return;
      this.git(['add', '--all', '--', '.']);
      this.git(['commit', '--quiet', '-m', message], author);
    } catch (error) { this.log?.warn('Workspace snapshot failed; file contents remain saved', { error }); }
  }

  snapshot(version: string): void {
    try {
      if (!this.ensureRepo()) return;
      this.commit('Changes from before this start');
      const tag = `start-${version}`;
      this.git(['check-ref-format', `refs/tags/${tag}`]);
      if (!this.git(['tag', '--list', tag])) this.git(['tag', '-a', tag, '-m', `The workspace as version ${version} found it`]);
    } catch (error) { this.log?.warn('Workspace start snapshot failed', { error }); }
  }

  save(path: string, content: string, role = 'front', append = false): void {
    const file = this.path(path);
    const rel = this.inside(file);
    const fence = role === 'control' ? 'control/' : role === 'coder' ? 'control/drafts/' : null;
    if (fence && !rel.startsWith(fence)) throw new Error(`The ${role} role writes only under ${fence}`);
    // Establish the pre-write snapshot without making Git a dependency of file memory.
    try { this.ensureRepo(); } catch (error) { this.log?.warn('Workspace Git unavailable for this write', { error }); }
    mkdirSync(dirname(file), { recursive: true });
    if (append) appendFileSync(file, content, 'utf8'); else writeFileSync(file, content, 'utf8');
    this.commit(`${role === 'front' || role === 'main' ? 'Lingxi' : 'Background'} ${append ? 'appended to' : 'wrote'} ${rel}`, fence ? BACK : SELF);
  }

  tools(): ToolDef[] {
    const safe = (run: (args: Record<string, unknown>, role: string) => string): ToolDef['handler'] => async (args, context): Promise<string | ToolOutcome> => {
      context.signal?.throwIfAborted();
      try { return run(args, context.role); }
      catch (error) { return { text: `[denied] ${error instanceof Error ? error.message : String(error)}`, failed: true }; }
    };
    const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
    const path = { type: 'string', description: 'Path relative to your memory workspace.' };
    return [
      { name: 'read_file', description: 'Read a text memory file. Optional offset and limit select lines (1-based).', tags: ['read'],
        parameters: schema({ path, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, ['path']),
        handler: safe((args) => {
          const file = this.path(String(args.path ?? ''));
          const bytes = readFileSync(file);
          if (bytes.includes(0)) throw new Error('This is a binary file; use a text memory file');
          const lines = bytes.toString('utf8').split(/\r?\n/);
          const start = Math.max(0, Number(args.offset ?? 1) - 1);
          const chosen = args.limit === undefined ? lines.slice(start) : lines.slice(start, start + Number(args.limit));
          return chosen.map((line, index) => `${start + index + 1}: ${line}`).join('\n');
        }) },
      { name: 'write_file', description: 'Save the complete text of a memory file; parent directories are created.', tags: ['write'],
        parameters: schema({ path, content: { type: 'string' } }, ['path', 'content']),
        handler: safe((args, role) => { this.save(String(args.path ?? ''), String(args.content ?? ''), role); return `[written] ${args.path}`; }) },
      { name: 'append_file', description: 'Append text to a memory file, including control notes.', tags: ['write'],
        parameters: schema({ path, content: { type: 'string' } }, ['path', 'content']),
        handler: safe((args, role) => { this.save(String(args.path ?? ''), String(args.content ?? ''), role, true); return `[appended] ${args.path}`; }) },
      { name: 'list_files', description: 'List files and directories directly under a workspace directory.', tags: ['read'],
        parameters: schema({ dir: path }), handler: safe((args) => readdirSync(this.path(String(args.dir ?? '')), { withFileTypes: true })
          .filter((entry) => entry.name.toLowerCase() !== '.git' && !entry.isSymbolicLink())
          .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`).sort().join('\n')) },
      { name: 'glob_files', description: 'Find memory files by a glob such as partner/**/*.md.', tags: ['read'],
        parameters: schema({ pattern: { type: 'string' } }, ['pattern']),
        handler: safe((args) => this.files().filter((file) => matchesGlob(file, String(args.pattern ?? '**/*'))).join('\n')) },
      { name: 'grep_files', description: 'Find literal text, ignoring case, in memory files. Returns path, line number and matching text.', tags: ['read'],
        parameters: schema({ query: { type: 'string' }, pattern: { type: 'string' } }, ['query']),
        handler: safe((args) => {
          const query = String(args.query ?? '').toLowerCase();
          if (!query) throw new Error('Provide text to search for');
          return this.files().filter((file) => matchesGlob(file, String(args.pattern ?? '**/*'))).flatMap((file) => {
            const bytes = readFileSync(this.path(file));
            if (bytes.includes(0)) return [];
            return bytes.toString('utf8').split(/\r?\n/).flatMap((line, index) => line.toLowerCase().includes(query) ? [`${file}:${index + 1}: ${line}`] : []);
          }).join('\n');
        }) },
    ];
  }
}
