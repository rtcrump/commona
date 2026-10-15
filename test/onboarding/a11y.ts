import { expect } from "vitest";

const FORBIDDEN = ["token", "webhook", "mcp", "api", "credential"];

function channel(hex: string, index: number): number {
  const value = Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const left = luminance(foreground);
  const right = luminance(background);
  const [hi, lo] = left > right ? [left, right] : [right, left];
  return (hi + 0.05) / (lo + 0.05);
}

export function stripNonce(html: string): string {
  return html.replaceAll(/name="nonce" value="[^"]*"/g, 'name="nonce" value="NONCE"');
}

export function assertNoJargon(html: string): void {
  const source = stripNonce(html);
  for (const word of FORBIDDEN) {
    expect(source.toLowerCase()).not.toMatch(new RegExp(`\\b${word}\\b`, "i"));
  }
}

/** Labels, one heading, language, the radio group, and no inline script. */
export function assertAccessible(html: string): void {
  expect(html).toMatch(/<html lang="en">/);
  expect(html.match(/<h1\b/g)?.length).toBe(1);
  expect(html.match(/<\/h1>/g)?.length).toBe(1);
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  expect(scripts.length).toBeLessThanOrEqual(1);
  for (const script of scripts) {
    expect((script[1] ?? "").trim()).toBe('src="/onboarding/connect.js"');
  }
  expect(html.toLowerCase()).not.toContain("<script>");

  const inputs = [...html.matchAll(/<input\b([^>]*)>/g)];
  for (const input of inputs) {
    const attrs = input[1] ?? "";
    const id = /id="([^"]+)"/.exec(attrs)?.[1];
    if (id) {
      expect(html).toContain(`for="${id}"`);
      continue;
    }
    const index = input.index ?? 0;
    const open = html.lastIndexOf("<label", index);
    const close = html.lastIndexOf("</label>", index);
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(close);
  }

  if (html.includes('type="radio"')) {
    expect(html).toContain("<fieldset>");
    expect(html).toContain("<legend>");
    expect(html).toContain("</legend>");
    expect(html).toContain("</fieldset>");
  }
}

export function assertStyles(css: string): void {
  expect(css).toContain(":focus-visible");
  expect(css).toContain("min-height: 44px");
  expect(css).toContain("min-width: 44px");
  const root = /:root\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
  const vars: Record<string, string> = {};
  for (const match of root.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    const name = match[1];
    const color = match[2];
    if (name && color) vars[name] = color;
  }
  const pairs: Array<[string, string]> = [
    ["ink", "paper"],
    ["ink", "card"],
    ["action-ink", "action"],
    ["link", "card"],
    ["link", "paper"],
    ["ink", "quiet-paper"],
  ];
  for (const [foreground, background] of pairs) {
    const fg = vars[foreground];
    const bg = vars[background];
    expect(fg, foreground).toBeTruthy();
    expect(bg, background).toBeTruthy();
    expect(contrast(fg ?? "#000000", bg ?? "#ffffff")).toBeGreaterThanOrEqual(4.5);
  }
  const withoutRoot = css.replace(/:root\s*\{[^}]+\}/, "");
  expect(withoutRoot).not.toMatch(/#[0-9a-fA-F]{3,8}/);
}
