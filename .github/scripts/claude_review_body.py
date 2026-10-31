#!/usr/bin/env python3
"""Print Claude's review text, or a fixed fallback.

The execution log is data. This script never executes it. The path must be
RUNNER_TEMP/claude-execution-output.json after resolving symlinks.
"""

import json
import os
import pathlib
import sys

FALLBACK = (
    "Claude finished without a readable review in the execution log. "
    "The pull request comment is the review.\n"
)
NAME = "claude-execution-output.json"
MAX_CHARS = 100_000


def fallback() -> None:
    sys.stdout.write(FALLBACK)
    raise SystemExit(0)


def text_from(data: object) -> str | None:
    if not isinstance(data, list):
        return None
    result_text = None
    assistant_text = None
    for event in data:
        if not isinstance(event, dict):
            continue
        if event.get("type") == "result" and isinstance(event.get("result"), str):
            if event["result"].strip():
                result_text = event["result"]
        if event.get("type") != "assistant":
            continue
        message = event.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        parts: list[str] = []
        if isinstance(content, list):
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and isinstance(block.get("text"), str)
                ):
                    parts.append(block["text"])
        elif isinstance(content, str) and content.strip():
            parts.append(content)
        if parts:
            assistant_text = "\n".join(parts)
    chosen = result_text or assistant_text
    if not chosen or not chosen.strip():
        return None
    if len(chosen) > MAX_CHARS:
        chosen = chosen[:MAX_CHARS] + "\n[truncated]\n"
    if not chosen.endswith("\n"):
        chosen += "\n"
    return chosen


def main() -> None:
    raw = os.environ.get("EXECUTION_FILE", "")
    root = os.environ.get("RUNNER_TEMP", "")
    if not raw or not root or any(char in raw for char in "\n\r\x00"):
        fallback()
    try:
        root_path = pathlib.Path(root).resolve()
        path = pathlib.Path(raw).resolve()
    except (OSError, RuntimeError):
        fallback()
    if path.name != NAME:
        fallback()
    try:
        path.relative_to(root_path)
    except ValueError:
        fallback()
    if not path.is_file():
        fallback()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fallback()
    text = text_from(data)
    if text is None:
        fallback()
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
