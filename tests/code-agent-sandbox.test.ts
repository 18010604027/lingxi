import { describe, expect, it } from 'vitest';
import { overlay, RUNNER_FAILURE } from '../core/agents/dsh.ts';
// @ts-expect-error a plain ES module DSH loads; no types
import { apply as fence } from '../core/agents/dsh-read-fence.mjs';
// @ts-expect-error a plain ES module DSH runs; no types
import { commandLine, parseArgs } from '../core/agents/dsh-mxc-runner.mjs';

describe("the code agent's own folder", () => {
  it('mounts the file fence as an inserted plugin and runs the shell through the MXC runner', () => {
    const yml = overlay({ provider: 'p', model: 'm' }, 'C:/s', 'C:/ws', 'workspace-write',
      { persona: 'x', disabled: [], readFence: { only: ['C:/data/drafts'] }, runner: ['C:/node.exe', 'C:/runner.mjs'] });
    expect(yml).toContain(['- insert:', '    - id: read-fence', '      name: "lingxi-read-fence"', '      config:',
      '        only: ["C:/data/drafts"]'].join('\n'));
    expect(yml).toContain(['- id: sandbox', '  config:', '    runnerCommand: ["C:/node.exe", "C:/runner.mjs"]',
      `    runnerFailureSignatures: [${JSON.stringify(RUNNER_FAILURE)}]`].join('\n'));
  });

  it('answers a path outside its folder as missing to its file tools, and lets its own through', async () => {
    const ctx = {
      fs: { resolve: async (path: string) => ({ targetKey: path, displayPath: path }) },
      on: () => {},
    };
    fence(ctx, { only: ['D:\\pet\\drafts'] });
    await expect(ctx.fs.resolve('D:\\pet\\drafts\\a\\b.ts')).resolves.toMatchObject({ targetKey: 'D:\\pet\\drafts\\a\\b.ts' });
    await expect(ctx.fs.resolve('d:/PET/drafts')).resolves.toBeTruthy();
    await expect(ctx.fs.resolve('D:\\pet\\data\\memory.sqlite')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
    await expect(ctx.fs.resolve('D:\\pet\\drafts-old\\x')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
    // a folder inside the open one can stay shut (a project's data, its .git)
    const shut = { fs: { resolve: async (path: string) => ({ targetKey: path, displayPath: path }) }, on: () => {} };
    fence(shut, { only: ['D:\\repo'], deny: ['D:\\repo\\build'] });
    await expect(shut.fs.resolve('D:\\repo\\core\\a.ts')).resolves.toBeTruthy();
    await expect(shut.fs.resolve('D:\\repo\\build\\data\\memory.sqlite')).rejects.toMatchObject({ code: 'FS_NOT_FOUND' });
  });

  it("reads DSH's sandbox arguments: the writable folders and the command after --", () => {
    expect(parseArgs(['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--tmpfs', '/tmp', '--bind', 'D:\\ws', 'D:\\ws', '--', 'pwsh', '-Command', 'x y']))
      .toEqual({ network: 'deny', writable: ['D:\\ws'], denied: [], command: ['pwsh', '-Command', 'x y'] });
    expect(parseArgs(['--network=allow', '--deny=D:\\ws\\data', '--ro-bind', '/', '/', '--', 'node'])).toEqual({ network: 'allow', writable: [], denied: ['D:\\ws\\data'], command: ['node'] });
  });

  it('turns the command back into a Windows command line that splits into the same arguments', () => {
    expect(commandLine(['C:\\Program Files\\x.exe', '-c', 'say "hi"', 'a\\b\\', ''])).toBe('"C:\\Program Files\\x.exe" -c "say \\"hi\\"" a\\b\\ ""');
    expect(commandLine(['p', 'ends with slash\\'])).toBe('p "ends with slash\\\\"');
  });
});
