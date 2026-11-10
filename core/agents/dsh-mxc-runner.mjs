/**
 * The code agent's shell sandbox: DSH runs each confined command through this runner
 * (`runnerCommand` of dsh-sandbox-local) with bwrap-style arguments appended, and it runs the command in a Microsoft
 * eXecution Container (@microsoft/mxc-sdk), whose policy denies by default. So the command reads and writes only its
 * own folder, the one DSH binds writable (or, in read-only mode, the folder it runs in, for reading), and reaches no
 * network; the system's own folders stay readable to every container. DSH's built-in Windows sandbox fences writes
 * only; this is what makes reads stop at its folder too.
 *
 * Arguments: first our own `--network=allow|deny` (deny when absent; dsh.ts `mxcRunner` sets it) and `--deny=<dir>` for
 * each folder inside the writable ones that stays shut, then from DSH
 * `--bind <dir> <dir>` for each writable folder (the rest of the bwrap profile has no meaning here and is
 * skipped), then `--` and the command. A failure of the runner itself is written to stderr after `mxc-runner:`, which
 * DSH is told to recognise (dsh.ts RUNNER_FAILURE), so it is not taken for a failed command.
 */
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (message) => {
  process.stderr.write(`mxc-runner: ${message}\n`);
  process.exit(125);
};

/** A command line Windows splits back into these arguments (CommandLineToArgvW's rules). */
export function commandLine(argv) {
  return argv.map((a) => {
    if (a !== '' && !/[\s"]/.test(a)) return a;
    let out = '"';
    let slashes = 0;
    for (const ch of a) {
      if (ch === '\\') { slashes++; continue; }
      if (ch === '"') { out += '\\'.repeat(slashes * 2 + 1) + '"'; slashes = 0; continue; }
      out += '\\'.repeat(slashes) + ch;
      slashes = 0;
    }
    return `${out}${'\\'.repeat(slashes * 2)}"`;
  }).join(' ');
}

/** The network setting, the writable folders and the command, from the arguments. */
export function parseArgs(args) {
  const writable = [];
  let network = 'deny';
  const denied = [];
  let i = 0;
  for (; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '--bind' || args[i] === '--bind-try') { writable.push(args[i + 1]); i += 2; }
    else if (args[i].startsWith('--network=')) network = args[i].slice('--network='.length) === 'allow' ? 'allow' : 'deny';
    else if (args[i].startsWith('--deny=')) denied.push(args[i].slice('--deny='.length));
  }
  return { network, writable, denied, command: args.slice(i + 1) };
}

async function main() {
  const { network, writable, denied, command } = parseArgs(process.argv.slice(2));
  if (!command.length) fail('no command after --');
  let sdk;
  try { sdk = await import('@microsoft/mxc-sdk/v1'); } catch (err) { fail(`MXC is not installed: ${err.message}`); }
  if (!sdk.getPlatformSupport().isSupported) fail(`MXC is not available here: ${sdk.getPlatformSupport().reason}`);
  const cwd = process.cwd();
  // node's own folder is not open to containers by default; the tests it runs need it, to read only
  const tools = [dirname(process.execPath)];
  // run, not spawn: streaming needs Node 24.21 on Windows, and the output comes back whole when the command ends; DSH
  // still owns the deadline, and the container's own limit is only a backstop past it
  let result;
  try {
    result = await sdk.run({
      command: commandLine(command),
      workingDirectory: cwd,
      // the container gives the command a private temp folder of its own
      // node resolves a script through every parent folder, which the container may not even look at: keep the path
      environment: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks --preserve-symlinks-main'].filter(Boolean).join(' ') },
      filesystem: { ...(writable.length ? { readwritePaths: writable, readonlyPaths: tools } : { readonlyPaths: [cwd, ...tools] }), ...(denied.length ? { deniedPaths: denied } : {}) },
      network: { egress: { default: network } },
      // programs that load the Windows UI libraries (node, PowerShell) do not start with the UI shut off; the clipboard
      // and input injection stay closed
      ui: { disable: false, clipboard: 'none', allowInputInjection: false },
      timeoutMs: BACKSTOP_MS,
    });
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.timedOut) process.stderr.write(`mxc-runner: stopped after ${BACKSTOP_MS / 60_000} minutes\n`);
  process.exitCode = typeof result.exitCode === 'number' ? result.exitCode : 1;
}

/** The container's own time limit, past any deadline DSH sets on a command. */
const BACKSTOP_MS = 30 * 60_000;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
