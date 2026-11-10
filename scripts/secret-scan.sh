#!/usr/bin/env bash
# Redacted secret scan for the revision under test.
# Scans this checkout's history and the committed tree. Does not scan other branches.
# Gitleaks output stays in temporary files and is not printed.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(pwd)"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "secret scan supports linux x86_64" >&2
  exit 1
fi

version="8.30.1"
checksum="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
bindir="${root}/.tools"
bin="${bindir}/gitleaks"
archive=""
reports=()
tree=""

cleanup() {
  if [[ -n "$archive" ]]; then
    rm -f "$archive"
  fi
  if ((${#reports[@]})); then
    rm -f "${reports[@]}"
  fi
  if [[ -n "$tree" ]]; then
    rm -rf "$tree"
  fi
}
trap cleanup EXIT

if [[ ! -x "$bin" ]] || ! "$bin" version 2>/dev/null | grep -q -F "$version"; then
  mkdir -p "$bindir"
  archive="$(mktemp)"
  curl -fsSL -o "$archive" "https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz"
  echo "${checksum}  ${archive}" | sha256sum -c -
  tar -xzf "$archive" -C "$bindir" gitleaks
  chmod +x "$bin"
  rm -f "$archive"
  archive=""
fi

run_scan() {
  local mode="$1"
  shift
  local report err ec
  report="$(mktemp)"
  err="$(mktemp)"
  reports+=("$report" "$err")
  set +e
  "$bin" detect "$@" --no-banner --no-color --redact=100 --log-level error \
    --report-format json --report-path "$report" >"$err" 2>&1
  ec=$?
  set -e
  if [[ "$ec" -ne 0 && "$ec" -ne 1 ]]; then
    echo "secret scan could not run (${mode}, exit ${ec})" >&2
    exit 1
  fi
  python3 scripts/secret_scan_report.py "$report" "$mode"
  rm -f "$report" "$err"
}

run_scan history --source "$root" --log-opts=HEAD

tree="$(mktemp -d)"
git archive HEAD | tar -x -C "$tree"
run_scan tree --source "$tree" --no-git
tree_path="$tree"
tree=""
rm -rf "$tree_path"
