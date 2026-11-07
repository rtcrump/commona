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
COMPONENTS = "room|wake|sharing|nameblock|audit|loop|data|ci|docs|tracking|m1|release|readme|demo"
SUBJECT_RE = re.compile(rf"^({TYPES})\(({COMPONENTS})\): \S.*$")
TRAILER_RE = re.compile(r"^([A-Za-z][A-Za-z-]*): (.+)$")
ALLOWED = {"Authored-by-agent", "Model", "Authored-by", "QA", "Approved-by", "Co-authored-by", "Refs"}
AGENT_RE = re.compile(
    r"^(cursor/[A-Za-z0-9._-]+|grok/[A-Za-z0-9._-]+|community/[A-Za-z0-9-]+/[A-Za-z0-9._-]+)$"
)
HUMAN_RE = re.compile(r"^human/[A-Za-z0-9._-]+$")
QA_RE = re.compile(r"^chatgpt round [123] (pass|fail)$")
BOT_EMAILS = {"commona-bot@users.noreply.github.com"}  # [Assumed] real bot identity set at G2
# Subject prefixes are a fallback for a streamed message, which has no parent
# graph. Git history uses the parent count instead: two or more parents is a merge.
MERGE_PREFIXES = ("Merge pull request #", "Merge branch ", "Merge PR #")
LANDING_PREFIXES = ("Merge pull request #", "Merge PR #")
# Main mode accepts every commit reachable from this tip. m1-integration
# was here when landing trailers moved onto the merge commit. The set
# includes squash d376da6 (PR #63), which has neither QA nor Approved-by.
MAIN_GRANDFATHER_TIP = "4bbbbe494f288a9eb7e41038cce846da215b0b9b"
GRANDFATHERED_SQUASH = "d376da6a263f2d3bb064d889c540b336d949e8ea"
CRITICAL = ("src/sharing/", "src/guard/", "src/audit/", "src/auth/", "src/room/membership")
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


def main_trailer_gaps(keys):
    """Missing landing trailers. `fail` is not enough on the commit that lands."""
    errs = []
    qa = keys.get("QA", [None])[0]
    if not qa or not QA_RE.match(qa) or not qa.endswith(" pass"):
        errs.append("commit on main needs 'QA: chatgpt round <n> pass'")
    if keys.get("Approved-by", [None])[0] != "trafford":
        errs.append("commit on main needs 'Approved-by: trafford'")
    return errs


def main_landing_errors(msg):
    """Trailer rules for a merge commit that lands a PR. No subject or authorship rule."""
    errs = []
    tr, bad = trailers(msg)
    errs += [f"malformed trailer line: {b!r}" for b in bad]
    keys = {}
    for k, v in tr:
        if k not in ALLOWED:
            errs.append(f"unknown trailer key: {k!r}")
        keys.setdefault(k, []).append(v)
    for k in ("QA", "Approved-by"):
        if len(keys.get(k, [])) > 1:
            errs.append(f"trailer {k} appears more than once")
    return errs + main_trailer_gaps(keys)


def _commit_is_merge(subject, parents):
    """A merge has two or more parents. The subject is not what makes it one.

    `parents` is None only for a streamed message. Then the subject prefixes
    are the only signal, and `Merge branch` stays a sync merge.
    """
    if parents is not None:
        return parents >= 2
    return subject.startswith(MERGE_PREFIXES)


def _merge_lands(subject, parents, on_first_parent):
    """True when this merge is the commit that landed on main.

    With a parent count, that is the first-parent line only. An inner
    `Merge pull request` or `Merge PR` does not land. When the line is
    unknown, do not exempt the merge. A stream has no parent count, so a
    landing-prefix subject is treated as the landing merge.
    """
    if parents is not None:
        if on_first_parent is None:
            return True
        return on_first_parent
    return subject.startswith(LANDING_PREFIXES)


def check_commit(email, msg, mode, *, grandfathered=False, landing=False, parents=None, on_first_parent=None):
    """`landing` is a non-merge that landed on main.

    That is a first-parent squash or direct push, or any non-merge record in
    a main-mode stream (the stream has no parent graph). A merge needs the
    QA and Approved-by trailers only when it is that landing commit. Agent
    commits inside the PR do not. Commits grandfathered from
    MAIN_GRANDFATHER_TIP, including GRANDFATHERED_SQUASH, are accepted.
    """
    if mode == "main" and grandfathered:
        return []
    errs = []
    subject = msg.split("\n", 1)[0]
    if _commit_is_merge(subject, parents):
        if mode == "main" and _merge_lands(subject, parents, on_first_parent):
            errs.extend(main_landing_errors(msg))
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
    if mode == "main" and landing:
        errs.extend(main_trailer_gaps(keys))
    return errs


def grandfathered_shas():
    """Commits main mode accepts as already landed. Empty outside this repo."""
    probe = subprocess.run(["git", "cat-file", "-e", MAIN_GRANDFATHER_TIP], capture_output=True)
    if probe.returncode != 0:
        return set()
    out = subprocess.run(
        ["git", "rev-list", MAIN_GRANDFATHER_TIP], capture_output=True, text=True, check=True
    ).stdout
    return set(out.split())


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
    """Check a stream. It has no parent graph, so topology cannot be read.

    In main mode each non-merge record is a landing commit. A squash or
    direct push without QA and Approved-by fails, which is what this entry
    point did before landing trailers moved onto the merge. Merge subjects
    still follow the message fallback inside check_commit.
    """
    failed = human_any = False
    landing = mode == "main"
    for i, (email, msg) in enumerate(commits):
        if re.search(r"^Authored-by: human/", msg, re.M):
            human_any = True
        for e in check_commit(email, msg, mode, landing=landing):
            failed = True
            first = msg.splitlines()[0] if msg else ""
            print(f"commit {i+1} ({first}): {e}")
    return failed, human_any


def _git_records(base, head):
    cmd = ["git", "log", "--format=%x1e%H%n%P%n%ae%n%B", f"{base}..{head}"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    records = []
    for chunk in out.split("\x1e"):
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        parts = chunk.split("\n", 3)
        sha = parts[0].strip()
        parent_line = parts[1].strip() if len(parts) > 1 else ""
        email = parts[2].strip() if len(parts) > 2 else ""
        msg = parts[3] if len(parts) > 3 else ""
        parents = len(parent_line.split()) if parent_line else 0
        records.append((sha, email, msg, parents))
    return records


def run_git(base, head, mode):
    """Main mode uses the first-parent line to see what landed.

    A merge is a commit with two or more parents, not a subject prefix.
    One on the first-parent line needs QA and Approved-by. So does a
    non-merge on that line (a squash, or a commit pushed straight on).
    Commits that arrived only as the other parent, including an inner
    `Merge pull request` or `Merge PR`, do not need those trailers.
    Grandfathered commits are not re-checked.
    """
    records = _git_records(base, head)
    first = set()
    grand = set()
    if mode == "main":
        listed = subprocess.run(
            ["git", "rev-list", "--first-parent", f"{base}..{head}"],
            capture_output=True, text=True, check=True,
        ).stdout
        first = set(listed.split())
        grand = grandfathered_shas()
    failed = human_any = False
    for i, (sha, email, msg, parents) in enumerate(records):
        if re.search(r"^Authored-by: human/", msg, re.M):
            human_any = True
        subject = msg.split("\n", 1)[0]
        on_first = sha in first if mode == "main" else None
        landing = on_first is True and parents < 2
        for e in check_commit(
            email, msg, mode,
            grandfathered=sha in grand,
            landing=landing,
            parents=parents,
            on_first_parent=on_first,
        ):
            failed = True
            print(f"commit {i+1} ({subject}): {e}")
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
        failed, human = run_git(a.base, a.head, a.mode)
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
