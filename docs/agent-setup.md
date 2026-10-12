# Install Flusso Journal (for AI agents)

You are helping a person install **Flusso Journal**, a desktop app that keeps a
private Journal on their computer and can watch their Flusso notebooks. Follow
these steps on their machine. The person signs in themselves; you never need a
password, token or API key.

## 1. Find the newest build

Builds are published at
https://github.com/Tok6Flow0/flusso-listener/releases. Current builds are
previews, so `releases/latest` does not list them. Read the newest release,
including previews:

```sh
curl -fsSL "https://api.github.com/repos/Tok6Flow0/flusso-listener/releases?per_page=1"
```

Pick the asset that matches this computer:

| Computer | Asset name ends with |
| --- | --- |
| Mac with Apple silicon (M1 or later) | `-mac-arm64.dmg` |
| Mac with Intel | `-mac-x64.dmg` |
| Windows on x64 | `-win-x64.exe` |
| Windows on ARM | `-win-arm64.exe` |
| Ubuntu 24.04 / Debian on x64 | `-linux-amd64.deb` |
| Ubuntu 24.04 / Debian on ARM | `-linux-arm64.deb` |

Check the CPU with `uname -m` (macOS and Linux) or `$env:PROCESSOR_ARCHITECTURE`
(Windows PowerShell). Download only from that GitHub release.

## 2. Install

- **macOS:** open the DMG and drag Flusso Journal into Applications. Preview
  builds are not notarized yet. If macOS blocks the first launch, tell the person
  to open System Settings → Privacy & Security and choose **Open Anyway** for
  Flusso Journal. Never disable Gatekeeper.
- **Windows:** run the EXE. It installs for the current user without admin
  rights. If SmartScreen warns, let the person decide; never turn SmartScreen off.
- **Linux:** `sudo apt install ./Flusso-Journal-<version>-linux-<arch>.deb`.
  It needs an unlocked GNOME Keyring or KWallet.

## 3. Hand over to the person

Open Flusso Journal, then tell the person:

1. Click the account button at the bottom left and choose **Connect Flusso**.
   Their browser opens; they sign in and approve the device there.
2. Optional: click **Set up** to download the local model (about 1.4 GB, once).
3. In **Listener**, pick the notebooks to watch and turn it on.

Leave **Auto-trade** off. Only the person turns it on, after setting their own
limits. Do not install background services, change system security settings or
place orders unless they explicitly ask.

## Updating

Install the newer build over the old one. The Journal and its encryption key
stay where they are.
