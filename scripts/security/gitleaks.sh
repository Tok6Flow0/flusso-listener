#!/usr/bin/env bash
# Pinned official scanner; no production credentials or repository-secret input.
set -euo pipefail
umask 077
readonly version=8.30.1
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
task_dir="$(mktemp -d "${TMPDIR:-/tmp}/flusso-gitleaks.XXXXXXXX")"
trap 'rm -rf "$task_dir"' EXIT

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    asset="gitleaks_${version}_linux_x64.tar.gz"
    checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Darwin/arm64)
    asset="gitleaks_${version}_darwin_arm64.tar.gz"
    checksum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  *) echo 'Unsupported scanner platform; use Linux x64 or macOS arm64.' >&2; exit 2 ;;
esac
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}" \
  --output "$task_dir/$asset"
printf '%s  %s\n' "$checksum" "$task_dir/$asset" | shasum -a 256 --check --status
tar -xzf "$task_dir/$asset" -C "$task_dir" gitleaks

scan() {
  local scan_status=0
  "$task_dir/gitleaks" "$@" --config "$repo_root/.gitleaks.toml" --redact=100 --no-banner \
    --report-format json --report-path "$task_dir/report.json" || scan_status=$?
  if [ "$scan_status" -ne 0 ] && [ -f "$task_dir/report.json" ]; then
    # Log only stable source locations and rule IDs, never matches or source lines.
    python3 - "$task_dir/report.json" "$task_dir/source/" <<'PY'
import json, sys
for finding in json.load(open(sys.argv[1])):
    path = finding['File'].split('/source/', 1)[-1]
    print(f"{path}:{finding['StartLine']}: {finding['RuleID']}")
PY
  fi
  return "$scan_status"
}

case "${1:-tree}" in
  staged)
    scan git --staged ;;
  tree)
    # Scan exactly the index, including new staged files, without ignored local data.
    mkdir "$task_dir/source"
    git archive "$(git write-tree)" | tar -xf - -C "$task_dir/source"
    scan dir "$task_dir/source" ;;
  range)
    test "$#" -eq 3
    base="$(git rev-parse --verify --end-of-options "$2^{commit}")"
    head="$(git rev-parse --verify --end-of-options "$3^{commit}")"
    scan git --log-opts="$base..$head" ;;
  *) echo 'Usage: scripts/security/gitleaks.sh [staged|tree|range BASE HEAD]' >&2; exit 2 ;;
esac
