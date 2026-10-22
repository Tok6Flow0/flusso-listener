import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppUpdater, GitHubProvider } from 'electron-updater';
import { canonicalizeForSigning, createManifestSignatureEntry, HttpError } from 'builder-util-runtime';
import { ArchitectureGitHubProvider, configureArchitectureProvider } from '../desktop/update-provider.mjs';
import { createUpdates } from '../desktop/updates.mjs';

async function fixture({ platform = 'darwin', arch = 'arm64', preview = true, missingManifest = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'flusso-update-provider-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const version = preview ? '0.2.0-preview.12' : '0.2.0';
  const tag = `v${version}`;
  const channel = `${preview ? 'preview' : 'latest'}-${arch}`;
  const suffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? `-linux${arch === 'x64' ? '' : `-${arch}`}` : '';
  const basePath = '/fixture-owner/fixture-repository/releases';
  const manifestPath = `${basePath}/download/${tag}/${channel}${suffix}.yml`;
  const config = { provider: 'github', owner: 'fixture-owner', repo: 'fixture-repository', channel, updateManifestPublicKey: publicPem, updaterCacheDirName: 'fixture-cache' };
  const configPath = join(directory, 'app-update.yml');
  await writeFile(configPath, JSON.stringify(config));
  const manifest = {
    version,
    files: [{ url: `Flusso-${version}-${platform}-${arch}.zip`, sha512: Buffer.alloc(64, 7).toString('base64'), size: 123 }],
    releaseName: 'Fixture release', releaseNotes: 'Offline signed update fixture.',
  };
  manifest.signatures = [createManifestSignatureEntry(publicPem, sign(null, Buffer.from(canonicalizeForSigning(manifest)), privateKey).toString('base64'))];
  const requests = [];
  const updater = new AppUpdater(null, {
    version: preview ? '0.2.0-preview.11' : '0.1.0', name: 'Flusso update test', isPackaged: true,
    appUpdateConfigPath: configPath, userDataPath: directory, baseCachePath: directory,
    whenReady: async () => {}, onQuit: () => {},
    quit: () => assert.fail('A metadata check must not quit the app.'),
    relaunch: () => assert.fail('A metadata check must not relaunch the app.'),
  });
  updater._testOnlyOptions = { platform };
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  updater.httpExecutor = {
    async request(options) {
      assert.equal(options.hostname, 'github.com');
      requests.push(options.path);
      if (options.path === `${basePath}.atom`) return `<feed><entry><title>Fixture release</title><link href="https://github.com${basePath}/tag/${tag}"/><content>Fixture notes</content></entry></feed>`;
      if (options.path === `${basePath}/latest`) return JSON.stringify({ tag_name: tag });
      if (options.path === manifestPath && !missingManifest) return JSON.stringify(manifest);
      throw new HttpError(404, 'No such fixture asset');
    },
    download: () => assert.fail('A metadata check must not download an archive.'),
  };
  const errors = [];
  updater.on('error', error => errors.push(error));
  return { directory, updater, config, manifest, manifestPath, requests, errors, preview, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('real GitHub provider reproduces the prerelease filename loss and the inherited mapper fixes it', async () => {
  const f = await fixture();
  try {
    f.updater.allowPrerelease = true;
    await assert.rejects(f.updater.getUpdateInfoAndProvider(), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    assert.match(f.requests[1], /\/preview-mac\.yml$/);
    assert.match(f.requests[2], /\/latest-mac\.yml$/);
    f.requests.length = 0;
    const updates = createUpdates({ updater: f.updater, version: '0.2.0-preview.11', packaged: true, preview: true });
    assert.equal((await updates.check()).state, 'available');
    assert.equal(f.requests.at(-1), f.manifestPath);
    assert.equal(f.updater.channel, null);
    const provider = await f.updater.clientPromise;
    assert.ok(provider instanceof GitHubProvider);
    assert.equal(provider.getLatestVersion, GitHubProvider.prototype.getLatestVersion);
    assert.equal(provider.resolveFiles, GitHubProvider.prototype.resolveFiles);
    assert.deepEqual(await f.updater.configOnDisk.value, f.config);
    assert.equal(f.updater.autoDownload, false);
  } finally { await f.cleanup(); }
});

test('real-library lookup preserves signed per-architecture preview and stable feeds on every desktop platform', async () => {
  const priorArch = process.env.TEST_UPDATER_ARCH;
  try {
    for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['arm64', 'x64']) for (const preview of [true, false]) {
      process.env.TEST_UPDATER_ARCH = arch;
      const f = await fixture({ platform, arch, preview });
      try {
        const updates = createUpdates({ updater: f.updater, version: f.updater.currentVersion.format(), packaged: true, preview });
        assert.deepEqual(f.requests, []);
        assert.equal((await updates.check()).state, 'available', `${platform}/${arch}/${preview}`);
        assert.equal(f.requests.at(-1), f.manifestPath);
        assert.equal(f.requests.length, preview ? 2 : 3);
        assert.equal(f.updater.channel, null);
        assert.deepEqual(f.errors, []);
        const provider = await f.updater.clientPromise;
        assert.equal(provider.resolveFiles({ ...f.manifest, tag: `v${f.manifest.version}` })[0].url.href, `https://github.com${f.manifestPath.replace(/[^/]+$/, f.manifest.files[0].url)}`);
        assert.deepEqual(await f.updater.configOnDisk.value, f.config);
        // The real AppUpdater must still reject modifications to a signed field.
        f.manifest.files[0].url = `altered-${arch}.zip`;
        assert.equal((await updates.check()).state, 'error');
        assert.equal(f.errors.at(-1)?.code, 'ERR_UPDATER_MANIFEST_SIGNATURE_INVALID');
        assert.equal(f.updater.autoDownload, false);
      } finally { await f.cleanup(); }
    }
  } finally {
    if (priorArch === undefined) delete process.env.TEST_UPDATER_ARCH; else process.env.TEST_UPDATER_ARCH = priorArch;
  }
});

test('configuration leaves other feeds, private GitHub providers and unsupported channels untouched', async () => {
  for (const config of [
    { provider: 'generic', channel: 'preview-arm64' },
    { provider: 'github', channel: 'preview-arm64', private: true },
    { provider: 'github', channel: 'preview-arm64', token: 'fixture-token' },
    { provider: 'github', channel: 'other-arm64' },
    { provider: 'github', channel: 'preview-ia32' },
  ]) {
    await configureArchitectureProvider({ configOnDisk: { value: Promise.resolve(config) }, setFeedURL: () => assert.fail('Unrelated configuration must retain its original provider.') });
  }
  assert.equal(configureArchitectureProvider({}), undefined);
  assert.equal(ArchitectureGitHubProvider.prototype.verifyManifestSignature, undefined);
});

test('a missing architecture manifest cannot fall back to a bare or another architecture filename', async () => {
  const priorArch = process.env.TEST_UPDATER_ARCH;
  try {
    for (const platform of ['darwin', 'win32', 'linux']) for (const arch of ['arm64', 'x64']) {
      process.env.TEST_UPDATER_ARCH = arch;
      const f = await fixture({ platform, arch, missingManifest: true });
      try {
        const updates = createUpdates({ updater: f.updater, version: f.updater.currentVersion.format(), packaged: true, preview: true });
        assert.equal((await updates.check()).state, 'error');
        assert.deepEqual(f.requests.slice(1), [f.manifestPath, f.manifestPath.replace(`/preview-${arch}`, `/latest-${arch}`)]);
        assert.equal(f.errors.at(-1)?.code, 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
        await assert.rejects(updates.download(), /available update/i);
      } finally { await f.cleanup(); }
    }
  } finally {
    if (priorArch === undefined) delete process.env.TEST_UPDATER_ARCH; else process.env.TEST_UPDATER_ARCH = priorArch;
  }
});
