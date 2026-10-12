#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createVault } from './vault.mjs';
import { openStore } from './store.mjs';
import { createCloudClient, buildRunRequest } from './cloud.mjs';
import { createListener } from './listener.mjs';
import { startServer } from './server.mjs';
import { openBrowser } from './browser.mjs';
import { installService, removeService } from './service.mjs';
import { claimInstance } from './instance.mjs';

export function defaultDirectory() {
  return process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Flusso Listener')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Flusso Listener')
      : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'flusso-listener');
}
async function main(args) {
  const command = args.shift() ?? 'start';
  if (command === 'help' || command === '--help') { console.log(help); return; }
  const dataIndex = args.indexOf('--data-dir');
  if (dataIndex >= 0 && (!args[dataIndex + 1] || args[dataIndex + 1].startsWith('--'))) throw new Error('Supply a path after --data-dir.');
  const directory = dataIndex < 0 ? defaultDirectory() : resolve(args.splice(dataIndex, 2)[1]);
  const vault = await createVault(directory), store = await openStore({ directory, vault });
  let keepOpen = false;
  try {
    if (command === 'start') {
      if (args.some(arg => arg !== '--no-browser')) throw new Error('Unknown start option.');
      const releaseInstance = await claimInstance(directory);
      const cloud = createCloudClient({ vault }), listener = createListener({ store, cloud, buildRunRequest });
      let app;
      try {
      app = await startServer({ store, cloud, listener });
      const temporary = join(directory, `runtime.${process.pid}.tmp`), runtime = join(directory, 'runtime.json');
      await writeFile(temporary, JSON.stringify({ pid: process.pid, url: app.url }), { mode: 0o600, flag: 'wx' }); await rename(temporary, runtime);
      listener.start(); keepOpen = true;
      // The local private per-start fragment unlocks this session. It contains no Flusso API credential.
      console.log(`Flusso Listener: ${app.url}`);
      console.log('This URL unlocks the local Journal. Keep it private. Press Ctrl+C to stop.');
      if (!args.includes('--no-browser')) await openBrowser(app.url).catch(() => console.log('Open the displayed local URL in your browser.'));
      let closing = false;
      const close = async () => { if (closing) return; closing = true; listener.stop(); await app.close(); const current = JSON.parse(await readFile(runtime, 'utf8').catch(() => '{}')); if (current.pid === process.pid) await unlink(runtime).catch(() => {}); await releaseInstance(); store.close(); process.exit(0); };
      process.on('SIGINT', close); process.on('SIGTERM', close); return;
      } catch (error) { listener.stop(); if (app) await app.close(); await releaseInstance(); throw error; }
    }
    if (command === 'open' && !args.length) { const runtime = JSON.parse(await readFile(join(directory, 'runtime.json'), 'utf8')); const url = new URL(runtime.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || !/^#[\w-]{43}$/.test(url.hash)) throw new Error('Invalid local launcher.'); await openBrowser(url.href); return; }
    if (command === 'service' && args.length === 1 && ['install', 'remove'].includes(args[0])) { await (args[0] === 'install' ? installService : removeService)({ directory }); console.log(args[0] === 'install' ? 'User login service installed. Use node src/cli.mjs open to show its GUI. Keep the computer awake and the OS vault unlocked.' : 'User login service removed.'); return; }
    if (command !== 'journal') throw new Error('Unknown command. Run node src/cli.mjs help.');
    const action = args.shift() ?? 'list'; let value;
    if (action === 'list' && !args.length) value = store.entries();
    else if (action === 'notebooks' && !args.length) value = store.notebooks();
    else if (action === 'notebook' && args.length === 1) value = store.createNotebook(args[0]);
    else if (action === 'get' && args.length >= 1 && args.length <= 2) { value = store.entry(args[0], args[1] ?? 'local'); if (!value) throw new Error('Entry not found.'); }
    else if (action === 'create') {
      const retryIndex = args.indexOf('--idempotency-key');
      const retry = retryIndex < 0 ? undefined : args.splice(retryIndex, 2)[1];
      if (args.length) throw new Error('Unknown create option.');
      value = store.createEntry(await stdinJson(), retry);
    } else if (action === 'update' && args.length === 1) value = store.updateEntry(args[0], await stdinJson());
    else throw new Error('Unknown Journal command or option. Run node src/cli.mjs help.');
    console.log(JSON.stringify(value, null, 2));
  } finally { if (!keepOpen) store.close(); }
}
async function stdinJson() {
  if (process.stdin.isTTY) throw new Error('Pass Journal JSON through stdin. Never include credentials.');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 98304) throw new Error('Journal input exceeded the size limit.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Supply valid Journal JSON on stdin.'); }
}
const help = `Flusso Listener · Node 24.19+

node src/cli.mjs start [--no-browser] [--data-dir PATH]
node src/cli.mjs open [--data-dir PATH]
node src/cli.mjs service install|remove [--data-dir PATH]
node src/cli.mjs journal notebooks
node src/cli.mjs journal notebook "Research"
node src/cli.mjs journal list
node src/cli.mjs journal get ENTRY_UUID [local|cloud]
node src/cli.mjs journal create [--idempotency-key ORIGINAL_KEY] < entry.json
node src/cli.mjs journal update ENTRY_UUID < updated-entry.json

Journal commands operate locally; they never execute an order or change a listener policy.
The JSON schema and agent setup instructions are documented in README.md.
The OS vault must be unlocked. Cloud access uses the GUI's browser sign-in.
`;
if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => { console.error(error.name === 'InputError' || /^(Unknown |Supply |Pass |Entry |Journal |The OS |The data |Refusing |Another process|Invalid Journal)/.test(error.message) ? error.message : 'Flusso Listener could not start. Check Node 24, npm ci, and your unlocked OS credential store.'); process.exitCode = 1; });
}
