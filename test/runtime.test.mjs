import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm, writeFile, utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { serviceDefinition } from '../src/service.mjs';
import { claimInstance } from '../src/instance.mjs';
import { openStore } from '../src/store.mjs';
import { memoryVault } from './helpers.mjs';

test('CLI entry point works from a checkout path containing spaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso listener path '));
  try { await cp(fileURLToPath(new URL('../src', import.meta.url)), join(directory, 'src'), { recursive: true }); await cp(fileURLToPath(new URL('../public/format.mjs', import.meta.url)), join(directory, 'public', 'format.mjs')); const result = execFileSync(process.execPath, [join(directory, 'src', 'cli.mjs'), 'help'], { encoding: 'utf8' }); assert.match(result, /Flusso Listener/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('CLI refuses missing data-dir paths before attempting to create or access a vault', () => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  for (const args of [['start', '--data-dir'], ['start', '--data-dir', '--no-browser']]) assert.throws(() => execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' }), failure => /Supply a path after --data-dir/.test(failure.stderr.toString()));
});
test('a crash-left initialization lock is recoverable and active initializer stays protected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso stale lock '));
  try {
    const filename = join(directory, 'key.init'); await writeFile(filename, ''); await utimes(filename, new Date(0), new Date(0));
    const store = await openStore({ directory, vault: memoryVault() }); assert.equal(store.notebooks().length, 1); store.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('one Listener instance owns a data directory and releases its claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flusso instance '));
  try { const release = await claimInstance(directory); await assert.rejects(claimInstance(directory), /Another Listener is running/); await release(); const next = await claimInstance(directory); await next(); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('user service definitions preserve paths without a shell and keep least privilege', () => {
  const paths = { node: '/home/User Space/node', script: '/home/User Space/listener/src/cli.mjs', directory: '/home/User Space/data', home: '/home/User Space' };
  const mac = serviceDefinition({ ...paths, platform: 'darwin' }); assert.match(mac.content, /ProgramArguments/); assert.match(mac.content, /User Space/); assert.doesNotMatch(mac.content, /sudo/);
  const linux = serviceDefinition({ ...paths, platform: 'linux' }); assert.match(linux.content, /UMask=0077/); assert.match(linux.content, /ExecStart="\/home\/User Space\/node"/);
  const windows = serviceDefinition({ ...paths, platform: 'win32' }); assert.match(windows.content, /LeastPrivilege/); assert.match(windows.content, /InteractiveToken/); assert.match(windows.content, /ExecutionTimeLimit>PT0S/);
  assert.throws(() => serviceDefinition({ ...paths, directory: '/tmp/evil\ncommand' }), /Invalid service path/);
});
