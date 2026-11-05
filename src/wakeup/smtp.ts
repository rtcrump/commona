import { WAKE_HEADER_EVENT, WAKE_HEADER_ROOM_ID, WAKE_HEADER_WAKE_ID, type WakeEmail } from "../../contract/index.js";

/** The contract does not set an email timeout. This bounds a hung SMTP connection. */
export const WAKE_EMAIL_TIMEOUT_MS = 10_000;

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpError";
  }
}

export interface SmtpEndpoint {
  host: string;
  port: number;
}

/**
 * Opens one SMTP conversation.
 * Node registers a sender that uses `node:net`. The Worker registers one that uses
 * `cloudflare:sockets`. This file does not import either, so the Worker bundle can
 * load wake delivery without `node:net`.
 */
export type MailSender = (endpoint: SmtpEndpoint, from: string, to: string, data: string, timeoutMs: number) => Promise<void>;

let mailSender: MailSender | undefined;

export function registerMailSender(sender: MailSender): void {
  mailSender = sender;
}

function safeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new SmtpError("smtp header value is invalid");
  return value;
}

export function formatWakeMessage(email: WakeEmail): string {
  const headers = [
    `From: ${safeHeader(email.from)}`,
    `To: ${safeHeader(email.to)}`,
    `Subject: ${safeHeader(email.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    `${WAKE_HEADER_EVENT}: ${safeHeader(email.headers[WAKE_HEADER_EVENT])}`,
    `${WAKE_HEADER_WAKE_ID}: ${safeHeader(email.headers[WAKE_HEADER_WAKE_ID])}`,
    `${WAKE_HEADER_ROOM_ID}: ${safeHeader(email.headers[WAKE_HEADER_ROOM_ID])}`,
  ];
  const body = email.text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export function dotStuff(data: string): string {
  return data
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/**
 * Minimal SMTP client for the in-process sink. It does not relay off the configured host.
 */
export interface PlainMail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** A short owner mail. Block notices use this. Wake mail keeps its own headers. */
export function formatPlainMail(mail: PlainMail): string {
  const headers = [
    `From: ${safeHeader(mail.from)}`,
    `To: ${safeHeader(mail.to)}`,
    `Subject: ${safeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = mail.text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/**
 * SMTP host and port for the process. The contract does not name them.
 * Both must be set. A missing pair means email cannot be sent.
 */
export function smtpFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpEndpoint | undefined {
  const host = env.COMMONA_SMTP_HOST?.trim();
  const portText = env.COMMONA_SMTP_PORT?.trim();
  if (!host || !portText || !/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65535) return undefined;
  return { host, port };
}

export function sendPlainMail(endpoint: SmtpEndpoint, mail: PlainMail, timeoutMs = WAKE_EMAIL_TIMEOUT_MS): Promise<void> {
  return deliverThroughSender(endpoint, mail.from, mail.to, formatPlainMail(mail), timeoutMs);
}

export function sendSmtp(endpoint: SmtpEndpoint, email: WakeEmail, timeoutMs = WAKE_EMAIL_TIMEOUT_MS): Promise<void> {
  return deliverThroughSender(endpoint, email.from, email.to, formatWakeMessage(email), timeoutMs);
}

function deliverThroughSender(endpoint: SmtpEndpoint, from: string, to: string, data: string, timeoutMs: number): Promise<void> {
  if (!mailSender) return Promise.reject(new Error("smtp is not configured"));
  return mailSender(endpoint, from, to, data, timeoutMs);
}
