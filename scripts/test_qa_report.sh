#!/usr/bin/env bash
# Local checks for the QA workflows. No network and no review text is executed.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "${root}"
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

python3 - <<'PY'
import json, os, subprocess, sys, tempfile, pathlib
root = pathlib.Path(".").resolve()
gate = root / ".github/scripts/safety_core_gate.py"
kind = root / ".github/scripts/reviewer_kind.py"
paths = root / ".github/safety-core-paths.txt"

def run_gate(files, labels):
    with tempfile.NamedTemporaryFile("w", delete=False) as handle:
        handle.write("\n".join(files) + ("\n" if files else ""))
        name = handle.name
    env = os.environ.copy()
    env["LABELS_JSON"] = json.dumps(labels)
    out = subprocess.run([sys.executable, str(gate), "--files", name, "--paths", str(paths)],
                         check=True, capture_output=True, text=True, env=env)
    os.unlink(name)
    return out.stdout.strip()

hits = [
    "src/guard/index.ts",
    "src/nameblock/index.ts",
    "src/sharing/index.ts",
    "src/audit/log.ts",
    "src/auth/store.ts",
    "src/room/access.ts",
    "src/room/membership.ts",
    "src/room/routes.ts",
    "src/room/sharing.ts",
    "src/app.ts",
    "src/runtime.ts",
    "contract/auth.ts",
]
for path in hits:
    if run_gate([path], []) != "true":
        sys.exit(f"expected safety-core: {path}")
misses = ["src/wakeup/service.ts", "src/room/posts.ts", "src/guard", "README.md", "AGENTS.md"]
for path in misses:
    if run_gate([path], []) != "false":
        sys.exit(f"expected outside safety-core: {path}")
if run_gate(["README.md"], ["critical-core"]) != "true":
    sys.exit("critical-core label alone should review")
if run_gate(["README.md"], ["critical-core-extra", "agent:cursor"]) != "false":
    sys.exit("a lookalike label should not review")
if run_gate([], []) != "false":
    sys.exit("empty pull request should not review")

def run_kind(reviewer, logins=None):
    env = os.environ.copy()
    env["REVIEWER"] = reviewer
    if logins is None:
        env.pop("COPILOT_LOGINS", None)
    else:
        env["COPILOT_LOGINS"] = logins
    return subprocess.run([sys.executable, str(kind)], capture_output=True, text=True, env=env)

codex = run_kind("chatgpt-codex-connector[bot]")
if codex.returncode != 0 or codex.stdout.strip() != "codex":
    sys.exit(f"codex login: {codex.returncode} {codex.stdout!r} {codex.stderr!r}")
if run_kind("chatgpt-codex-connector").returncode == 0:
    sys.exit("codex prefix matched")
copilot = run_kind("copilot-pull-request-reviewer[bot]")
if copilot.returncode != 0 or copilot.stdout.strip() != "copilot":
    sys.exit(f"copilot login: {copilot.returncode} {copilot.stdout!r}")
if run_kind("copilot-pull-request-reviewer").returncode == 0:
    sys.exit("copilot login without [bot] matched")
if run_kind("copilot-pull-request-reviewer[bot]-extra").returncode == 0:
    sys.exit("copilot suffix matched")
custom = run_kind("second-bot", '["first-bot","second-bot"]')
if custom.returncode != 0 or custom.stdout.strip() != "copilot":
    sys.exit("custom copilot list did not exact-match")
hostile = run_kind("$(touch /tmp/pwned-login)")
if hostile.returncode == 0 or os.path.exists("/tmp/pwned-login"):
    sys.exit("hostile login was accepted or executed")
print("python gates: ok")
PY

rm -f /tmp/pwned-exec
body_py="${root}/.github/scripts/claude_review_body.py"
runner="$(mktemp -d)"
export RUNNER_TEMP="${runner}"
unset EXECUTION_FILE
got="$(python3 "${body_py}")"
case "${got}" in
  "Claude finished without a readable review in the execution log."*) ;;
  *) fail "missing execution log should fall back" ;;
esac
EXECUTION_FILE='$(touch /tmp/pwned-exec)' python3 "${body_py}" >/dev/null
[ ! -e /tmp/pwned-exec ] || fail "execution path was executed"
outside="$(mktemp)"
printf '%s\n' 'secret' > "${outside}"
ln -s "${outside}" "${runner}/claude-execution-output.json"
EXECUTION_FILE="${runner}/claude-execution-output.json" python3 "${body_py}" > "${runner}/symlink-out.txt"
grep -F 'Claude finished without a readable review' "${runner}/symlink-out.txt" >/dev/null || fail 'symlink escaped the runner temp'
rm -f "${runner}/claude-execution-output.json"
python3 - <<PY
import json, pathlib
path = pathlib.Path("${runner}") / "claude-execution-output.json"
path.write_text(json.dumps([
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "draft"}]}},
    {"type": "result", "result": "verdict: clean\n\$(touch /tmp/pwned-exec)"},
]))
PY
EXECUTION_FILE="${runner}/claude-execution-output.json" python3 "${body_py}" > "${runner}/body.txt"
grep -F 'verdict: clean' "${runner}/body.txt" >/dev/null || fail 'result text missing'
grep -F '$(touch /tmp/pwned-exec)' "${runner}/body.txt" >/dev/null || fail 'result text not literal'
[ ! -e /tmp/pwned-exec ] || fail 'result text executed'
python3 - <<PY
import json, pathlib
path = pathlib.Path("${runner}") / "claude-execution-output.json"
path.write_text(json.dumps([
    {"type": "assistant", "message": {"content": [{"type": "text", "text": "assistant only"}]}},
]))
PY
EXECUTION_FILE="${runner}/claude-execution-output.json" python3 "${body_py}" > "${runner}/assistant.txt"
grep -F 'assistant only' "${runner}/assistant.txt" >/dev/null || fail 'assistant text missing'
python3 - <<'PY'
from pathlib import Path
for line in Path(".github/workflows/claude-safety-review.yml").read_text().splitlines():
    stripped = line.strip()
    if stripped.startswith("#"):
        continue
    if "--json-schema" in line:
        raise SystemExit("claude workflow still passes a json schema")
PY
unset EXECUTION_FILE
unset RUNNER_TEMP
printf '%s\n' "claude review body: ok"

rm -f /tmp/pwned-title /tmp/pwned-body /tmp/pwned-login
work="$(mktemp -d)"
printf '%s' $'line one\n$(touch /tmp/pwned-body)\n`id`' > "${work}/review-body.txt"
printf '%s\n' '### src/app.ts:1' $'$(touch /tmp/pwned-body)' > "${work}/findings.txt"
(
  cd "${work}"
  PR=8 RID=99 KIND=copilot STATUS=advisory BODY_FILE=review-body.txt FINDINGS_FILE=findings.txt \
    REVIEWER='copilot-pull-request-reviewer[bot]' \
    TITLE='$(touch /tmp/pwned-title)' \
    HEAD_REF='feature; rm -rf /' \
    BASE_REF='main' \
    COMMIT_ID='abc$(id)%s' \
    HTML_URL='https://example.com/$(id)' \
    bash "${root}/.github/scripts/write-review-report.sh"
)
grep -F 'Status: advisory' "${work}/report.md" >/dev/null || fail 'advisory status'
grep -F 'This review is advisory' "${work}/report.md" >/dev/null || fail 'advisory note'
grep -F 'Title: $(touch /tmp/pwned-title)' "${work}/report.md" >/dev/null || fail 'title not literal'
grep -F 'Head: feature; rm -rf /' "${work}/report.md" >/dev/null || fail 'branch not literal'
grep -F '> $(touch /tmp/pwned-body)' "${work}/report.md" >/dev/null || fail 'body not quoted'
grep -F 'Commit: abc$(id)%s' "${work}/report.md" >/dev/null || fail 'commit not literal'
[ ! -e /tmp/pwned-title ] && [ ! -e /tmp/pwned-body ] || fail 'report text executed'
# blocking Codex report does not claim to be advisory
(
  cd "${work}"
  PR=8 RID=100 KIND=codex STATUS=blocking BODY_FILE=review-body.txt \
    REVIEWER='chatgpt-codex-connector[bot]' TITLE=t HEAD_REF=h BASE_REF=b COMMIT_ID=c HTML_URL=u \
    bash "${root}/.github/scripts/write-review-report.sh"
)
if grep -F 'This review is advisory' "${work}/report.md" >/dev/null; then
  fail 'codex report marked advisory'
fi
printf '%s\n' "report writer: ok"

# No ${{ }} inside a run script. Expressions belong in env:, if:, and with:.
python3 - <<'PY'
from pathlib import Path
bad = []
for path in Path(".github/workflows").glob("*.yml"):
    lines = path.read_text().splitlines()
    in_run = False
    for number, line in enumerate(lines, 1):
        stripped = line.rstrip()
        if stripped.endswith("run: |"):
            in_run = True
            continue
        if in_run:
            if line.startswith("          ") or line.strip() == "":
                if "${{" in line:
                    bad.append(f"{path}:{number}:{line}")
            else:
                in_run = False
if bad:
    raise SystemExit("expression inside run:\n" + "\n".join(bad))
print("run scripts have no expressions: ok")
PY

setup_pair() {
  local dir="$1"
  rm -rf "${dir}"
  mkdir -p "${dir}"
  git init -q --bare -b main "${dir}/origin.git"
  git clone -q "${dir}/origin.git" "${dir}/dev"
  git -C "${dir}/dev" config user.name seed
  git -C "${dir}/dev" config user.email seed@example.com
  git -C "${dir}/dev" config commit.gpgsign false
  echo seed > "${dir}/dev/README.md"
  git -C "${dir}/dev" add README.md
  git -C "${dir}/dev" commit -q -m seed
  git -C "${dir}/dev" push -q origin main
}

file_report() {
  local dir="$1" pr="$2" kind="$3"
  printf 'body-%s\n' "${kind}" > "${dir}/report.md"
  ( cd "${dir}" && PR="${pr}" KIND="${kind}" BODY_FILE=report.md bash "${root}/.github/scripts/file-qa-report.sh" )
}

dir="$(mktemp -d)"
setup_pair "${dir}/codex"
file_report "${dir}/codex" 8 codex >/tmp/qa-file-codex.out
git --git-dir="${dir}/codex/origin.git" cat-file -e HEAD:development/qa-reports/pr-8-round-1.md || fail 'codex round 1'
setup_pair "${dir}/claude"
file_report "${dir}/claude" 8 claude >/tmp/qa-file-claude.out
git --git-dir="${dir}/claude/origin.git" cat-file -e HEAD:development/qa-reports/pr-8-claude-round-1.md || fail 'claude round 1'
setup_pair "${dir}/copilot"
mkdir -p "${dir}/copilot/dev/development/qa-reports"
echo old > "${dir}/copilot/dev/development/qa-reports/pr-8-copilot-round-1.md"
git -C "${dir}/copilot/dev" add development
git -C "${dir}/copilot/dev" commit -q -m prior
git -C "${dir}/copilot/dev" push -q origin main
file_report "${dir}/copilot" 8 copilot >/tmp/qa-file-copilot.out
git --git-dir="${dir}/copilot/origin.git" cat-file -e HEAD:development/qa-reports/pr-8-copilot-round-2.md || fail 'copilot round 2'
# a codex file must not consume a copilot round, and a hostile name must not run
setup_pair "${dir}/mix"
mkdir -p "${dir}/mix/dev/development/qa-reports"
echo a > "${dir}/mix/dev/development/qa-reports/pr-4-round-1.md"
echo b > "${dir}/mix/dev/development/qa-reports/pr-4-claude-round-9.md"
python3 - <<PY
from pathlib import Path
Path("${dir}/mix/dev/development/qa-reports").joinpath("pr-4-round-\$(id).md").write_text("x\n")
PY
git -C "${dir}/mix/dev" add development && git -C "${dir}/mix/dev" commit -q -m prior && git -C "${dir}/mix/dev" push -q origin main
file_report "${dir}/mix" 4 claude >/tmp/qa-file-mix.out
# One numeric Claude report, so the next Claude round is 2. The Codex file and the hostile name stay out of that count.
git --git-dir="${dir}/mix/origin.git" cat-file -e HEAD:development/qa-reports/pr-4-claude-round-2.md || fail 'claude should be the next claude round'
git --git-dir="${dir}/mix/origin.git" cat-file -e HEAD:development/qa-reports/pr-4-claude-round-9.md || fail 'existing claude report was dropped'
printf '%s\n' "file report: ok"

# Conflict retry, then a non-conflict failure that must not retry.
setup_pair "${dir}/conflict"
git clone -q "${dir}/conflict/origin.git" "${dir}/conflict/other"
git -C "${dir}/conflict/other" config user.name other
git -C "${dir}/conflict/other" config user.email other@example.com
git -C "${dir}/conflict/other" config commit.gpgsign false
echo other > "${dir}/conflict/other/other.md"
git -C "${dir}/conflict/other" add other.md && git -C "${dir}/conflict/other" commit -q -m 'other report' && git -C "${dir}/conflict/other" push -q origin main
file_report "${dir}/conflict" 9 codex >/tmp/qa-conflict.out 2>/tmp/qa-conflict.err
grep -F 'push conflict; retrying once' /tmp/qa-conflict.err >/dev/null || fail 'no conflict retry'
git --git-dir="${dir}/conflict/origin.git" cat-file -e HEAD:development/qa-reports/pr-9-round-1.md || fail 'conflict push'
git --git-dir="${dir}/conflict/origin.git" log --format='%s' | grep -F 'other report' >/dev/null || fail 'rebase dropped the other commit'
setup_pair "${dir}/auth"
printf 'x\n' > "${dir}/auth/report.md"
git -C "${dir}/auth/dev" remote set-url origin "${dir}/missing.git"
set +e
( cd "${dir}/auth" && PR=3 KIND=codex BODY_FILE=report.md bash "${root}/.github/scripts/file-qa-report.sh" ) >/tmp/qa-auth.out 2>/tmp/qa-auth.err
status=$?
set -e
[ "${status}" -ne 0 ] || fail 'bad remote should fail'
grep -F 'push failed' /tmp/qa-auth.err >/dev/null || fail 'missing push failed message'
if grep -F 'retrying once' /tmp/qa-auth.err; then fail 'retried a non-conflict'; fi
printf '%s\n' "push retry: ok"
printf '%s\n' ALL_OK
