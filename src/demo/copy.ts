/** Visible privacy sentences. They stay free of story text and of any site token. */

export function privacySummary(analyticsOn: boolean): string {
  const shared =
    "This demo does not set a cookie, does not use local storage, and does not ask for an account. The story is the same for every visitor. A network still uses an IP address to deliver the page. This note does not claim that no network data is processed.";
  if (!analyticsOn) return `${shared} Page analytics is not loaded.`;
  return `${shared} Page analytics is on for these public demo pages only. It is Cloudflare Web Analytics, with no query string and no story text. That service says it does not use cookies or local storage for analytics. We do not send a name, a message, or a page query to it.`;
}

export const PRIVACY_DETAIL = [
  "You can read this story with no account and no invite.",
  "The page does not store anything on your computer for us.",
  "Nothing you read here is sent onward as a message.",
  "If analytics is loaded, it is only on the home page, the demo page, and this privacy page.",
  "A query string is removed before the page is shown, so it is not part of a page view.",
  "The host that carries this page, and your network, can see the IP address needed to deliver it.",
].join(" ");
