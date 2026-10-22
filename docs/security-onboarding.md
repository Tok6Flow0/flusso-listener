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

The current desktop workflow signs and publishes previews on main pushes. Its
repository-level update-signing secret is available to trusted repository
workflows. Before widening write access, Aaron must coordinate moving signing
authority into a protected release environment (with required owner approval and
branch/tag restrictions), remove the repository-level copy, and bind both the
plan and build jobs to that environment. All-platform release behavior must be
verified during that coordinated change. This onboarding patch does not change
the key, trusted public update keys or release behavior.
