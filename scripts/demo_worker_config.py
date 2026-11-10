#!/usr/bin/env python3
"""Check the public demo Worker config, and render a deploy copy.

The committed file keeps the placeholder hostname and account id.
`render` writes a temporary file for the manual production workflow.
It prints neither the account id nor the rendered file.
"""
import argparse
import ipaddress
import json
import os
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit

PLACEHOLDER_ACCOUNT = "0" * 32
PLACEHOLDER_ORIGIN = "https://example.invalid"
PLACEHOLDER_HOST = "example.invalid"
TOP_KEYS = {
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "account_id",
    "workers_dev",
    "preview_urls",
    "vars",
    "routes",
    "assets",
}
ASSET_KEYS = {
    "directory",
    "binding",
    "run_worker_first",
    "html_handling",
    "not_found_handling",
}
FORBIDDEN = (
    "DIRECTORY",
    "DirectoryObject",
    "durable_objects",
    "kv_namespaces",
    "r2_buckets",
    "d1_databases",
    "[[services]]",
    "workers.dev",
    "api_token",
    ".dev.vars",
)


class ConfigError(Exception):
    pass


def fail(message):
    raise ConfigError(message)


def load(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail("demo worker config is not utf-8")
    for token in FORBIDDEN:
        if token in text:
            fail("demo worker config binds private or unpublished data")
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        fail("demo worker config is not valid toml")
    extra = set(data) - TOP_KEYS
    if extra:
        fail("demo worker config has an unexpected setting")
    missing = TOP_KEYS - set(data)
    if missing:
        fail("demo worker config is missing a required setting")
    return data


def require_committed(data):
    if data["name"] != "commona-demo":
        fail("demo worker name must stay commona-demo")
    if data["main"] != "src/demo/worker.ts":
        fail("demo worker entry must stay src/demo/worker.ts")
    if data["compatibility_date"] != "2026-08-22":
        fail("demo worker compatibility date is unexpected")
    if data["compatibility_flags"] != ["nodejs_compat"]:
        fail("demo worker compatibility flags are unexpected")
    if data["account_id"] != PLACEHOLDER_ACCOUNT:
        fail("committed account id must stay the placeholder")
    if data["workers_dev"] is not False or data["preview_urls"] is not False:
        fail("demo worker must not publish a workers.dev hostname")
    if not isinstance(data["vars"], dict) or set(data["vars"]) != {"COMMONA_PUBLIC_ORIGIN"}:
        fail("committed public origin must stay the placeholder")
    if data["vars"]["COMMONA_PUBLIC_ORIGIN"] != PLACEHOLDER_ORIGIN:
        fail("committed public origin must stay the placeholder")
    routes = data["routes"]
    if not isinstance(routes, list) or len(routes) != 1 or not isinstance(routes[0], dict):
        fail("demo worker must have one custom-domain route")
    route = routes[0]
    if set(route) != {"pattern", "custom_domain"}:
        fail("demo worker route has an unexpected setting")
    if route["pattern"] != PLACEHOLDER_HOST or route["custom_domain"] is not True:
        fail("committed hostname must stay the placeholder")
    assets = data["assets"]
    if not isinstance(assets, dict) or set(assets) != ASSET_KEYS:
        fail("demo worker assets have an unexpected setting")
    if assets["directory"] != "./web/demo" or assets["binding"] != "ASSETS":
        fail("demo worker assets must serve ./web/demo")
    if assets["run_worker_first"] is not True:
        fail("demo worker must see each request before static files")
    if assets["html_handling"] != "auto-trailing-slash" or assets["not_found_handling"] != "none":
        fail("demo worker asset handling is unexpected")
    return data


def validate_account(value):
    if not isinstance(value, str) or len(value) != 32 or any(ch not in "0123456789abcdefABCDEF" for ch in value):
        fail("account id must be the 32-character id from the approved configuration")
    if value.lower() == PLACEHOLDER_ACCOUNT:
        fail("account id is still the placeholder")
    return value.lower()


def validate_origin(value):
    if not isinstance(value, str) or any(ch.isspace() for ch in value):
        fail("public origin must be an https hostname")
    parts = urlsplit(value)
    if parts.scheme != "https" or parts.username or parts.password or not parts.hostname:
        fail("public origin must be an https hostname")
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        fail("public origin must not include a path")
    host = parts.hostname.lower().rstrip(".")
    if host == PLACEHOLDER_HOST or host.endswith("." + PLACEHOLDER_HOST):
        fail("public origin is still the placeholder")
    if host == "workers.dev" or host.endswith(".workers.dev"):
        fail("public origin must not be a workers.dev hostname")
    if host == "localhost" or host.endswith(".localhost"):
        fail("public origin must be a public hostname")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        fail("public origin must be a hostname")
    if "." not in host or ".." in host:
        fail("public origin must be a hostname")
    return "https://" + host, host


def dump(data):
    flags = ", ".join(json.dumps(flag) for flag in data["compatibility_flags"])
    route = data["routes"][0]
    assets = data["assets"]
    lines = [
        f"name = {json.dumps(data['name'])}",
        f"main = {json.dumps(data['main'])}",
        f"compatibility_date = {json.dumps(data['compatibility_date'])}",
        f"compatibility_flags = [{flags}]",
        f"account_id = {json.dumps(data['account_id'])}",
        "workers_dev = false",
        "preview_urls = false",
        "",
        "[vars]",
        f"COMMONA_PUBLIC_ORIGIN = {json.dumps(data['vars']['COMMONA_PUBLIC_ORIGIN'])}",
        "",
        "[[routes]]",
        f"pattern = {json.dumps(route['pattern'])}",
        "custom_domain = true",
        "",
        "[assets]",
        f"directory = {json.dumps(assets['directory'])}",
        f"binding = {json.dumps(assets['binding'])}",
        "run_worker_first = true",
        f"html_handling = {json.dumps(assets['html_handling'])}",
        f"not_found_handling = {json.dumps(assets['not_found_handling'])}",
        "",
    ]
    return "\n".join(lines)


def render(path, account_id, origin):
    data = require_committed(load(path))
    account = validate_account(account_id)
    origin_url, host = validate_origin(origin)
    data["account_id"] = account
    data["vars"]["COMMONA_PUBLIC_ORIGIN"] = origin_url
    data["routes"][0]["pattern"] = host
    text = dump(data)
    for token in FORBIDDEN:
        if token in text:
            fail("rendered demo worker config binds private or unpublished data")
    parsed = tomllib.loads(text)
    if parsed["account_id"] != account or parsed["routes"][0]["pattern"] != host:
        fail("rendered demo worker config did not keep the approved target")
    if "DIRECTORY" in text or parsed["name"] != "commona-demo":
        fail("rendered demo worker config is not the public demo")
    return text


def write_out(path, text):
    if os.path.basename(path) in {"wrangler.toml", "wrangler.demo.toml"}:
        fail("refusing to overwrite a committed wrangler config")
    parent = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".wrangler-demo-", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def smoke(origin):
    url, _host = validate_origin(origin)
    proc = subprocess.run(
        [
            "curl",
            "-sS",
            "-o",
            os.devnull,
            "-w",
            "%{http_code}",
            "--max-redirs",
            "0",
            "--max-time",
            "20",
            url,
        ],
        capture_output=True,
        text=True,
    )
    code = (proc.stdout or "").strip()
    if proc.returncode != 0 or code != "200":
        fail("public origin did not return 200")
    print("public origin status: 200")


def main(argv):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    check = sub.add_parser("check")
    check.add_argument("--file", default="wrangler.demo.toml")
    rendered = sub.add_parser("render")
    rendered.add_argument("--file", default="wrangler.demo.toml")
    rendered.add_argument("--out", required=True)
    sub.add_parser("smoke")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "check":
            require_committed(load(args.file))
            print("commona-demo config ok")
        elif args.cmd == "render":
            text = render(
                args.file,
                os.environ.get("COMMONA_DEMO_ACCOUNT_ID", ""),
                os.environ.get("COMMONA_DEMO_ENVIRONMENT_URL", ""),
            )
            write_out(args.out, text)
            print("demo deploy config written")
        else:
            smoke(os.environ.get("COMMONA_DEMO_ENVIRONMENT_URL", ""))
    except ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
