export function createUpdates({ updater, version, packaged, preview, onChange = () => {}, beforeInstall = async () => {} }) {
  let installing;
  let state = { state: packaged && !preview ? 'idle' : 'unsupported', message: !packaged ? 'Updates are available in the installed desktop app.' : preview ? 'Preview build. Signed production updates are not available yet.' : 'Check for a new version.' };
  const publish = value => { if (!packaged || preview) return; state = { ...value }; onChange({ ...state }); };
  updater.autoDownload = false;
  updater.autoInstallEvent = 'manual';
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.allowUnverifiedLinuxPackages = false;
  const supported = () => { if (!packaged || preview) throw new Error(state.message); };
  updater.on('checking-for-update', () => publish({ state: 'checking', message: 'Checking for updates…' }));
  updater.on('update-available', info => {
    if (typeof info.version !== 'string' || info.version.length > 100 || info.version === version) return publish({ state: 'error', message: 'The update metadata was invalid.' });
    publish({ state: 'available', version: info.version, message: 'An update is available.' });
  });
  updater.on('update-not-available', () => publish({ state: 'current', message: 'You have the latest version.' }));
  updater.on('download-progress', progress => publish({ state: 'downloading', version: state.version, percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0, message: 'Downloading the verified update…' }));
  updater.on('update-downloaded', info => publish({ state: 'downloaded', version: info.version, message: 'Update ready. Restart when you are ready.' }));
  updater.on('error', () => publish({ state: 'error', message: 'The update could not be verified or downloaded. Your installed app and Journal are unchanged.' }));
  return {
    status: () => ({ ...state }),
    async check() { supported(); if (['checking', 'downloading', 'downloaded'].includes(state.state)) return { ...state }; publish({ state: 'checking', message: 'Checking for updates…' }); try { await updater.checkForUpdates(); } catch { publish({ state: 'error', message: 'Could not check for a signed update. Try again later.' }); } return { ...state }; },
    async download() { supported(); if (state.state !== 'available') throw new Error('Check for an available update first.'); publish({ ...state, state: 'downloading', percent: 0 }); try { await updater.downloadUpdate(); } catch { publish({ state: 'error', message: 'The update could not be verified or downloaded. Your app is unchanged.' }); } return { ...state }; },
    async install() { supported(); if (state.state !== 'downloaded') throw new Error('Download and verify the update first.'); if (!installing) installing = (async () => { await beforeInstall(); updater.quitAndInstall({ isSilent: false, isForceRunAfter: true }); return { ...state }; })().catch(error => { installing = undefined; throw error; }); return installing; },
  };
}
