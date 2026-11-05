import { connect } from "cloudflare:sockets";
import { dotStuff, registerMailSender, SmtpError, type SmtpEndpoint } from "./smtp.js";

/**
 * Worker SMTP transport. A Durable Object cannot import `node:net`, so mail uses the
 * Workers TCP socket. The Node server does not load this file.
 */
export function registerWorkerMailTransport(): void {
  registerMailSender((endpoint, from, to, data, timeoutMs) => deliverMail(endpoint, from, to, data, timeoutMs));
}

type SmtpStep = "greeting" | "helo" | "mail" | "rcpt" | "data" | "body" | "quit";

function deliverMail(endpoint: SmtpEndpoint, from: string, to: string, data: string, timeoutMs: number): Promise<void> {
  const socket = connect({ hostname: endpoint.host, port: endpoint.port });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let step: SmtpStep = "greeting";
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void socket.close().catch(() => undefined);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const timer = setTimeout(() => finish(new SmtpError("smtp timeout")), timeoutMs);

    const write = async (bytes: string) => {
      await writer.write(encoder.encode(bytes));
    };

    const failCode = (label: string, code: number) => {
      finish(new SmtpError(`smtp ${label} ${code}`));
    };

    const onLine = async (line: string) => {
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
          await write("EHLO commona\r\n");
          return;
        case "helo":
          if (code !== 250) return failCode("ehlo", code);
          step = "mail";
          await write(`MAIL FROM:<${from}>\r\n`);
          return;
        case "mail":
          if (code !== 250) return failCode("mail", code);
          step = "rcpt";
          await write(`RCPT TO:<${to}>\r\n`);
          return;
        case "rcpt":
          if (code !== 250) return failCode("rcpt", code);
          step = "data";
          await write("DATA\r\n");
          return;
        case "data":
          if (code !== 354) return failCode("data", code);
          step = "body";
          await write(`${dotStuff(data)}\r\n.\r\n`);
          return;
        case "body":
          if (code !== 250) return failCode("body", code);
          step = "quit";
          await write("QUIT\r\n");
          return;
        case "quit":
          if (code !== 221) return failCode("quit", code);
          finish();
          return;
        default:
          finish(new SmtpError("smtp step"));
      }
    };

    void (async () => {
      try {
        while (!settled) {
          const chunk = await reader.read();
          if (settled) return;
          if (chunk.done) {
            finish(new SmtpError("smtp connection closed"));
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0 && !settled) {
            let line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            await onLine(line);
            nl = buffer.indexOf("\n");
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new SmtpError("smtp connection closed"));
      }
    })();
  });
}
