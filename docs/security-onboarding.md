# Development access and secret protection

Aaron (`@Tok6Flow0`) or his Codex session owns changes to existing `AGENTS.md`
files and repository governance. Junior developers use their own normal GitHub
accounts, topic branches and reviewed pull requests for useful development and
security work. They do not need production database, Railway, release-signing or
production-secret access. Never share Aaron's sessions, credentials or tokens.

CODEOWNERS requests Aaron's review for agent instructions, workflows and scanner
controls. GitHub must separately require code-owner review, dismiss stale
approvals and prevent bypasses; the file alone does not enforce those settings.
No new `AGENTS.md` is required for onboarding.

## Secret checks

Run `bash scripts/security/gitleaks.sh tree` before a pull request. Enable the
optional local staged check with `git config core.hooksPath .githooks`. CI runs
the same pinned, checksum-verified Gitleaks release without production secrets
and scans every commit proposed by a pull request. It prints only redacted
source locations. A hook can be skipped; required CI is the enforcement point.
The tracked tree scan covers the Git index; stage intended edits before running
it. The script requires Bash, curl, tar, shasum and Python 3 on Linux x64 or
macOS arm64.

Keep secrets in approved server secret stores or the local OS vault. Use explicit
nonfunctional examples and environment references in source. Do not commit real
credentials even in tests, inactive code, logs or documentation. Review scanner
matches in context. Any exception must bind the exact path and exact source line
and explain why it grants no private authority; do not allowlist whole test or
documentation directories. Detection cannot prove that every possible credential
format is absent, and this workflow does not scan historic commits automatically.

If a credential is exposed, report it privately to Aaron, revoke or rotate it at
the provider, and assess history/artifacts before any coordinated cleanup. Never
copy the value into an issue, PR, chat, test log or scanner exception.

## Build and release boundary

Production builds and releases can execute repository code. Keep production
credentials out of ordinary test and pull-request jobs. Production deployment and
signing require Aaron's reviewed source and separately protected credentials;
repository instructions and packaging exclusions do not replace platform IAM.

The desktop workflow signs and publishes previews from main. Both its plan and
build jobs use the `release-signing` environment, which requires Aaron's approval,
disallows admin bypass, and permits only `main` and `v*` tags. An active GitHub tag
ruleset restricts creation, update and deletion of `v*` tags to repository admins.
Ordinary development branches cannot obtain the update-signing key. The
repository-level key was removed after an encrypted owner-only migration and a
protected job verified the same public-key identity as the existing packaged app.
Installed update trust was preserved; no signing key was rotated.

Keep these platform controls in place when editing the workflow or changing
repository visibility. Required main checks are `Secret scan` and `Governance
ownership`, with code-owner review and stale-approval dismissal. Aaron remains
the only code owner; legitimate feature and security work follows reviewed PRs.
Main and tag releases retain their previous version rules and platform matrix.
