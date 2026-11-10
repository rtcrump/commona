#!/usr/bin/env bash
# Build report.md from environment variables and a body file.
# Event text is data: this script never evals it, and it writes with printf '%s'.
set -euo pipefail

case "${PR}" in
  ''|*[!0-9]*) printf '%s\n' "PR number is not an integer" >&2; exit 1 ;;
esac
case "${RID}" in
  ''|*[!0-9]*) printf '%s\n' "review id is not an integer" >&2; exit 1 ;;
esac
case "${KIND}" in
  codex) heading="Codex QA" ;;
  copilot) heading="Copilot QA" ;;
  claude) heading="Claude safety review" ;;
  *) printf '%s\n' "refusing review kind" >&2; exit 1 ;;
esac
case "${STATUS}" in
  blocking|advisory) ;;
  *) printf '%s\n' "refusing status" >&2; exit 1 ;;
esac
case "${BODY_FILE}" in
  ''|*[!A-Za-z0-9._/-]*|*..*) printf '%s\n' "refusing body path" >&2; exit 1 ;;
esac
[ -f "${BODY_FILE}" ] || { printf '%s\n' "body file is missing" >&2; exit 1; }
if [ -n "${FINDINGS_FILE:-}" ]; then
  case "${FINDINGS_FILE}" in
    *[!A-Za-z0-9._/-]*|*..*) printf '%s\n' "refusing findings path" >&2; exit 1 ;;
  esac
  [ -f "${FINDINGS_FILE}" ] || { printf '%s\n' "findings file is missing" >&2; exit 1; }
fi

{
  printf '# %s – PR #%s – review %s\n' "${heading}" "${PR}" "${RID}"
  printf 'Reviewer: %s\n' "${REVIEWER}"
  printf 'Title: %s\n' "${TITLE}"
  printf 'Head: %s\n' "${HEAD_REF}"
  printf 'Base: %s\n' "${BASE_REF}"
  printf 'Commit: %s\n' "${COMMIT_ID}"
  printf 'Link: %s\n' "${HTML_URL}"
  printf 'Status: %s\n' "${STATUS}"
  if [ "${STATUS}" = "advisory" ]; then
    printf '%s\n' "This review is advisory. It does not decide whether the pull request passes."
  fi
  printf '\n'
  sed 's/^/> /' -- "${BODY_FILE}"
  printf '\n## Findings\n'
  if [ -n "${FINDINGS_FILE:-}" ]; then
    cat -- "${FINDINGS_FILE}"
  fi
} > report.md
