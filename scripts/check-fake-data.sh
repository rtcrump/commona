#!/usr/bin/env bash
# Fail when the invented health number, or any fixtures/names.txt entry,
# shows up outside fixtures/, test/, and tests/. The acceptance harness
# quotes the M1 truth set, so tests/ is allowed to contain those markers.
# The health number is assembled at runtime so this script does not
# contain the literal.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f fixtures/names.txt ]]; then
  echo "fixtures/names.txt is missing" >&2
  exit 1
fi

health="$(printf '%s-%s' '12345' '6789')"

mapfile -t names < <(grep -v '^[[:space:]]*$' fixtures/names.txt | grep -v '^[[:space:]]*#')
if ((${#names[@]} == 0)); then
  echo "fixtures/names.txt has no names" >&2
  exit 1
fi

mapfile -t files < <(git ls-files --cached --others --exclude-standard)

scan=()
fail=0
for f in "${files[@]}"; do
  case "$f" in
    fixtures/*|test/*|tests/*) continue ;;
  esac
  scan+=("$f")
  lowpath="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
  lowhealth="$(printf '%s' "$health" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lowpath" == *"$lowhealth"* ]]; then
    echo "health number leaked into path: $f" >&2
    fail=1
  fi
  for name in "${names[@]}"; do
    needle="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    if [[ "$lowpath" == *"$needle"* ]]; then
      echo "name leaked into path: $f" >&2
      fail=1
    fi
  done
done

if ((${#scan[@]} > 0)); then
  if grep -n -F -H -e "$health" "${scan[@]}" > /tmp/commona-fake-health.txt; then
    cat /tmp/commona-fake-health.txt >&2
    echo "health number leaked outside fixtures/, test/, and tests/" >&2
    fail=1
  fi
  for name in "${names[@]}"; do
    if grep -n -F -i -H -e "$name" "${scan[@]}" > /tmp/commona-fake-name.txt; then
      cat /tmp/commona-fake-name.txt >&2
      echo "name list entry leaked outside fixtures/, test/, and tests/" >&2
      fail=1
    fi
  done
fi

if ((fail)); then
  exit 1
fi
echo "fake-data check ok"
