import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONNECT_OWNER_ACTIONS } from "./connect-steps.js";

const templateDir = fileURLToPath(new URL("../../web/onboarding/", import.meta.url));

function readTemplate(name: string): string {
  return readFileSync(`${templateDir}${name}`, "utf8");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fill(template: string, slots: Record<string, string>, raw: ReadonlySet<string> = new Set()): string {
  return template.replaceAll(/\{\{([a-zA-Z0-9]+)\}\}/g, (_match, key: string) => {
    if (!(key in slots)) throw new Error(`missing page slot ${key}`);
    const value = slots[key] ?? "";
    return raw.has(key) ? value : escapeHtml(value);
  });
}

function document(title: string, body: string): string {
  return fill(readTemplate("layout.html"), { title, body }, new Set(["body"]));
}

function formCheck(nonce: string): string {
  return fill(readTemplate("form-check.html"), { nonce });
}

export function joinStylesheet(): string {
  return readTemplate("join.css");
}

export function connectScript(): string {
  return readTemplate("connect.js");
}

export function renderWelcome(input: {
  inviter: string;
  room: string;
  action: string;
  nonce: string;
  note?: string;
}): string {
  const note = input.note ? `<p class="note">${escapeHtml(input.note)}</p>` : "";
  const body = fill(
    readTemplate("welcome.html"),
    {
      inviter: input.inviter,
      room: input.room,
      action: input.action,
      note,
      check: formCheck(input.nonce),
    },
    new Set(["note", "check"]),
  );
  return document("Join", body);
}

export function renderSharing(input: { action: string; nonce: string }): string {
  const body = fill(
    readTemplate("sharing.html"),
    { action: input.action, check: formCheck(input.nonce) },
    new Set(["check"]),
  );
  return document("Choose what others can see", body);
}

export function renderDone(connectHref: string): string {
  const body = fill(readTemplate("done.html"), { connect: connectHref });
  return document("You're in", body);
}

export function renderError(sentence: string): string {
  const body = fill(readTemplate("error.html"), { sentence });
  return document("Join", body);
}

export function renderConnect(): string {
  return document("Connect your assistant", readTemplate("connect.html"));
}

export function renderGuided(input: {
  heading: string;
  intro: string;
  note: string;
  inviter: string;
  copyLabel: string;
  copyAction: string;
  checkAction: string;
  nonce: string;
}): string {
  const steps = CONNECT_OWNER_ACTIONS.map((step) => {
    const mark = step.unverified ? " (unverified)" : "";
    return `<li>${escapeHtml(step.text)}${mark}</li>`;
  }).join("\n");
  const body = fill(
    readTemplate("guided.html"),
    {
      heading: input.heading,
      intro: input.intro,
      note: input.note,
      steps,
      inviter: input.inviter,
      copyLabel: input.copyLabel,
      copyAction: input.copyAction,
      checkAction: input.checkAction,
      check: formCheck(input.nonce),
    },
    new Set(["note", "steps", "check"]),
  );
  return document(input.heading, body);
}

export function renderStatus(status: "Connected" | "Not connected"): string {
  const body = fill(readTemplate("status.html"), { status });
  return document(status, body);
}

/** True only when the caller asks for HTML and does not prefer JSON. */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  let html = -1;
  let json = -1;
  for (const part of accept.split(",")) {
    const [typePart, ...params] = part.trim().toLowerCase().split(";");
    const type = typePart?.trim() ?? "";
    let q = 1;
    for (const param of params) {
      const [rawKey, rawValue] = param.split("=");
      const key = rawKey?.trim();
      const value = rawValue?.trim();
      if (key === "q" && value) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (type === "text/html") html = q;
    else if (type === "application/json" && q > json) json = q;
  }
  if (html <= 0) return false;
  if (json > html) return false;
  return true;
}
