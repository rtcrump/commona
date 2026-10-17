#!/usr/bin/env python3
"""Commona conventions check. Stdlib only.

Usage:
  check_conventions.py commits --mode pr|main  < stream   (records separated by '\\x1e'; each: author email line, then message)
  check_conventions.py labels --labels "a,b" --files files.txt --human-commits 0|1 [--mode pr|merge]
  check_conventions.py git --base <sha> --head <sha> --mode pr|main [--human-out f]
Exit 0 = pass, 1 = violations (printed), 2 = usage error.
"""
import argparse, re, subprocess, sys

TYPES = "feat|fix|test|docs|chore|ci|refactor"
COMPONENTS = "room|wake|sharing|audit|loop|data|ci|docs|tracking|m1|release|readme|demo"
SUBJECT_RE = re.compile(rf"^({TYPES})\(({COMPONENTS})\): \S.*$")
TRAILER_RE = re.compile(r"^([A-Za-z][A-Za-z-]*): (.+)$")
ALLOWED = {"Authored-by-agent", "Model", "Authored-by", "QA", "Approved-by", "Co-authored-by", "Refs"}
AGENT_RE = re.compile(
    r"^(cursor/[A-Za-z0-9._-]+|grok/[A-Za-z0-9._-]+|community/[A-Za-z0-9-]+/[A-Za-z0-9._-]+)$"
)
HUMAN_RE = re.compile(r"^human/[A-Za-z0-9._-]+$")
QA_RE = re.compile(r"^chatgpt round [123] (pass|fail)$")
BOT_EMAILS = {"commona-bot@users.noreply.github.com"}  # [Assumed] real bot identity set at G2
CRITICAL = ("src/sharing/", "src/audit/", "src/auth/", "src/room/membership")
AUTHOR_LABELS = {"agent:cursor", "agent:community", "agent:grok-build", "human-edit"}
QA_LABELS = {"qa-round-1", "qa-round-2", "qa-round-3"}
KNOWN_LABELS = AUTHOR_LABELS | QA_LABELS | {"agent:chatgpt-qa", "critical-core"}


def _paragraphs(msg):
    paras, cur = [], []
    for line in msg.rstrip("\n").split("\n"):
        if not line.strip():
            if cur:
                paras.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        paras.append(cur)
    return paras


def _parse_lines(block):
    parsed, bad = [], []
    for line in block:
        m = TRAILER_RE.match(line)
        if m:
            parsed.append((m.group(1), m.group(2).strip()))
        else:
            bad.append(line)
    return parsed, bad


def _pure_allowed(block):
    """True when every line is an allowed trailer key. Used for paragraphs above the last one."""
    if not block:
        return False
    for line in block:
        m = TRAILER_RE.match(line)
        if not m or m.group(1) not in ALLOWED:
            return False
    return True


def trailers(msg):
    """Return (parsed trailers, malformed lines).

    Start at the last paragraph. Keep walking backward through earlier
    paragraphs while every line is an allowed trailer, so a blank line
    between trailers (commit 70da75f) still counts as one block. Stop at
    body text and at the subject line. A subject-only message, or one
    whose last paragraph is body text, returns no trailers.
    """
    paras = _paragraphs(msg)
    if len(paras) <= 1:  # subject only, or empty
        return [], []
    parsed, bad = _parse_lines(paras[-1])
    if not parsed:
        return [], []  # last paragraph is ordinary body text
    earlier = []
    for para in reversed(paras[1:-1]):
        if not _pure_allowed(para):
            break
        parsed_earlier, _ = _parse_lines(para)
        earlier = parsed_earlier + earlier
    return earlier + parsed, bad


def check_commit(email, msg, mode):
    errs = []
    subject = msg.split("\n", 1)[0]
    if subject.startswith(("Merge pull request #", "Merge branch ")):
        return errs
    if len(subject) > 72:
        errs.append(f"subject longer than 72 chars: {subject!r}")
    if not SUBJECT_RE.match(subject):
        errs.append(f"subject must be '<type>(<component>): summary': {subject!r}")
    tr, bad = trailers(msg)
    errs += [f"malformed trailer line: {b!r}" for b in bad]
    keys = {}
    for k, v in tr:
        if k not in ALLOWED:
            errs.append(f"unknown trailer key: {k!r}")
        keys.setdefault(k, []).append(v)
    for k in ("Authored-by-agent", "Model", "Authored-by", "QA", "Approved-by"):
        if len(keys.get(k, [])) > 1:
            errs.append(f"trailer {k} appears more than once")
    agent = keys.get("Authored-by-agent", [None])[0]
    human = keys.get("Authored-by", [None])[0]
    if agent and human:
        errs.append("commit has both Authored-by-agent and Authored-by (pick one)")
    elif not agent and not human:
        errs.append("missing authorship trailer (Authored-by-agent + Model, or Authored-by: human/<name>)")
    if agent:
        if not AGENT_RE.match(agent):
            errs.append(f"bad Authored-by-agent value: {agent!r}")
        if not keys.get("Model"):
            errs.append("Authored-by-agent requires a Model trailer")
    if human:
        if not HUMAN_RE.match(human):
            errs.append(f"bad Authored-by value (want human/<name>): {human!r}")
        if email.lower() in BOT_EMAILS:
            errs.append("bot identity committed with a human authorship trailer")
    qa = keys.get("QA", [None])[0]
    if qa and not QA_RE.match(qa):
        errs.append(f"bad QA value: {qa!r}")
    appr = keys.get("Approved-by", [None])[0]
    if appr and appr != "trafford":
        errs.append(f"Approved-by must be 'trafford': {appr!r}")
    if mode == "main":
        if not qa or not qa.endswith(" pass"):
            errs.append("commit on main needs 'QA: chatgpt round <n> pass'")
        if appr != "trafford":
            errs.append("commit on main needs 'Approved-by: trafford'")
    return errs


def parse_commit_stream(text):
    out = []
    for chunk in text.split("\x1e"):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        email, _, msg = chunk.partition("\n")
        out.append((email.strip(), msg))
    return out


def run_commits(commits, mode):
    failed = human_any = False
    for i, (email, msg) in enumerate(commits):
        if re.search(r"^Authored-by: human/", msg, re.M):
            human_any = True
        for e in check_commit(email, msg, mode):
            failed = True
            first = msg.splitlines()[0] if msg else ""
            print(f"commit {i+1} ({first}): {e}")
    return failed, human_any


def check_labels(labels, files, human_commits, mode):
    errs = []
    labels = {l.strip() for l in labels if l.strip()}
    for l in sorted(labels):
        if l not in KNOWN_LABELS and (l.startswith("agent:") or l.startswith("qa-round")):
            errs.append(f"unknown label {l!r}")
    if not labels & AUTHOR_LABELS:
        errs.append("needs an author label: agent:cursor, agent:community, agent:grok-build or human-edit")
    if {"agent:cursor", "agent:community"} <= labels:
        errs.append("agent:cursor and agent:community are mutually exclusive")
    if {"agent:cursor", "agent:grok-build"} <= labels:
        errs.append("agent:cursor and agent:grok-build are mutually exclusive")
    if {"agent:community", "agent:grok-build"} <= labels:
        errs.append("agent:community and agent:grok-build are mutually exclusive")
    if human_commits and "human-edit" not in labels:
        errs.append("a commit has Authored-by: human/... so label human-edit is required")
    if not human_commits and "human-edit" in labels:
        errs.append("label human-edit set but no commit has Authored-by: human/...")
    touches = [f for f in files if f.startswith(CRITICAL)]
    if touches and "critical-core" not in labels:
        errs.append(f"touches critical core ({touches[0]}) so label critical-core is required (G3)")
    rounds = sorted(labels & QA_LABELS)
    if len(rounds) > 1:
        errs.append(f"only one qa-round label allowed, found {rounds}")
    if mode == "merge":
        if not rounds:
            errs.append("merge needs a qa-round-N label")
        if "agent:chatgpt-qa" not in labels:
            errs.append("merge needs agent:chatgpt-qa (QA report posted)")
    return errs


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("commits"); c.add_argument("--mode", choices=["pr", "main"], default="pr")
    l = sub.add_parser("labels")
    l.add_argument("--labels", default=""); l.add_argument("--files", required=True)
    l.add_argument("--human-commits", type=int, default=0)
    l.add_argument("--mode", choices=["pr", "merge"], default="pr")
    g = sub.add_parser("git")
    g.add_argument("--base", required=True); g.add_argument("--head", required=True)
    g.add_argument("--mode", choices=["pr", "main"], default="pr")
    g.add_argument("--human-out")
    a = p.parse_args(argv)
    if a.cmd == "commits":
        failed, _ = run_commits(parse_commit_stream(sys.stdin.read()), a.mode)
    elif a.cmd == "git":
        out = subprocess.run(["git", "log", "--format=%x1e%ae%n%B", f"{a.base}..{a.head}"],
                             capture_output=True, text=True, check=True).stdout
        failed, human = run_commits(parse_commit_stream(out), a.mode)
        if a.human_out:
            with open(a.human_out, "w") as f:
                f.write("1" if human else "0")
    else:
        with open(a.files) as f:
            files = [x for x in f.read().splitlines() if x.strip()]
        errs = check_labels(a.labels.split(","), files, a.human_commits, a.mode)
        for e in errs:
            print(f"labels: {e}")
        failed = bool(errs)
    print("FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
