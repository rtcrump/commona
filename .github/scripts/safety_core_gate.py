#!/usr/bin/env python3
"""Print true when changed files hit safety-core, or the critical-core label is set.

Labels arrive as a JSON array in LABELS_JSON. Filenames arrive as a file, one per line.
Neither is evaluated as code.
"""
import argparse
import json
import os
import sys


def patterns(path):
    found = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.split("#", 1)[0].strip()
            if line:
                found.append(line)
    return found


def matches(filename, rules):
    for rule in rules:
        if rule.endswith("/"):
            if filename.startswith(rule):
                return True
        elif filename == rule:
            return True
    return False


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", required=True)
    parser.add_argument("--paths", required=True)
    args = parser.parse_args(argv)
    raw = os.environ.get("LABELS_JSON", "[]")
    try:
        labels = json.loads(raw)
    except json.JSONDecodeError:
        print("LABELS_JSON is not JSON", file=sys.stderr)
        return 2
    if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
        print("LABELS_JSON must be a JSON array of strings", file=sys.stderr)
        return 2
    if any(label == "critical-core" for label in labels):
        print("true")
        return 0
    rules = patterns(args.paths)
    with open(args.files, encoding="utf-8") as handle:
        names = [line.rstrip("\n") for line in handle if line.strip()]
    print("true" if any(matches(name, rules) for name in names) else "false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
