import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createUpdates } from '../desktop/updates.mjs';

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class FakeUpdater extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.checkResult = async () => {}; this.downloadResult = async () => {};
    Object.defineProperty(this, 'autoInstallOnAppQuit', { set() { throw new Error('The removed legacy update switch must not be used.'); } });
  }
  async checkForUpdates() { this.calls.push(['check']); return this.checkResult(); }
  async downloadUpdate() { this.calls.push(['download']); return this.downloadResult(); }
  quitAndInstall(options) { this.calls.push(['install', options]); }
}
function fixture(options = {}) {
  const updater = new FakeUpdater(), changes = [];
  const updates = createUpdates({ updater, version: '0.1.0', packaged: true, preview: false, onChange: value => changes.push(value), ...options });
  return { updater, updates, changes };
}
async function downloaded(updater, updates) {
  await updates.check(); updater.emit('update-available', { version: '0.2.0' });
  await updates.download(); updater.emit('update-downloaded', { version: '0.2.0' });
}

test('v7 security defaults prevent automatic downloads, install-on-quit, downgrades and unsigned package bypasses', () => {
  const { updater, updates } = fixture();
  assert.equal(updates.status().state, 'idle');
  assert.equal(updater.autoDownload, false); assert.equal(updater.autoInstallEvent, 'manual');
  assert.equal(updater.allowPrerelease, false); assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.disableWebInstaller, true); assert.equal(updater.allowUnverifiedLinuxPackages, false);
  assert.deepEqual(updater.calls, []);
});

test('finding and downloading an update never installs it without a separate explicit install action', async () => {
  const { updater, updates } = fixture();
  await updates.check(); updater.emit('update-available', { version: '0.2.0' });
  assert.deepEqual(updater.calls, [['check']]); assert.equal(updates.status().state, 'available');
  await updates.download(); updater.emit('download-progress', { percent: 42.5 });
  assert.equal(updates.status().percent, 42.5);
  updater.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(updates.status().state, 'downloaded'); assert.deepEqual(updater.calls, [['check'], ['download']]);
});

test('parallel checks use one network request and downloads are gated to the offered update', async () => {
  const { updater, updates } = fixture(); const wait = deferred(); updater.checkResult = () => wait.promise;
  await assert.rejects(updates.download(), /available update/i);
  const first = updates.check(), second = updates.check();
  assert.deepEqual(updater.calls, [['check']]); assert.equal((await second).state, 'checking');
  updater.emit('update-available', { version: '0.2.0' }); wait.resolve(); await first;
  const downloadWait = deferred(); updater.downloadResult = () => downloadWait.promise;
  const download = updates.download(); await assert.rejects(updates.download(), /available update/i);
  assert.equal((await updates.check()).state, 'downloading');
  assert.deepEqual(updater.calls, [['check'], ['download']]);
  downloadWait.resolve(); await download;
});

test('install refuses every state before a verified download', async () => {
  const { updater, updates } = fixture({ beforeInstall: () => assert.fail('Shutdown must not run before a download.') });
  await assert.rejects(updates.install(), /download and verify/i);
  await updates.check(); await assert.rejects(updates.install(), /download and verify/i);
  updater.emit('update-available', { version: '0.2.0' }); await assert.rejects(updates.install(), /download and verify/i);
  await updates.download(); await assert.rejects(updates.install(), /download and verify/i);
  updater.emit('error', new Error('synthetic signature error')); await assert.rejects(updates.install(), /download and verify/i);
  updater.emit('update-not-available'); await assert.rejects(updates.install(), /download and verify/i);
  assert.equal(updater.calls.some(([call]) => call === 'install'), false);
});

test('installation waits for Listener and Journal shutdown, then uses the v7 explicit restart options', async () => {
  const shutdown = deferred(), order = [];
  const { updater, updates } = fixture({ beforeInstall: async () => { order.push('shutdown-start'); await shutdown.promise; order.push('shutdown-complete'); } });
  await downloaded(updater, updates);
  const install = updates.install();
  assert.deepEqual(order, ['shutdown-start']); assert.equal(updater.calls.some(([call]) => call === 'install'), false);
  const originalInstall = updater.quitAndInstall.bind(updater);
  updater.quitAndInstall = value => { order.push('install'); originalInstall(value); };
  shutdown.resolve(); await install;
  assert.deepEqual(order, ['shutdown-start', 'shutdown-complete', 'install']);
  assert.deepEqual(updater.calls.at(-1), ['install', { isSilent: false, isForceRunAfter: true }]);
});

test('a failed shutdown never starts the installer', async () => {
  const { updater, updates } = fixture({ beforeInstall: async () => { throw new Error('Journal flush failed'); } });
  await downloaded(updater, updates); await assert.rejects(updates.install(), /Journal flush failed/);
  assert.equal(updater.calls.some(([call]) => call === 'install'), false);
});

test('a failed shutdown can be retried explicitly without a permanently cached rejection', async () => {
  let shutdownCalls = 0;
  const { updater, updates } = fixture({ beforeInstall: async () => { if (++shutdownCalls === 1) throw new Error('Temporary shutdown failure'); } });
  await downloaded(updater, updates);
  await assert.rejects(updates.install(), /Temporary shutdown failure/);
  await updates.install();
  assert.equal(shutdownCalls, 2); assert.equal(updater.calls.filter(([call]) => call === 'install').length, 1);
});

test('concurrent or repeated install requests perform shutdown and installer launch once', async () => {
  const shutdown = deferred(); let shutdownCalls = 0;
  const { updater, updates } = fixture({ beforeInstall: async () => { shutdownCalls++; await shutdown.promise; } });
  await downloaded(updater, updates);
  const installing = Promise.allSettled([updates.install(), updates.install()]);
  shutdown.resolve(); await installing;
  await updates.install().catch(() => {});
  assert.equal(shutdownCalls, 1);
  assert.equal(updater.calls.filter(([call]) => call === 'install').length, 1);
});

test('development builds never contact update servers or expose an installable update', async () => {
  const { updater, updates } = fixture({ packaged: false, preview: false });
  updater.configOnDisk = { get value() { assert.fail('Development builds must not prepare an update provider.'); } };
  updater.setFeedURL = () => assert.fail('Development builds must not replace their provider.');
  assert.equal(updates.status().state, 'unsupported');
  updates.startAutoCheck();
  await assert.rejects(updates.check()); await assert.rejects(updates.download()); await assert.rejects(updates.install());
  for (const [event, value] of [['checking-for-update'], ['update-available', { version: '0.2.0' }], ['download-progress', { percent: 50 }], ['update-downloaded', { version: '0.2.0' }], ['update-not-available'], ['error', new Error('synthetic error')]]) {
    updater.emit(event, value); assert.equal(updates.status().state, 'unsupported', event);
  }
  assert.deepEqual(updater.calls, []);
});

test('packaged preview builds check the prerelease channel and surface a corner update prompt', async () => {
  const { updater, updates } = fixture({ packaged: true, preview: true });
  assert.equal(updates.status().state, 'idle');
  assert.equal(updater.allowPrerelease, true);
  await updates.check();
  updater.emit('update-available', { version: '0.2.0-preview.6' });
  assert.equal(updates.status().state, 'available');
  assert.match(updates.status().message, /preview/i);
  await updates.download();
  updater.emit('update-downloaded', { version: '0.2.0-preview.6' });
  assert.equal(updates.status().state, 'downloaded');
});

test('auto-check schedules a quiet startup and periodic lookup without forcing a download', async () => {
  const timeouts = [];
  const intervals = [];
  const { updater, updates } = fixture({
    packaged: true,
    preview: true,
    setTimeoutFn: (fn, ms) => { timeouts.push(ms); fn(); return timeouts.length; },
    clearTimeoutFn: () => {},
    setIntervalFn: (fn, ms) => { intervals.push(ms); return intervals.length; },
    clearIntervalFn: () => {},
  });
  updates.startAutoCheck();
  assert.deepEqual(timeouts, [12_000]);
  assert.deepEqual(intervals, [4 * 60 * 60 * 1000]);
  assert.deepEqual(updater.calls, [['check']]);
  updates.stopAutoCheck();
});

test('check and download failures show bounded errors without leaking upstream URLs or permitting installation', async () => {
  const { updater, updates } = fixture(); const privateError = new Error('https://private.example.test/token?secret=do-not-display');
  updater.checkResult = async () => { throw privateError; };
  assert.equal((await updates.check()).state, 'error'); assert.doesNotMatch(updates.status().message, /private|secret|token/);
  updater.emit('update-available', { version: '0.2.0' }); updater.downloadResult = async () => { throw privateError; };
  assert.equal((await updates.download()).state, 'error'); assert.doesNotMatch(updates.status().message, /private|secret|token/);
  await assert.rejects(updates.install()); assert.equal(updater.calls.some(([call]) => call === 'install'), false);
});

test('status and change-event snapshots cannot be mutated to acquire install authority', async () => {
  const { updater, updates, changes } = fixture();
  await updates.check(); updater.emit('update-available', { version: '0.2.0' });
  updates.status().state = 'downloaded'; changes.at(-1).state = 'downloaded';
  assert.equal(updates.status().state, 'available'); await assert.rejects(updates.install(), /download and verify/i);
});

test('an absent, non-string, oversized or current offered version cannot enable download', async () => {
  for (const info of [{}, { version: 2 }, { version: 'x'.repeat(101) }, { version: '0.1.0' }]) {
    const { updater, updates } = fixture(); await updates.check(); updater.emit('update-available', info);
    assert.equal(updates.status().state, 'error'); await assert.rejects(updates.download(), /available update/i);
    assert.deepEqual(updater.calls, [['check']]);
  }
});

test('provider configuration is lazy, shared by concurrent checks and retryable after a bounded failure', async () => {
  const { updater, updates } = fixture();
  const ready = deferred(); let reads = 0, configured = 0;
  updater.configOnDisk = { get value() { reads++; return ready.promise; } };
  updater.setFeedURL = config => { configured++; assert.equal(config.provider, 'custom'); };
  assert.equal(reads, 0);
  const first = updates.check();
  assert.equal((await updates.check()).state, 'checking');
  assert.deepEqual(updater.calls, []); assert.equal(reads, 1);
  ready.resolve({ provider: 'github', channel: 'preview-arm64' });
  await first;
  updater.emit('update-not-available'); await updates.check();
  assert.equal(reads, 1); assert.equal(configured, 1); assert.equal(updater.calls.length, 2);

  const failed = fixture(); let attempts = 0;
  failed.updater.configOnDisk = { get value() { return ++attempts === 1 ? Promise.reject(new Error('private URL/token')) : Promise.resolve({ provider: 'github', channel: 'preview-arm64' }); } };
  failed.updater.setFeedURL = () => {};
  assert.equal((await failed.updates.check()).state, 'error');
  assert.doesNotMatch(failed.updates.status().message, /private|token/);
  assert.deepEqual(failed.updater.calls, []);
  await failed.updates.check();
  assert.equal(attempts, 2); assert.deepEqual(failed.updater.calls, [['check']]);
});

test('a quiet startup configuration failure leaves a bounded error instead of a stuck checking status', async () => {
  let startup;
  const { updater, updates } = fixture({ setTimeoutFn: fn => { startup = fn; }, setIntervalFn: () => {}, clearTimeoutFn: () => {}, clearIntervalFn: () => {} });
  updater.configOnDisk = { value: Promise.resolve().then(() => { throw new Error('private URL/token'); }) };
  updater.setFeedURL = () => assert.fail('Failed configuration must not replace the provider.');
  updates.startAutoCheck(); startup();
  await new Promise(setImmediate);
  assert.equal(updates.status().state, 'error');
  assert.doesNotMatch(updates.status().message, /private|token/);
  assert.deepEqual(updater.calls, []);
  updates.stopAutoCheck();
});
