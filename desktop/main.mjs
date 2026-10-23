import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createVault } from '../src/vault.mjs';
import { openStore } from '../src/store.mjs';
import { createCloudClient } from '../src/cloud.mjs';
import { createListener } from '../src/listener.mjs';
import { startServer } from '../src/server.mjs';
import { defaultDirectory } from '../src/cli.mjs';
import { claimInstance } from '../src/instance.mjs';
import { createDesktopModel } from './model.mjs';
import { createUpdates } from './updates.mjs';
import { trustedFrame, externalUrl, createDraftExitGuard, reportDraftState, createStoppedUpdateFailureHandler } from './policy.mjs';

app.setName('Flusso Journal');
let window, tray, server, store, listener, model, updates, releaseInstance, quitting = false, closing, closed = false;
const stoppedUpdateFailure = createStoppedUpdateFailureHandler({
  isStopped: () => closed,
  explain: () => dialog.showErrorBox('Update installation could not finish', 'Flusso Journal has stopped the Listener and closed this Journal. The app will quit now. Reopen it manually to try again. The Listener and Auto-trade remain off.'),
  quit: () => { quitting = true; app.quit(); },
});
function showJournal() { if (!closed && !quitting && window && !window.isDestroyed()) { window.show(); window.focus(); } }
const draftExit = createDraftExitGuard({ confirmDiscard: async (reason, unknown) => {
  window?.show();
  const options = { type: 'warning', title: 'Unsaved local draft', message: unknown ? 'A local draft may still be unsaved.' : 'Discard your unsaved local draft?', detail: 'Keep writing to save your changes first. Discarding loses only the unsaved writing.', buttons: ['Keep writing', reason === 'restart' ? 'Discard draft and restart' : 'Discard draft and quit'], defaultId: 0, cancelId: 0, noLink: true };
  const answer = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return answer.response === 1;
} });
async function prepareExit(reason, work) {
  try {
    return await draftExit.run(reason, async () => { quitting = true; window?.hide(); await work(); });
  } catch (error) {
    quitting = false;
    if (!closed) window?.show();
    throw error;
  }
}
if (!process.argv.includes('--smoke-test') && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showJournal);
  app.whenReady().then(start).catch(() => { if (process.argv.includes('--smoke-test')) { console.error('Desktop native smoke failed.'); app.exit(1); return; } dialog.showErrorBox('Flusso Journal could not start', 'Check that your OS credential store is unlocked and another Listener process is not using this Journal. Your stored notes were preserved.'); quitting = true; app.quit(); });
}
function status() { return { version: app.getVersion(), packaged: app.isPackaged, update: updates?.status() ?? { state: 'idle' }, model: model?.status() ?? { state: 'missing' }, startOnLoginSupported: process.platform !== 'linux', startOnLogin: process.platform === 'linux' ? false : app.getLoginItemSettings().openAtLogin }; }
function changed() { if (!closed && window && !window.isDestroyed()) window.webContents.send('flusso:status-changed', status()); }
async function shutdown() {
  if (!closing) closing = (async () => { const drained = listener?.stop(); await server?.close(); await model?.stop(); await drained; await releaseInstance?.(); store?.close(); tray?.destroy(); })().finally(() => { closed = true; });
  return closing;
}
async function start() {
  const runtimeDirectory = app.isPackaged ? join(process.resourcesPath, 'runtime') : fileURLToPath(new URL(`../build/runtime/${process.platform}-${process.arch}`, import.meta.url));
  if (process.argv.includes('--smoke-test')) {
    // Release-runner native dependency test; never opens a Journal or supplies a vault fallback.
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE smoke (id INTEGER);'); db.close(); await import('@napi-rs/keyring');
    const result = await promisify(execFile)(join(runtimeDirectory, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'), ['--version'], { timeout: 15000, windowsHide: true });
    if (!`${result.stdout}${result.stderr}`.includes('11559')) throw new Error('Bundled inference runtime smoke failed.');
    console.log(JSON.stringify({ smoke: 'passed', runtime: 'b11559', electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch })); app.quit(); return;
  }
  const index = process.argv.indexOf('--data-dir');
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw new Error('Supply a path after --data-dir.');
  const directory = index >= 0 && process.argv[index + 1] ? resolve(process.argv[index + 1]) : defaultDirectory();
  const vault = await createVault(directory); store = await openStore({ directory, vault });
  releaseInstance = await claimInstance(directory);
  model = createDesktopModel({ directory, runtimeDirectory, onChange: value => { if (value.state === 'ready') listener?.modelReady(); changed(); } });
  const cloud = createCloudClient({ vault }); listener = createListener({ store, cloud, classify: model.classify });
  server = await startServer({ store, cloud, listener, checkModel: model.modelStatus, open: value => shell.openExternal(externalUrl(value)) });
  updates = createUpdates({ updater: createRequire(import.meta.url)('electron-updater').autoUpdater, version: app.getVersion(), packaged: app.isPackaged, preview: app.getVersion().includes('-'), onChange: value => { if (value.installationFailed) stoppedUpdateFailure.handle(); changed(); }, beforeInstall: async () => {
    return prepareExit('restart', async () => {
      updates?.stopAutoCheck?.();
      const settings = store.settings(); store.saveSettings({ ...settings, enabled: false, executionEnabled: false }); await shutdown();
    });
  } });
  updates.startAutoCheck();
  const iconPath = fileURLToPath(new URL('../public/flusso-mark.png', import.meta.url));
  window = new BrowserWindow({ title: 'Flusso Journal', width: 1180, height: 800, minWidth: 320, minHeight: 480, show: false, icon: iconPath, backgroundColor: '#faf9f6', webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, value) => { try { if (new URL(value).origin !== server.origin) event.preventDefault(); } catch { event.preventDefault(); } });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('did-start-loading', () => draftExit.invalidate());
  window.webContents.on('render-process-gone', () => draftExit.invalidate());
  window.webContents.on('will-prevent-unload', event => { if (draftExit.isApproved() || (closed && stoppedUpdateFailure.isHandled())) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  for (const [channel, handler] of Object.entries({
    status, 'check-updates': () => updates.check(), 'download-update': () => updates.download(), 'install-update': async () => { try { return await updates.install(); } catch (error) { if (closed) stoppedUpdateFailure.handle(); else { draftExit.invalidate(); quitting = false; showJournal(); } throw error; } },
    'setup-model': async () => { const ready = await model.setup(); if (ready.state === 'ready') listener.modelReady(); return status(); },
    'account-settings': () => shell.openExternal('https://flusso.stream/app/settings#ai-connections'),
    'start-on-login': enabled => { if (typeof enabled !== 'boolean') throw new Error('Choose whether to open at login.'); if (process.platform === 'linux') throw new Error('Use your Linux desktop’s startup application settings.'); app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false }); return status(); },
  })) ipcMain.handle(`flusso:${channel}`, (event, ...args) => { if (!trustedFrame(event, window, server.origin) || args.length > (channel === 'start-on-login' ? 1 : 0)) throw new Error('Desktop command refused.'); return handler(...args); });
  ipcMain.on('flusso:draft-dirty', (event, ...args) => {
    event.returnValue = reportDraftState(event, window, server.origin, args, draftExit);
  });
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 }));
  tray.setToolTip('Flusso Journal');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Journal', click: showJournal }, { label: 'Quit Journal and stop Listener', click: () => app.quit() }]));
  tray.on('click', showJournal);
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Flusso Journal', submenu: [{ label: 'Show Journal', click: showJournal }, { label: 'Check for updates', click: () => updates.check().catch(() => changed()) }, { type: 'separator' }, { label: 'Quit Journal and stop Listener', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] }, { role: 'editMenu' }, { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }, { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] }]));
  await window.loadURL(server.url); window.show(); listener.start(); model.initialize().catch(() => {});
}
app.on('activate', showJournal);
app.on('before-quit', event => {
  if (closed || !store) { quitting = true; return; }
  event.preventDefault();
  if (!window) draftExit.reportDirty(false);
  prepareExit('quit', async () => { await shutdown(); app.quit(); }).catch(() => { dialog.showErrorBox('Could not finish quitting', 'The Journal could not finish closing. Check the app before trying again.'); });
});
