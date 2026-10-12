# Security boundary

Report a vulnerability privately through the security contact listed on
[Flusso](https://flusso.stream). Do not put credentials or private Journal data
in a public issue.

The local OS account is trusted. The listener has no shell, arbitrary HTTP,
browser, microphone, or screen tool available to the model. Its only model
output is a constrained classification and reason. Journal text and imported
market data remain untrusted input. Schema checks, exact identities, current
source timestamps and server policy/risk enforcement protect the mutation path;
prompt wording alone is not the security boundary.

The GUI binds IPv4 loopback, checks the exact Host, issues a per-start local
session, uses HttpOnly/SameSite cookies and explicit Origin/CSRF checks on
mutations, refuses CORS, and serves only allowlisted static files. The private per-start launch
fragment is reusable within this process lifetime and contains a local session capability and is removed from browser history
after use. OAuth has a separate ephemeral loopback callback with one-time state,
issuer validation and PKCE. Cloud endpoints must remain on the configured HTTPS
Flusso origin. Redirects are refused.

The OS vault holds cloud tokens and the random Journal encryption key. Linux
requires persistent Secret Service rather than a nonpersistent kernel-keyring
fallback. SQLite stores authenticated encrypted payloads. No plaintext vault
fallback, password-based credential wrapping, credential CLI argument, telemetry,
or remote font/image dependency is used.

Execution requires the owner's exact server policy preview/approval followed by
a separate local opt-in. Existing immutable server limits, ownership, capability,
cash, private risk, writer gates, idempotency and kill controls remain in force.
Every possible POST has a durable source identity and original body/retry key;
lost or ambiguous outcomes are reconciled without dispatching a replacement.
Changing a note, settings, source clocks, local/cloud copy or model response
does not erase that execution claim.

Tests cover adversarial model output, malformed callbacks, wrong origin/Host,
encrypted persistence, optimistic edits, duplicate signals, settings races and
unknown submissions. They cannot prove that all prompt injection is impossible
or that every OS/browser configuration is secure. Keep Node, Ollama and the OS
credential store updated.


## Desktop isolation and updates

The renderer uses a sandbox, context isolation, no Node integration, an explicit
CSP, and no granted browser permissions. A fixed preload bridge exposes only
Journal app controls. IPC checks the live window, main frame and exact local
document origin. External browser navigation is restricted to HTTPS Flusso URLs;
new renderer windows and webviews are denied.

The bundled engine and first-use model download are pinned and integrity checked;
redirects are restricted to the official distribution hosts. Inference has a
random loopback API key and no prompt logging. Quitting aborts setup and drains
active work before closing the encrypted Journal. The model cannot download or
install software.

Production updates require Ed25519-signed manifests plus native platform checks.
Downloads and installation each require a user action; the app disables automatic
installation and downgrades. An update stops the listener and disables execution
before restart. Preview builds disable automatic production updates. Distribution
signing/notarization and prerelease tooling limits are documented in
[desktop-releases.md](docs/desktop-releases.md).
