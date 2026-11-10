/**
 * A DSH plugin the code agent's profile loads: the code agent sees only its own folder, a
 * small world of its own (its drafts, and copies of the pet's source and playbook put there before each task,
 * agents/code-home.ts). DSH's file tools may otherwise open anything, so this wraps `ctx.fs.resolve`, which every read,
 * listing and write goes through, and answers any path outside the folders in `only` as not there.
 *
 * Installed into the profile as the package `lingxi-read-fence` (dsh.ts `installReadFence`). Config: `only`, a list
 * of absolute folders, and `deny`, folders inside them that stay shut.
 */
export const name = 'lingxi-read-fence';
export const inject = ['fs'];

const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const under = (path, root) => path === root || path.startsWith(`${root}/`);

export function apply(ctx, config) {
  const only = (config?.only ?? []).map(norm);
  // folders inside the open ones that stay shut all the same (a project's data, its .git)
  const deny = (config?.deny ?? []).map(norm);
  const fs = ctx.fs;
  const resolve = fs.resolve;
  fs.resolve = async function fenced(path, opts) {
    const target = await resolve.call(this, path, opts);
    const key = norm(target.targetKey);
    if (!only.some((root) => under(key, root)) || deny.some((root) => under(key, root))) {
      // as missing, not as denied: DSH itself looks up the parents for project files (.git, instruction files) and takes a
      // missing one in its stride, while a denial would fail the turn
      const error = new Error(`"${target.displayPath}" does not exist for you: only your own folder is open to you`);
      error.name = 'FsError';
      error.code = 'FS_NOT_FOUND';
      throw error;
    }
    return target;
  };
  ctx.on('dispose', () => { fs.resolve = resolve; });
}

export default { name, inject, apply };
