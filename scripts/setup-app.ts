/** Select an existing local pack; model and persona setup remain in the workbench. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadPack } from '../core/behavior/pack.ts';
import { validatePackResources } from '../core/behavior/pack-resources.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
};

async function main() {
  if (args.includes('--help')) {
    console.log('pnpm run setup:app [--pack <folder>] [--check] [--note-file <path>]');
    console.log('选择已有形象包。只检查不保存用 --check；不下载素材，也不启动程序。');
    return;
  }
  const root = fileURLToPath(new URL('../', import.meta.url));
  const noteFile = resolve(option('--note-file') ?? join(homedir(), '.lingxi', 'pack'));
  const explicit = option('--pack');
  let selected = explicit;
  const cli = !explicit && stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  try {
    if (!selected && !cli) throw new Error('Provide --pack <folder>, or run setup:app in an interactive terminal.');
    if (!selected) {
      console.log('准备已有的 figure.json、motion.cjs 和 clips/。模型和人设稍后在工作台设置。');
      if (existsSync(noteFile)) console.log(`当前选择：${readFileSync(noteFile, 'utf8').trim()}`);
      selected = (await cli!.question('形象包目录：')).trim();
    }
    if (!selected) throw new Error('No figure pack selected; existing settings were kept.');
    // CLI input is a filesystem path; bare pack IDs remain supported by the runtime.
    const pack = loadPack(root, resolve(selected.replace(/^"(.*)"$/, '$1')));
    const resources = validatePackResources(pack);
    console.log(`检查通过：${pack.figure.name}，${resources.clips.length} 个片段。`);
    console.log(`形象包：${pack.dir}\n片段：${pack.clips}`);
    if (args.includes('--check')) return;
    if (cli && !/^(y|yes|是)$/i.test((await cli.question(`保存选择到 ${noteFile}？[y/N] `)).trim())) {
      console.log('未保存，原设置保留。');
      return;
    }
    mkdirSync(dirname(noteFile), { recursive: true });
    writeFileSync(noteFile, `${pack.dir}\n`, 'utf8');
    console.log('已保存。运行 pnpm start，在工作台完成模型连接、人设和试聊。');
    if (process.env.LINGXI_PACK) console.log('当前终端的 LINGXI_PACK 会优先于已保存选择；下次启动前按需取消该变量。');
  } finally { cli?.close(); }
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
