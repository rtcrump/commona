import type Database from "better-sqlite3";
import {
  systemClock,
  type AuditLog,
  type Clock,
  type ContentGuard,
  type OwnerNotifier,
  type SharingDirectory,
  type TokenStore,
  type WakeQueue,
} from "../contract/index.js";
import { createAuditLog } from "./audit/index.js";
import { createTokenStore } from "./auth/index.js";
import { guard } from "./guard/index.js";
import { listenNode, type NodeListener } from "./http/node-listen.js";
import { createHttpApp } from "./http/server.js";
import { createOwnerNotifier } from "./notices/index.js";
import type { RoomDeps } from "./room/deps.js";
import { closeDefaultRuntime, defaultRuntime } from "./runtime.js";
import { createSharingDirectory } from "./sharing/index.js";
import type { SmtpEndpoint } from "./wakeup/smtp.js";

export interface BuildAppOptions {
  db?: Database.Database;
  clock?: Clock;
  tokens?: TokenStore;
  audit?: AuditLog;
  sharing?: SharingDirectory;
  guard?: ContentGuard;
  notices?: OwnerNotifier;
  /**
   * Pass a queue to enqueue wakes after an accepted post or file.
   * The no-argument app uses the wake-up service and delivers those wakes.
   */
  wakeQueue?: WakeQueue;
  /** When set, accepted wakes are delivered. Ignored when `wakeQueue` is injected. */
  deliverWake?: (wakeId: string) => Promise<void>;
  /** `null` leaves email unconfigured. Omit it to read COMMONA_SMTP_HOST and COMMONA_SMTP_PORT. */
  smtp?: SmtpEndpoint | null;
}

export interface InjectResult {
  statusCode: number;
  body: string;
  json(): unknown;
}

export interface RunningApp {
  fetch(request: Request): Promise<Response>;
  listen(options: { host: string; port: number }): Promise<void>;
  close(): Promise<void>;
  inject(options: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<InjectResult>;
  server: { address(): ReturnType<NodeListener["server"]["address"]> };
}

/**
 * The no-argument app is what the harness starts. It opens COMMONA_DB (or memory),
 * wires auth, audit, sharing, the name block, notices, and wake-up, and delivers
 * to the webhook URLs stored on the agents.
 * The Worker builds the same HTTP app inside a Durable Object and does not call this.
 */
export function buildApp(options: BuildAppOptions = {}): RunningApp {
  const shared = options.db === undefined ? defaultRuntime() : undefined;
  const db = options.db ?? shared!.db;
  const clock = options.clock ?? shared?.clock ?? systemClock;
  const audit = options.audit ?? shared?.audit ?? createAuditLog(db, clock);
  const tokens = options.tokens ?? shared?.tokens ?? createTokenStore(db);
  const notices = options.notices ?? shared?.notices ?? createOwnerNotifier(db, clock);
  const smtp = resolveSmtp(options, shared?.smtp);
  const wakeQueue = options.wakeQueue ?? shared?.wake;
  const deliverWake = options.wakeQueue ? options.deliverWake : shared ? deliverWith(shared.wake) : options.deliverWake;
  const deps: RoomDeps = {
    db,
    clock,
    tokens,
    audit,
    sharing: options.sharing ?? shared?.sharing ?? createSharingDirectory(db),
    guard: options.guard ?? shared?.guard ?? guard,
    notices,
    ...(wakeQueue ? { wakeQueue } : {}),
    ...(deliverWake ? { deliverWake } : {}),
    ...(smtp ? { smtp } : {}),
  };
  const app = createHttpApp(deps);
  let listener: NodeListener | undefined;
  return {
    fetch(request: Request): Promise<Response> {
      return Promise.resolve(app.fetch(request));
    },
    async inject(options): Promise<InjectResult> {
      const headers = new Headers();
      const host = options.headers?.host ?? "127.0.0.1";
      for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
      headers.set("host", host);
      const body = options.payload === undefined ? undefined : JSON.stringify(options.payload);
      if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
      const response = await Promise.resolve(
        app.fetch(new Request(`http://${host}${options.url}`, { method: options.method, headers, body })),
      );
      const text = await response.text();
      return {
        statusCode: response.status,
        body: text,
        json: () => JSON.parse(text) as unknown,
      };
    },
    async listen(options: { host: string; port: number }): Promise<void> {
      listener = await listenNode((request) => Promise.resolve(app.fetch(request)), options.host, options.port);
    },
    server: {
      address() {
        return listener ? listener.server.address() : null;
      },
    },
    async close(): Promise<void> {
      if (listener) {
        const current = listener;
        listener = undefined;
        await current.close();
      }
      if (shared) closeDefaultRuntime();
    },
  };
}

function resolveSmtp(options: BuildAppOptions, shared: SmtpEndpoint | undefined): SmtpEndpoint | undefined {
  if (options.smtp === null) return undefined;
  if (options.smtp) return options.smtp;
  return shared;
}

function deliverWith(wake: { deliver(wakeId: string): Promise<unknown> }): (wakeId: string) => Promise<void> {
  return (wakeId) => wake.deliver(wakeId).then(() => undefined);
}
