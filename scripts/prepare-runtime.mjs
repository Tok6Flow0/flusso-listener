import { readFile, mkdir, readdir, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { verifiedDownload } from '../desktop/download.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = JSON.parse(await readFile(new URL('../desktop/resources.json', import.meta.url)));
const target = process.argv[2] ?? `${process.platform}-${process.arch}`;
const asset = resources.runtime.assets[target];
if (!asset || process.argv.length > 3) throw new Error('Choose a supported platform-architecture runtime.');
const destination = join(root, 'build', 'runtime', target);
const archive = join(root, 'build', 'downloads', asset.archive);
await verifiedDownload({ ...asset, destination: archive, signal: AbortSignal.timeout(180000) });
const staging = join(root, 'build', 'downloads', `${target}-unpacked`);
await rm(staging, { recursive: true, force: true }); await mkdir(staging, { recursive: true });
async function run(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'inherit', env });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Runtime extraction failed.')));
  });
}
if (asset.archive.endsWith('.zip')) {
  if (process.platform !== 'win32') throw new Error('Prepare Windows runtimes on the native Windows release runner.');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:FLUSSO_ARCHIVE_TASK_PATH -DestinationPath $env:FLUSSO_RUNTIME_TASK_PATH -Force'], { ...process.env, FLUSSO_ARCHIVE_TASK_PATH: archive, FLUSSO_RUNTIME_TASK_PATH: staging });
} else await run('tar', ['-xzf', archive, '-C', staging]);
async function find(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const result = await find(path, name); if (result) return result; }
  }
}
const executable = await find(staging, target.startsWith('win32') ? 'llama-server.exe' : 'llama-server');
if (!executable || !resolve(executable).startsWith(`${resolve(staging)}/`) && process.platform !== 'win32') throw new Error('The pinned runtime did not include llama-server.');
await rm(destination, { recursive: true, force: true }); await mkdir(destination, { recursive: true });
// Keep the complete sibling library set; the CPU server must not depend on a user-installed runtime.
await cp(dirname(executable), destination, { recursive: true, verbatimSymlinks: true,
  filter: path => path === dirname(executable) || /(?:^llama-server(?:\.exe)?$|\.(?:dylib|dll)$|\.so(?:\.|$))/.test(path.split(/[\\/]/).at(-1)),
});
await cp(join(root, 'build', 'LLAMA-LICENSE'), join(destination, 'LLAMA-LICENSE'));
await writeFile(join(destination, 'resource-version.json'), JSON.stringify({ version: resources.runtime.version, archiveSha256: asset.sha256 }) + '\n');
await rm(staging, { recursive: true, force: true });
console.log(`Prepared verified ${resources.runtime.version} CPU runtime for ${target}.`);
