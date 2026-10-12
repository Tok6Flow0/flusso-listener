# Flusso Listener

Your private local Journal, with an optional listener that watches selected notes
and structured market observations. Connect your Flusso account through browser
sign-in, keep a local encrypted copy of your cloud Journal, or work entirely on
this computer. The app never listens to your microphone or reads your screen.

The code is open source. Cloud account access remains subject to your Flusso
plan, approved device scopes, and current server permissions.

## Start in two steps

Prerequisites: [Node 24.19 or newer in the Node 24 series](https://nodejs.org/en/download)
and, for local classification, [Ollama](https://ollama.com/download).
The Journal works without a model. Use an unlocked OS credential store:
macOS Keychain, Windows Credential Manager, or a Linux Secret Service such as
GNOME Keyring or KWallet. A headless Linux machine needs a working user Secret
Service; the app refuses to fall back to plaintext credentials.

1. Download and install this app:

   ```sh
   git clone https://github.com/Tok6Flow0/flusso-listener.git
   cd flusso-listener
   npm ci
   ```

2. Start it. For the listener, download the one default model first:

   ```sh
   ollama pull qwen3:1.7b
   npm start
   ```

The GUI opens in your browser at an address on `127.0.0.1`. Its per-start private launch
fragment unlocks the local session; keep that local URL private. No Flusso API
credential appears in it. If the app is already running, `node src/cli.mjs open`
opens its GUI again. See [always-on setup](docs/always-on.md) to opt into a
per-user login service. Installation does not enable a service or execution.

## Give this to your existing AI agent

Copy this instruction into the agent you use to set up software on your computer:

> Install the public Flusso Listener from
> https://github.com/Tok6Flow0/flusso-listener. Read its README and SECURITY.md
> before running setup. Use Node 24 and the existing OS credential store; keep
> the app and Ollama bound to loopback. Install the pinned npm dependencies with
> npm ci and the local Ollama model qwen3:1.7b. Start the app and let me complete
> browser sign-in myself. Never ask for my Flusso password, tokens, or API key in
> this chat. Leave execution off. Do not install a background service, approve a
> spending policy, or submit a real order unless I specifically request it.

Your agent can install and write local notes; you complete device consent in the
browser. There is no API key to paste into a model prompt. The browser uses
OAuth with PKCE and exchanges a single-use authorization code for a revocable
device connection. The default connection lifetime is 90 days; choose a different
available lifetime in Flusso's consent/settings. A device credential does not
replace trading-policy approval.

## Keep a Journal

Create notebooks and entries in the GUI. `body` stores Markdown text unchanged;
the detail view renders headings, lists, bold, inline code, fenced code, and tables safely without executing HTML or remote content. External links and images remain text.
Use the optional structured signal to preserve normalized asset identity,
strategy/source provenance, side, direction, quantities and their units. Missing
data stays null. Plain notes need no asset and no quantity.

Cloud Journal copies are read-only here. Edit them in Flusso or explicitly copy
an entry into a local notebook. Local notes stay local; synchronizing copies
cloud notes down and never uploads local notes. Telegram alerts stay off for
local notes, and downloading a cloud note sends no Telegram alert.

An agent with local filesystem access can use the same encrypted Journal without
an HTTP token. First list notebooks:

```sh
node src/cli.mjs journal notebooks
```

Then supply JSON on stdin, using the actual returned local notebook ID:

```sh
node src/cli.mjs journal create --idempotency-key my-original-research-key < entry.json
```

```json
{
  "notebookId": "COPY_THE_RETURNED_LOCAL_NOTEBOOK_UUID",
  "title": "Morning research",
  "body": "## Morning opportunities\n\nThe source is unavailable; revisit before making a decision.",
  "status": "watching",
  "source": "agent",
  "observedAtUtc": null,
  "signal": null
}
```

Read back the returned ID with `journal get ENTRY_UUID`. Use `journal update
ENTRY_UUID < updated-entry.json` with its current `version`; an omitted `signal`
preserves an existing attachment and explicit null removes it. Reuse a creation
retry key only for the same exact content. See `node src/cli.mjs help` and
[the portable signal example](examples/structured-entry.json).

## Watch selected observations

In **Listener**, select Local, Cloud, or Both; choose notebooks, an optional exact
Markdown heading, a polling interval, and research instructions. Turn the listener
on and save. It checks while the process is running and the computer is awake.
Source/notebook/heading filters are enforced by code; freeform instructions guide
the small model's classification. They are not hard financial controls.

Existing notes become a baseline on startup or when switching the listener on.
The first automatic cloud import also becomes a baseline. New observations and
later revisions are classified once per revision. Cloud synchronization scans
all pages, bounded at 5,000 entries, so edits to older notes are found. An
incomplete scan is displayed and does not authorize cloud execution.

Qwen3 1.7B is an Apache 2.0 licensed default with an approximately 1.4 GB Ollama
download. That is model storage, not total runtime RAM. Actual RAM and speed
depend on the computer and context length. We recommend at least 8 GB of system RAM for the app, model, and everyday OS use; test on the actual machine before leaving it unattended. This app uses a bounded 4,096-token
context, one request at a time, and nonthinking structured output. A small model
can miss relevant notes or misclassify them; its output is a suggestion, never a
source of facts or permission. The model unloads after five idle minutes while
the lightweight listener remains on. See [model and privacy notes](docs/model.md).

## Optional bounded execution

Execution is off by default. In **Execution policy**, select your account and a fresh supported market,
then enter explicit quantity/price/spending caps, maximum
runs and a UTC start/expiry. Review the server's exact preview, then press
**Approve this exact policy**. Approval saves a policy for this connection and
leaves execution off. Enable it separately in **Listener** only when ready.

The existing server currently supports **spot BTC/USD buy-limit orders, at most
one admission per UTC hour per policy**. Only one fresh structured leg with a
stable source-record identity, exact matching asset, explicit BTC base quantity,
and positive reference limit price can reach that lane. Plain Markdown, unsupported
assets/actions, paired signals, missing units, stale or degraded evidence, and
signals exceeding your policy are kept for review. The app does not increase a
budget to meet a minimum, invent contract terms, or retry an uncertain order.

The server rechecks account ownership, plan, device authorization, immutable
budgets, cash, risk, capability and writer permissions. A model cannot override
them. Source-signal deduplication spans local/cloud copies and prose edits.
Each possible submission is durably saved before dispatch. Unknown or pending
outcomes pause new execution until canonical readback using the original retry
key resolves them. A command receipt is not a fill. Revoking a policy stops
future admissions; outstanding orders require their own cancellation.

No live trade is required for installation or tests. `npm test` uses isolated
encrypted temporary stores and fake cloud/model adapters, never your capital.

## Privacy and recovery

All network traffic to Flusso uses HTTPS. Journal payloads, settings, source
snapshots, and attempt bodies are encrypted with AES-256-GCM; the independent
random encryption key and cloud credential bundle live in your OS credential
store. They are not derived from your account password. The SQLite database
still exposes opaque record identifiers and revision counts, not encrypted
payload contents. Local GUI/Ollama communication uses HTTP on loopback only;
it is **not TLS-encrypted** and never leaves the computer. Do not expose either
port through a tunnel, reverse proxy, LAN bind or firewall forwarding.

The default data folder is Application Support on macOS, LocalAppData on Windows,
or XDG data home on Linux, under `Flusso Listener` / `flusso-listener`. It is
separate from this Git checkout and ignored files never belong in a public
repository. `--data-dir PATH` chooses an explicit folder. Back up the encrypted
database **and** preserve your OS keychain; without the original key, the
Journal cannot be decrypted. Moving a data folder changes its vault namespace
and requires deliberate keychain migration; do not delete the original. If a crash leaves `key.init`, the next startup recovers a proven-dead owner automatically. An empty crash lock can be recovered after 30 seconds. If a lock remains, stop every Listener process before inspecting/removing that lock alone; never delete the database or reset its key.

Disconnect removes this app's local cloud credentials and stops its listener;
it does not delete notes. Use Flusso device settings to revoke server access.
Same-user malware or an agent already authorized to control this OS account can
access the unlocked app. This app is not a sandbox for untrusted local programs.

Code: MIT. Model and bundled fonts retain their own licenses. The Flusso brand
mark remains a Flusso trademark; see [NOTICE](NOTICE). Contributions should keep
the fixed cloud origin, typed operations, vault boundary and deterministic
execution checks intact.
