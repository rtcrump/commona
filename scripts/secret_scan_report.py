#!/usr/bin/env python3
"""Print a gitleaks JSON report without secret values."""
import json
import re
import sys

RULE_RE = re.compile(r"[a-z0-9-]{1,80}")
FILE_RE = re.compile(r"[A-Za-z0-9_./-]{1,180}")
COMMIT_RE = re.compile(r"[0-9a-f]{40}")


def field(value, pattern, fallback):
    text = value if isinstance(value, str) else ""
    if pattern.fullmatch(text):
        return text
    return fallback


def main(argv):
    if len(argv) != 2:
        print("secret scan report needs a file and a mode", file=sys.stderr)
        return 2
    path, mode = argv
    if mode not in {"history", "tree"}:
        print("secret scan report mode is unexpected", file=sys.stderr)
        return 2
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError):
        print(f"secret scan {mode}: report could not be read", file=sys.stderr)
        return 1
    if not isinstance(data, list):
        print(f"secret scan {mode}: report could not be read", file=sys.stderr)
        return 1
    if not data:
        print(f"secret scan {mode}: no findings")
        return 0
    for item in data:
        if not isinstance(item, dict):
            print(f"secret scan finding mode={mode} rule=unknown file=redacted-path line=0 commit=none")
            continue
        rule = field(item.get("RuleID"), RULE_RE, "unknown")
        file_name = field(item.get("File"), FILE_RE, "redacted-path")
        if ".." in file_name.split("/"):
            file_name = "redacted-path"
        line = item.get("StartLine")
        if not isinstance(line, int) or isinstance(line, bool) or line < 0 or line > 1000000:
            line = 0
        commit = field(item.get("Commit"), COMMIT_RE, "none")
        print(
            f"secret scan finding mode={mode} rule={rule} file={file_name} line={line} commit={commit}"
        )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
