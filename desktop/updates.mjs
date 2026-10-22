import { configureArchitectureProvider } from './update-provider.mjs';

const CHECK_MS = 4 * 60 * 60 * 1000;
const STARTUP_CHECK_MS = 12_000;

export function createUpdates({
  updater,
  version,
  packaged,
  preview = false,
  onChange = () => {},
  beforeInstall = async () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let installing;
  let providerReady;
  let timers = [];
  // Packaged preview and production builds both use signed update manifests.
  // Preview builds also accept GitHub prereleases on the preview channel.
  let state = {
    state: packaged ? 'idle' : 'unsupported',
    message: packaged ? 'Check for a new version.' : 'Updates are available in the installed desktop app.',
  };
  const publish = value => {
    if (!packaged) return;
    state = { ...value };
    onChange({ ...state });
  };
  updater.autoDownload = false;
  updater.autoInstallEvent = 'manual';
  updater.allowPrerelease = Boolean(preview);
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.allowUnverifiedLinuxPackages = false;
  const supported = () => { if (!packaged) throw new Error(state.message); };
  const prepareProvider = () => {
    if (!providerReady) {
      const ready = configureArchitectureProvider(updater);
      if (ready) providerReady = ready.catch(error => { providerReady = undefined; throw error; });
    }
    return providerReady;
  };
  updater.on('checking-for-update', () => publish({ state: 'checking', message: 'Checking for updates…' }));
  updater.on('update-available', info => {
    if (typeof info.version !== 'string' || info.version.length > 100 || info.version === version) {
      return publish({ state: 'error', message: 'The update metadata was invalid.' });
    }
    publish({
      state: 'available',
      version: info.version,
      message: preview ? 'A newer preview build is available.' : 'An update is available.',
    });
  });
  updater.on('update-not-available', () => publish({ state: 'current', message: 'You have the latest version.' }));
  updater.on('download-progress', progress => publish({
    state: 'downloading',
    version: state.version,
    percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0,
    message: 'Downloading the verified update…',
  }));
  updater.on('update-downloaded', info => publish({
    state: 'downloaded',
    version: info.version,
    message: 'Update ready. Restart when you are ready.',
  }));
  updater.on('error', () => publish({
    state: 'error',
    message: 'The update could not be verified or downloaded. Your installed app and Journal are unchanged.',
  }));

  async function checkQuietly() {
    if (!packaged || ['checking', 'downloading', 'downloaded'].includes(state.state)) return { ...state };
    publish({ state: 'checking', message: 'Checking for updates…' });
    try {
      const ready = prepareProvider(); if (ready) await ready;
      await updater.checkForUpdates();
    } catch { publish({ state: 'error', message: 'Could not check for a signed update. Try again later.' }); }
    return { ...state };
  }

  const api = {
    status: () => ({ ...state }),
    async check() {
      supported();
      if (['checking', 'downloading', 'downloaded'].includes(state.state)) return { ...state };
      publish({ state: 'checking', message: 'Checking for updates…' });
      try {
        const ready = prepareProvider(); if (ready) await ready;
        await updater.checkForUpdates();
      }
      catch { publish({ state: 'error', message: 'Could not check for a signed update. Try again later.' }); }
      return { ...state };
    },
    async download() {
      supported();
      if (state.state !== 'available') throw new Error('Check for an available update first.');
      publish({ ...state, state: 'downloading', percent: 0 });
      try { await updater.downloadUpdate(); }
      catch { publish({ state: 'error', message: 'The update could not be verified or downloaded. Your app is unchanged.' }); }
      return { ...state };
    },
    async install() {
      supported();
      if (state.state !== 'downloaded') throw new Error('Download and verify the update first.');
      if (!installing) {
        installing = (async () => {
          await beforeInstall();
          updater.quitAndInstall({ isSilent: false, isForceRunAfter: true });
          return { ...state };
        })().catch(error => { installing = undefined; throw error; });
      }
      return installing;
    },
    /** Quiet checks on launch and on a cadence so a corner Update prompt appears without a manual redownload. */
    startAutoCheck() {
      if (!packaged) return;
      timers.push(setTimeoutFn(() => { checkQuietly().catch(() => {}); }, STARTUP_CHECK_MS));
      timers.push(setIntervalFn(() => { checkQuietly().catch(() => {}); }, CHECK_MS));
    },
    stopAutoCheck() {
      for (const timer of timers) {
        clearTimeoutFn(timer);
        clearIntervalFn(timer);
      }
      timers = [];
    },
  };
  return api;
}
