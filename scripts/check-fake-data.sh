#!/usr/bin/env bash
# Fail when the invented health number or the invented patient name
# shows up outside fixtures/, test/, and tests/. The acceptance harness
# quotes that fake data, so tests/ is allowed to contain those markers.
# The markers are assembled at runtime so this script does not contain
# the literals.
set -euo pipefail
cd "$(dirname "$0")/.."

health="$(printf '%s-%s' '12345' '6789')"
name="$(printf '%s %s' 'Jane' 'Testpatient')"

mapfile -t files < <(git ls-files --cached --others --exclude-standard)

scan=()
fail=0
for f in "${files[@]}"; do
  case "$f" in
    fixtures/*|test/*|tests/*) continue ;;
  esac
  if [[ ! -f "$f" ]]; then
    continue
  fi
  scan+=("$f")
  lowpath="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
  lowhealth="$(printf '%s' "$health" | tr '[:upper:]' '[:lower:]')"
  lowname="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lowpath" == *"$lowhealth"* ]]; then
    echo "health number leaked into path: $f" >&2
    fail=1
  fi
  if [[ "$lowpath" == *"$lowname"* ]]; then
    echo "name leaked into path: $f" >&2
    fail=1
  fi
done

if ((${#scan[@]} > 0)); then
  if grep -n -F -H -e "$health" "${scan[@]}" > /tmp/commona-fake-health.txt; then
    cat /tmp/commona-fake-health.txt >&2
    echo "health number leaked outside fixtures/, test/, and tests/" >&2
    fail=1
  fi
  if grep -n -F -i -H -e "$name" "${scan[@]}" > /tmp/commona-fake-name.txt; then
    cat /tmp/commona-fake-name.txt >&2
    echo "invented patient name leaked outside fixtures/, test/, and tests/" >&2
    fail=1
  fi
fi

if ((fail)); then
  exit 1
fi
echo "fake-data check ok"
