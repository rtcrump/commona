#!/usr/bin/env python3
"""Print codex or copilot when REVIEWER is an exact allowed login.

COPILOT_LOGINS is a JSON array of strings. When it is empty, the default is
copilot-pull-request-reviewer[bot]. Confirm that login from the first real
Copilot review before treating it as final.
"""
import json
import os
import sys

CODEX_LOGIN = "chatgpt-codex-connector[bot]"
DEFAULT_COPILOT = ["copilot-pull-request-reviewer[bot]"]


def main():
    reviewer = os.environ.get("REVIEWER", "")
    if reviewer.strip() == "" or any(char in reviewer for char in "\r\n\0"):
        print("refusing reviewer login", file=sys.stderr)
        return 1
    if reviewer == CODEX_LOGIN:
        print("codex")
        return 0
    raw = os.environ.get("COPILOT_LOGINS", "").strip()
    if not raw:
        logins = DEFAULT_COPILOT
    else:
        try:
            logins = json.loads(raw)
        except json.JSONDecodeError:
            print("COPILOT_REVIEWER_LOGINS must be a JSON array of logins", file=sys.stderr)
            return 2
        if not isinstance(logins, list) or not all(isinstance(item, str) for item in logins):
            print("COPILOT_REVIEWER_LOGINS must be a JSON array of strings", file=sys.stderr)
            return 2
    if any(reviewer == login for login in logins):
        print("copilot")
        return 0
    print("reviewer is not Codex or Copilot", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
