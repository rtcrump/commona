import { connect, type Socket } from "node:net";
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

function dotStuff(data: string): string {
  return data
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

/**
 * Minimal SMTP client for the in-process sink. It does not relay off the configured host.
 */
export function sendSmtp(endpoint: SmtpEndpoint, email: WakeEmail, timeoutMs = WAKE_EMAIL_TIMEOUT_MS): Promise<void> {
  const data = formatWakeMessage(email);
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(endpoint.port, endpoint.host);
    let buffer = "";
    let step: "greeting" | "helo" | "mail" | "rcpt" | "data" | "body" | "quit" = "greeting";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.end();
      resolve();
    };

    const timer = setTimeout(() => finish(new SmtpError("smtp timeout")), timeoutMs);

    const write = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    const failCode = (label: string, code: number) => {
      finish(new SmtpError(`smtp ${label} ${code}`));
    };

    const onLine = (line: string) => {
      if (line.length >= 4 && line[3] === "-") return;
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code)) {
        finish(new SmtpError("smtp response was not a status code"));
        return;
      }
      switch (step) {
        case "greeting":
          if (code !== 220) return failCode("greeting", code);
          step = "helo";
          write("EHLO commona");
          return;
        case "helo":
          if (code !== 250) return failCode("ehlo", code);
          step = "mail";
          write(`MAIL FROM:<${email.from}>`);
          return;
        case "mail":
          if (code !== 250) return failCode("mail", code);
          step = "rcpt";
          write(`RCPT TO:<${email.to}>`);
          return;
        case "rcpt":
          if (code !== 250) return failCode("rcpt", code);
          step = "data";
          write("DATA");
          return;
        case "data":
          if (code !== 354) return failCode("data", code);
          step = "body";
          socket.write(`${dotStuff(data)}\r\n.\r\n`);
          return;
        case "body":
          if (code !== 250) return failCode("body", code);
          step = "quit";
          write("QUIT");
          return;
        case "quit":
          if (code !== 221) return failCode("quit", code);
          finish();
          return;
        default:
          finish(new SmtpError("smtp step"));
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0 && !settled) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => {
      if (!settled) finish(new SmtpError("smtp connection closed"));
    });
  });
}
