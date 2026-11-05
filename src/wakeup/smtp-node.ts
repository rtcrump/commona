import { connect, type Socket } from "node:net";
import { dotStuff, registerMailSender, SmtpError, type SmtpEndpoint } from "./smtp.js";

/**
 * Node SMTP transport. The Worker must not import this file: `node:net` cannot open
 * the connection there. `src/wakeup/index.ts` loads it for the Node server and the Node tests.
 */
registerMailSender((endpoint, from, to, data, timeoutMs) => deliverMail(endpoint, from, to, data, timeoutMs));

function deliverMail(endpoint: SmtpEndpoint, from: string, to: string, data: string, timeoutMs: number): Promise<void> {
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
          write(`MAIL FROM:<${from}>`);
          return;
        case "mail":
          if (code !== 250) return failCode("mail", code);
          step = "rcpt";
          write(`RCPT TO:<${to}>`);
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
