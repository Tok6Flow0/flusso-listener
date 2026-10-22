# Flusso Journal

Your private local Journal, with an optional listener that watches selected notes
and structured market observations. Connect your Flusso account through browser
sign-in, keep a local encrypted copy of your cloud Journal, or work entirely on
this computer. The app never listens to your microphone or reads your screen.

The code is open source. Cloud account access remains subject to your Flusso
plan, approved device scopes, and current server permissions.

## Download and open

1. Download the installer for your computer from [desktop releases](https://github.com/Tok6Flow0/flusso-listener/releases): macOS (Apple silicon or Intel), Windows (ARM64 or x64), or Linux desktop (ARM64 or x64).
2. Open **Flusso Journal**. Start writing immediately. Choose **Set up local model** if you want the Listener to review new observations; it downloads and verifies Qwen3 1.7B once, or reuses the exact verified model already in your local Ollama cache.

The standalone app includes its runtime. You do not install Node or Ollama.
The full Flusso dashboard remains at [flusso.stream](https://flusso.stream).
Choose the account control at the bottom left to connect, disconnect, open account settings, or check the app version and updates. Cloud access is optional.

Version **0.2.0-preview.6** remains an unsigned preview. Review the release's platform requirements and signing status. Packaged preview builds check GitHub for newer signed preview manifests on launch and every few hours; when one is available, a corner **Update** prompt lets you download and restart—no manual redownload. Production builds use the same flow on the stable channel. Do not disable OS signature protections. See [desktop release details](docs/desktop-releases.md).

Use an unlocked OS credential store: macOS Keychain, Windows Credential Manager,
or Linux Secret Service (GNOME Keyring or KWallet). On Ubuntu 24.04, use the DEB
installer; it configures Chromium's sandbox through the standard package lifecycle.
AppImage builds require compatible AppImage/FUSE and sandbox support on your
distribution. The app refuses plaintext credentials.
Closing the window keeps the app and opted-in Listener in the tray; choose
**Quit Journal and stop Listener** to stop it. The computer must remain awake.
Open-at-login is optional on macOS and Windows; Linux uses its desktop's startup settings.
Installation never enables execution.

## Advanced source installation

Maintainers need [Node 24.19 or newer in the Node 24 series](https://nodejs.org/en/download).

```sh
git clone https://github.com/Tok6Flow0/flusso-listener.git
cd flusso-listener
npm ci
npm run desktop:prepare
npm run desktop
```

For the existing browser/CLI interface, run `npm start`. Its classifier requires
[Ollama](https://ollama.com/download) and `ollama pull qwen3:1.7b`; the desktop
app does not. The browser GUI binds `127.0.0.1`, and its private per-start launch
fragment unlocks the local session. Keep that URL private. `node src/cli.mjs open`
reopens a running CLI app. [CLI login services](docs/always-on.md) remain optional;
do not run a CLI service and desktop app against the same Journal simultaneously.

## Give this to your existing AI agent

Paste this into Claude, ChatGPT, Codex, Cursor or whichever agent can work on
your computer:

> Install Flusso Journal for me by following
> https://github.com/Tok6Flow0/flusso-listener/blob/main/docs/agent-setup.md

The agent downloads the right build for your computer, installs it and opens it.
You then connect your account in the browser yourself.

Your agent can install and write local notes; you complete device consent in the
browser. There is no API key to paste into a model prompt. The browser uses
OAuth with PKCE and exchanges a single-use authorization code for a revocable
device connection. The default connection lifetime is 90 days; choose a different
available lifetime in Flusso's consent/settings. A device credential does not
enable auto-trade or replace your explicit local execution limits.

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
  "status": "reviewed",
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
The first automatic cloud import also becomes a baseline. Order tickets are the
exception: any ticket written within **Act on tickets from the last** (6 hours by
default) that hasn't been acted on is decided, placed or refused, even if it
arrived while the app was closed. A setup gap, such as auto-trade being off, is not
a decision: the ticket waits and is decided once the gap is fixed, if it is still
inside the window. New watched notes and
later revisions are classified once per revision; explicit order tickets use
deterministic validation and do not need a model. Cloud synchronization scans
all pages, bounded at 5,000 entries, so edits to older notes are found. An
incomplete scan is displayed and does not authorize cloud execution.

The Listener shows the local model's actual JSON response as it is generated.
**Check now** also re-reviews the newest selected research note whose status is
watching or reviewed, even if that revision was already checked. Scheduled checks also re-review the newest selected research note each period,
even when it has not changed. Other watching revisions retain their checkpoints. Manual review does not replay decided
action tickets or reopen closed notes. If no research note matches the selection,
no model response is invented.

Model output is separate from the collapsible **Operations log**, which reports
Journal reads, validation, submission and receipts. A partial response remains
labelled streaming, stopped or failed until a complete response passes validation.
The model runs with thinking disabled. Execution receipts remain saved in Activity
and on the entry.

The private status response also explains each entry's hand-off state, including
research without an explicit ticket, reviewed entries, baselined revisions,
selection filters, malformed or stale tickets, and waiting setup. These are local
diagnostics; they do not certify current server or venue admission.

Run `npm run replay` for an isolated synthetic replay through the real Listener.
It uses a temporary encrypted Journal and in-process fake cloud/model operations,
checks research, explicit tickets, copies, restart and uncertain delivery, and
labels every submission as simulated. It never opens your Journal or OS vault,
downloads a model, or contacts Flusso or a venue.

Qwen3 1.7B is an Apache 2.0 licensed default with an approximately 1.4 GB verified model
download. That is model storage, not total runtime RAM. Actual RAM and speed
depend on the computer and context length. We recommend at least 8 GB of system RAM for the app, model, and everyday OS use; test on the actual machine before leaving it unattended. This app uses a bounded 4,096-token
context, one request at a time, and nonthinking structured output. A small model
can miss relevant notes or misclassify them; its output is a suggestion, never a
source of facts or permission. The desktop model stays loaded until you quit the app; it uses inference CPU
only for new in-scope observations. The advanced Ollama path unloads after five idle minutes. See [model and privacy notes](docs/model.md).

## Optional bounded execution

Execution is off by default. Connect with write access, select your account in
**Listener**, and set **Max per order**, **Max per ticket**, and **Max leverage**
before enabling **Auto-trade** and saving. These local limits are ceilings, not
an allocation or a server-persisted trading policy. Optional slippage and volume
conditions can tighten each order. The app never raises account or venue leverage.

Auto-trade is a Flusso Automate and Pro feature, and Flusso enforces it on its
servers, not in this app. Every order placed through a connected AI or app,
this listener included, counts toward your plan's daily allowance of order legs
(Trader 10, Automate 100, Pro 500). Orders you place in Flusso itself don't
count, and cancels and closes are never limited. If an allowance or plan check
refuses a ticket, Activity shows why and nothing was placed.

Order instructions use an explicit `flusso-orders` Markdown code fence in a new
in-scope entry with status `watching`. Its JSON contains `id`, optional
`together`, and an `orders` array. Give every intended submission a unique stable
ticket `id` and retain it across edits and local/cloud copies. Each element uses
the existing basic order fields: exact public `venue:instrument` from Flusso
market facts, `side` (`buy` or `sell`), positive `quantity` in that venue's native
contract units, positive `limitPrice`, and optional supported `conditions`.
Verify instrument terms and steps before sizing; equal contract counts on two
venues are not equal exposure. Plain prose and a structured signal attachment do
not become orders. Reviewed hourly research with `signal: null` cannot execute.

To close existing positions, use one `flusso-close` fence instead. Its JSON
contains a unique stable ticket `id` and `positionIds`, an array of 1–25 exact
canonical position IDs read from your owned Flusso account. For example, replace
the placeholder before creating a new `watching` entry:

````markdown
```flusso-close
{"id":"my-original-close-ticket","positionIds":["COPY_OWNED_CANONICAL_POSITION_ID"]}
```
````

The Listener calls the existing `closeTradingAccountPositions` operation.
Execution resolves the position's venue, side and size, preserves hedge groups,
and uses its reduce-only close path. An ordinary opposing order can open new
exposure and is not a substitute for a close ticket. Keep one action ticket per
entry. A close still requires the selected account, notebooks, write connection,
Auto-trade and a fresh watching revision; it does not allocate opening notional.

The listener calls the existing `submitManualFuturesLimitOrder` tool with
`product.manual_order_request.v3`. Supported instruments are the server's
qualified linear crypto perpetuals, using limit orders. A hedge is two ordinary
independent elements, dispatched in parallel with bounded concurrency. With
`together: true`, a shared short dispatch delay coordinates their release; it
does not make them atomic or guarantee simultaneous arrival or fills.

Local order and ticket ceilings tighten the submitted `maxNotionalUsd`
conditions. A ticket that already requests `maxLeverage` is tightened to the
local leverage ceiling and that condition is sent to execution; the local
ceiling alone does not invent a leverage condition on every order. Where
authenticated native per-order leverage is supported, execution binds a choice
within the witnessed bounds and ceiling while preserving margin mode. Otherwise
configured leverage must be proven at or below the ceiling. Missing private
proof refuses a ticket that requested `maxLeverage`; a public venue maximum is
not the account's setting. The server still checks ownership, live plan,
connection consent, margin, venue terms, risk and writer authority. A model
cannot override those checks or create a ticket from research text. Turning
auto-trade off during a preview prevents its confirmation; it cannot recall an
order already sent.

With **Note results on the entry** on (the default), every decision is written
back to the ticket's own Journal entry: a `## Listener result` section with
placed, partly placed, refused or not placed, the reason, and each order's
result, and the entry is marked reviewed. Cloud entries are updated through your
Flusso connection, so you and your agents see the outcome in Flusso too. The
Journal list shows the same result on each ticket and can filter by it.

Each possible submission is durably saved before dispatch. Activity retains
separate `submitted`, `blocked`, `unknown` or `not_sent` results for every element;
one submitted leg with another refused or unresolved leaves residual exposure.
Submitted is not filled. Unknown or pending outcomes pause new execution, with
no automatic order POST retry. Check canonical orders, fills and positions in
Flusso before resolving an order or close attempt; preserve its original request and retry key,
never edit an uncertain request or create a replacement ticket to retry it.
Turning auto-trade off does not cancel existing orders or close positions.

No live trade is required for installation or tests. `npm test` uses isolated
encrypted temporary stores and fake cloud/model adapters, never your capital.

## Privacy and recovery

All network traffic to Flusso uses HTTPS. Journal payloads, settings, source
snapshots, and attempt bodies are encrypted with AES-256-GCM; the independent
random encryption key and cloud credential bundle live in your OS credential
store. They are not derived from your account password. The SQLite database
still exposes opaque record identifiers and revision counts, not encrypted
payload contents. Local GUI/model communication uses HTTP on loopback only;
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
