# Desktop builds and releases

The desktop app bundles Electron and a pinned llama.cpp CPU runtime. Users do
not install Node or Ollama. First-time model setup downloads the pinned Qwen3
1.7B GGUF into the existing private Journal directory after the user chooses to
set it up. The app verifies the download's size and SHA-256 before loading it.
Model files are separate from installers and never enter Git.

Download published installers from the public
[Flusso Journal releases](https://github.com/Tok6Flow0/flusso-listener/releases).
The first desktop version is `0.2.0-preview.1`. A source checkout or a successful
build does not establish that a release has been published or installed.

| System | Native builds | Installer |
| --- | --- | --- |
| macOS 13.3 or later | Apple silicon and Intel | DMG and ZIP |
| Windows | ARM64 and x64 | Per-user NSIS EXE |
| Linux desktop | ARM64 and x64 | DEB (Ubuntu 24.04) and optional AppImage |

Linux needs an unlocked Secret Service such as GNOME Keyring or KWallet. The app
does not substitute a plaintext credential file. Windows installs without
administrator privileges. Uninstalling does not erase the existing Journal.
On Ubuntu 24.04, install the DEB through your package manager. Its standard
postinstall configures Chromium's sandbox and AppArmor profile. AppImage requires
compatible FUSE and sandbox support; it is not the recommended Ubuntu installer.
Never disable the Chromium sandbox or the operating system's security controls.

## Preview status

Electron is pinned to stable `44.7.0`, which embeds Node `24.21.0`.
The bundled llama.cpp runtime requires macOS `13.3`, which sets the app's
minimum above Electron's own macOS `13.0` requirement.
The signed-manifest tooling is pinned to `electron-builder 27.0.0-alpha.10` and
`electron-updater 7.0.0-alpha.9`. Those two packages are prereleases, so production
publishing is blocked until stable versions are deliberately adopted and tested.
See the official [Electron release](https://releases.electronjs.org/release/v44.7.0)
and [builder v27 migration notes](https://www.electron.build/docs/migration/v27-breaking-changes/).

Preview installers are not Apple-notarized or Microsoft-signed. The operating
system may warn or refuse installation under an administrator's policy. Do not
disable Gatekeeper, SmartScreen, or signature verification. Preview builds
publish GitHub prereleases with architecture-specific `preview-*` update
manifests. Packaged preview apps check that channel on launch and on a quiet
cadence, then show an in-app Update prompt (download, then restart) when a
newer signed manifest is available. They do not create `latest` production
manifests or replace a stable release. The preview release workflow still
requires cryptographically signed update metadata. A signed manifest
authenticates that metadata; it does not make an unsigned installer notarized
or prove that all runtime paths have been tested.

## Build locally

Maintainers need Node in the supported Node 24 series and the native operating
system/architecture being packaged. CI uses Node `24.21.0` on six native runners
to avoid cross-compiling OS credential-store bindings.

```sh
npm ci
npm run check
npm run desktop:prepare
npm run desktop:pack
```

`desktop:pack` creates an unpacked app in `dist`. `npm run desktop:dist` creates
native installers. `npm run desktop` starts the source desktop app.
`npm start` and `npm run journal` retain the existing advanced CLI workflows.
The prepare step verifies the exact archive pinned in
`desktop/resources.json`, keeps its sibling native libraries and license, and
copies them under the installed app's `resources/runtime` directory. Never
replace that archive with an unverified executable.

App icons derive directly from Flusso's approved C3 Faceted Flow artwork.
`build/brand-assets.json` records the source approval hash and derived file
hashes. The artwork has not been redrawn.

## Release workflow

Every push to `main` builds and publishes a unique preview release
(`<major.minor.patch>-preview.<run-number>`) so installed Journals can pick it
up through the in-app Update prompt. Use **Actions → Desktop release → Run
workflow** for a manual build; `publish` defaults to false unless you enable it.
Push a matching `v<package-version>` tag for a deliberate versioned release.
All six builds must succeed before publication. An existing release is
immutable; the workflow refuses to overwrite its assets.

Every release run requires the repository secret
`ELECTRON_BUILDER_UPDATE_SIGN_KEY`: an Ed25519 private key in PEM PKCS8 format.
Generate it once, retain it in the maintainer's OS vault, and provision the
secret through a secure local administrative flow. Never paste the key into an
issue, chat, command-line argument, log, or source file. The builder accepts the
same environment variable locally, or `ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE`
pointing to a private file. Its key-generation command writes a new file with
owner-only permissions and refuses to overwrite an existing file:

```sh
npx --no-install electron-builder create-update-key --out /private/location/flusso-update.pem
```

The corresponding public key is embedded by the builder in `app-update.yml`.
The updater verifies Ed25519 metadata before downloading an update; operating
system signature checks remain enabled. See
[signed update manifests](https://www.electron.build/features/signed-update-manifests/).

Native jobs emit unique architecture channels, for example
`preview-arm64-mac.yml`, `preview-x64.yml`, and
`preview-arm64-linux-arm64.yml`. Signed manifests are never merged or edited
after signing. The installed provider configuration carries the channel;
runtime code must leave `autoUpdater.channel` unset so GitHub prerelease
selection uses the version's `preview` component correctly.

Production requires all of the following before a build can be published:

- Stable app, builder, and updater versions.
- The signed-manifest private key above.
- `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`: a base64 Developer ID application
  certificate archive and its password.
- `APPLE_API_KEY`: the App Store Connect API private `.p8` contents, plus
  `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, for notarization.
- `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`: a base64 Authenticode certificate
  archive and its password.
- Passing native module, application, installer, code-signing and notarization
  checks. CI verifies macOS signatures, Gatekeeper assessment and stapling, and
  Windows installer Authenticode signatures before uploading artifacts.

The workflow writes the Apple API key only to a private runner temporary file
and removes it at the end of the job. Signing credentials are supplied only to
the build step, not dependency installation or the app smoke test. Manifest
validation uses the packaged app's embedded public trust key and checks the
actual installer hashes. Certificate archives must use base64 values. GitHub's temporary
publication token has write permission only in the
final release job. No certificate or private update key is included in the app.

## Validation boundaries

`npm run check` exercises Journal encryption, account boundaries, signal
deduplication, bounded execution, model isolation and the desktop UI contract.
The release workflow additionally loads the native keyring binding and executes
an in-memory SQLite query inside the bundled Electron Node runtime. This checks
native compatibility; an unlocked real OS vault and end-to-end browser consent
still need testing in the installed app on each supported system. No release
check submits a real trade.
Linux CI installs the DEB and runs the installed application with sandboxing
enabled. The optional AppImage is built and checked against its signed update
manifest, but is not the Linux runtime smoke-test target.
