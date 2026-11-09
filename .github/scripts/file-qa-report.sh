#!/usr/bin/env bash
# Copy report.md into the commona-dev checkout at ./dev and push it once.
# Retry a non-fast-forward push one time. KIND selects the filename and is
# never taken from the review text.
set -euo pipefail

case "${PR}" in
  ''|*[!0-9]*) printf '%s\n' "PR number is not an integer" >&2; exit 1 ;;
esac
case "${KIND}" in
  codex) stem="pr-${PR}-round" ;;
  claude) stem="pr-${PR}-claude-round" ;;
  copilot) stem="pr-${PR}-copilot-round" ;;
  *) printf '%s\n' "refusing review kind" >&2; exit 1 ;;
esac
case "${BODY_FILE}" in
  ''|*[!A-Za-z0-9._/-]*|*..*) printf '%s\n' "refusing body path" >&2; exit 1 ;;
esac
[ -f "${BODY_FILE}" ] || { printf '%s\n' "body file is missing" >&2; exit 1; }
body_path="$(pwd)/${BODY_FILE}"

cd dev
mkdir -p development/qa-reports
N=0
for f in development/qa-reports/"${stem}"-*.md; do
  [ -e "${f}" ] || continue
  base=$(basename -- "${f}")
  prefix="${stem}-"
  round="${base#"${prefix}"}"
  round="${round%.md}"
  case "${round}" in
    ''|*[!0-9]*) continue ;;
  esac
  N=$((N + 1))
done
R=$((N + 1))
if [ "${R}" -gt 100 ]; then
  printf '%s\n' "round number is out of range" >&2
  exit 1
fi
while [ -e "development/qa-reports/${stem}-${R}.md" ]; do
  R=$((R + 1))
  if [ "${R}" -gt 100 ]; then
    printf '%s\n' "round number is out of range" >&2
    exit 1
  fi
done
case "${R}" in
  ''|*[!0-9]*) printf '%s\n' "round is not an integer" >&2; exit 1 ;;
esac
dest="development/qa-reports/${stem}-${R}.md"
case "${dest}" in
  development/qa-reports/pr-[0-9]*-round-[0-9]*.md) ;;
  development/qa-reports/pr-[0-9]*-claude-round-[0-9]*.md) ;;
  development/qa-reports/pr-[0-9]*-copilot-round-[0-9]*.md) ;;
  *) printf '%s\n' "refusing report path" >&2; exit 1 ;;
esac
cp -- "${body_path}" "${dest}"
git config user.name "codex-qa-bot"
git config user.email "codex-qa-bot@users.noreply.github.com"
git add -- "${dest}"
git commit -m "qa(pr-${PR}): ${KIND} round ${R} report"
branch=$(git branch --show-current)
case "${branch}" in
  ''|*[!A-Za-z0-9._/-]*) printf '%s\n' "refusing branch name" >&2; exit 1 ;;
esac
set +e
push_out=$(git push origin "HEAD:${branch}" 2>&1)
push_status=$?
set -e
printf '%s\n' "${push_out}"
if [ "${push_status}" -ne 0 ]; then
  case "${push_out}" in
    *non-fast-forward*|*fetch\ first*|*remote\ contains\ work\ that\ you\ do*)
      printf '%s\n' "push conflict; retrying once" >&2
      git fetch origin "${branch}"
      git rebase "origin/${branch}"
      git push origin "HEAD:${branch}"
      ;;
    *)
      printf '%s\n' "push failed" >&2
      exit "${push_status}"
      ;;
  esac
fi
