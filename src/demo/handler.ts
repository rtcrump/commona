import {
  analyticsToken,
  beaconMarkup,
  contentSecurityPolicy,
  DEMO_ASSET_PATHS,
  DEMO_HEALTH_PATHS,
  DEMO_HTML_PATHS,
  pageGetsBeacon,
} from "./analytics.js";
import { demoScript, demoStylesheet } from "./assets.js";
import { renderDemoPage, renderPrivacyPage, renderStatusPage } from "./page.js";

export interface DemoEnv {
  /** Site token for Cloudflare Web Analytics. Unset means the beacon stays off. */
  COMMONA_DEMO_ANALYTICS_TOKEN?: string;
}

const HTML_PATHS = new Set<string>(DEMO_HTML_PATHS);
const ASSET_PATHS = new Set<string>(DEMO_ASSET_PATHS);
const HEALTH_PATHS = new Set<string>(DEMO_HEALTH_PATHS);

const NOT_FOUND = "This public demo has no rooms to open. The scripted story is on the home page.";
const METHOD = "This demo only serves the story. It does not take posts, invites, or changes.";

/**
 * Public demo fetch handler. It does not read a directory, a room, or a
 * secret. Unknown paths and write methods never echo the request.
 */
export function handleDemoRequest(request: Request, env: DemoEnv = {}): Response {
  const url = new URL(request.url);
  const canonical = canonicalPath(url.pathname);
  if (request.method !== "GET" && request.method !== "HEAD") {
    discard(request);
    if (canonical === null) return finish(request, notFound());
    return finish(request, methodNotAllowed());
  }
  if (canonical === null) return finish(request, notFound());
  if (url.search !== "" || url.pathname !== canonical) {
    return finish(request, redirect(canonical));
  }
  const token = analyticsToken(env.COMMONA_DEMO_ANALYTICS_TOKEN);
  const beaconOn = pageGetsBeacon(canonical, token);
  if (HEALTH_PATHS.has(canonical)) return finish(request, health());
  if (canonical === "/demo/demo.css") return finish(request, asset(demoStylesheet(), "text/css; charset=utf-8"));
  if (canonical === "/demo/replay.js") return finish(request, asset(demoScript(), "text/javascript; charset=utf-8"));
  if (!HTML_PATHS.has(canonical)) return finish(request, notFound());
  const beacon = beaconOn ? beaconMarkup(token) : "";
  const html =
    canonical === "/demo/privacy"
      ? renderPrivacyPage({ beacon, analyticsOn: beaconOn })
      : renderDemoPage({ beacon, analyticsOn: beaconOn });
  return finish(request, page(html, beaconOn));
}

function canonicalPath(pathname: string): string | null {
  const trimmed = pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (HTML_PATHS.has(trimmed) || ASSET_PATHS.has(trimmed) || HEALTH_PATHS.has(trimmed)) return trimmed;
  return null;
}

function page(html: string, beaconOn: boolean): Response {
  return new Response(html, {
    status: 200,
    headers: headers("text/html; charset=utf-8", beaconOn),
  });
}

function asset(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: headers(contentType, false),
  });
}

function health(): Response {
  return new Response(JSON.stringify({ ok: true, service: "commona-demo" }), {
    status: 200,
    headers: headers("application/json; charset=utf-8", false),
  });
}

function notFound(): Response {
  return new Response(renderStatusPage(NOT_FOUND, 404), {
    status: 404,
    headers: headers("text/html; charset=utf-8", false),
  });
}

function methodNotAllowed(): Response {
  const response = new Response(renderStatusPage(METHOD, 405), {
    status: 405,
    headers: headers("text/html; charset=utf-8", false),
  });
  response.headers.set("allow", "GET, HEAD");
  return response;
}

function redirect(path: string): Response {
  const response = new Response(null, {
    status: 302,
    headers: headers("text/plain; charset=utf-8", false),
  });
  response.headers.set("location", path);
  return response;
}

function headers(contentType: string, beaconOn: boolean): Headers {
  const result = new Headers();
  result.set("content-type", contentType);
  result.set("cache-control", "no-store");
  result.set("referrer-policy", "no-referrer");
  result.set("x-content-type-options", "nosniff");
  result.set("x-frame-options", "DENY");
  result.set("content-security-policy", contentSecurityPolicy(beaconOn));
  result.set("permissions-policy", "interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()");
  result.set("cross-origin-resource-policy", "same-origin");
  return result;
}

function finish(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, { status: response.status, headers: response.headers });
}

function discard(request: Request): void {
  const body = request.body;
  if (body) void body.cancel();
}
