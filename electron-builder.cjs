const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const channel = process.env.FLUSSO_RELEASE_CHANNEL ?? 'preview';
const arch = process.env.FLUSSO_BUILD_ARCH ?? process.arch;
if (!['preview', 'production'].includes(channel) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported desktop release channel or architecture.');
const production = channel === 'production';
const manifest = JSON.parse(readFileSync(join(__dirname, 'package.json')));
if (!production && !manifest.version.includes('-')) throw new Error('Preview builds require a prerelease app version.');
if (production && [manifest.version, manifest.devDependencies['electron-builder'], manifest.dependencies['electron-updater']].some(version => version.includes('-'))) {
  throw new Error('Production releases require stable app, builder and updater versions. Use the preview channel.');
}
const runtime = join('build', 'runtime', `${process.platform}-${arch}`);
if (!existsSync(join(__dirname, runtime, 'resource-version.json'))) throw new Error('Prepare the pinned native runtime with npm run desktop:prepare first.');

module.exports = {
  appId: 'stream.flusso.listener',
  productName: 'Flusso Journal',
  artifactName: 'Flusso-Journal-${version}-${os}-${arch}.${ext}',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['desktop/**/*', 'src/**/*', 'public/**/*', 'LICENSE', 'NOTICE', '!**/*.test.mjs'],
  extraResources: [
    { from: runtime, to: 'runtime', filter: ['**/*'] },
    { from: 'build/QWEN-LICENSE', to: 'licenses/QWEN-LICENSE' },
  ],
  extraMetadata: { flussoReleaseChannel: channel, flussoAutoUpdateEnabled: production },
  asar: { unpack: ['**/*.node', '**/*.dylib', '**/*.so', '**/*.dll'] },
  nativeModules: { npmRebuild: true, buildDependenciesFromSource: false, verifyNativeBinaries: true },
  toolsets: { winCodeSign: '1.3.0', appimage: '1.1.0', fpm: '2.2.1', nsis: '1.2.1', sevenZip: '1.0.1', icons: '1.2.3' },
  generateUpdatesFilesForAllChannels: false,
  updateManifest: {},
  publish: [{
    provider: 'github', owner: 'Tok6Flow0', repo: 'flusso-listener',
    // Distinct architecture channels keep each native runner's signed manifest intact.
    channel: `${production ? 'latest' : 'preview'}-${arch}`,
    releaseType: production ? 'release' : 'prerelease',
    publishAutoUpdate: true,
  }],
  mac: {
    target: ['dmg', 'zip'], icon: 'build/icon.icns',
    category: 'public.app-category.finance', minimumSystemVersion: '13.3',
    forceCodeSigning: production,
    sign: production ? { hardenedRuntime: true } : null,
    notarize: production,
  },
  dmg: { sign: production },
  win: {
    target: ['nsis'], icon: 'build/icon.ico', requestedExecutionLevel: 'asInvoker',
    forceCodeSigning: production,
    verifyUpdateCodeSignature: true,
  },
  nsis: {
    oneClick: false, perMachine: false, allowElevation: false,
    allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false,
  },
  linux: { target: ['AppImage', 'deb'], icon: 'build/icons', category: 'Office;Finance', executableName: 'flusso-journal' },
  // Reuse builder's AppArmor/SUID postinstall so Ubuntu can keep Chromium sandboxing enabled.
  deb: { maintainer: 'Flusso <support@flusso.stream>', depends: ['default', 'libgbm1'] },
};
