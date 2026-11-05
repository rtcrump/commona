import { createServer, type Server, type Socket } from "node:net";

export interface CapturedMail {
  from: string;
  to: string[];
  raw: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * In-process SMTP catcher. It accepts a message and stores it.
 * It does not send anything off the machine.
 */
export async function startMailSink(): Promise<{
  host: string;
  port: number;
  messages: CapturedMail[];
  setFailing: (failing: boolean) => void;
  stop: () => Promise<void>;
}> {
  const messages: CapturedMail[] = [];
  const sockets = new Set<Socket>();
  let failing = false;
  const server: Server = createServer((socket) => {
    if (failing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let mode: "command" | "data" = "command";
    let from = "";
    const to: string[] = [];
    let data = "";
    const write = (line: string) => socket.write(`${line}\r\n`);

    const onLine = (line: string) => {
      if (mode === "data") {
        if (line === ".") {
          const raw = data.endsWith("\n") ? data.slice(0, -1) : data;
          messages.push(parseMail(from, [...to], raw.replaceAll("\r\n", "\n")));
          from = "";
          to.length = 0;
          data = "";
          mode = "command";
          write("250 ok");
          return;
        }
        data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
        return;
      }
      const [word, ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch ((word ?? "").toUpperCase()) {
        case "HELO":
        case "EHLO":
          write("250 commona-mail-sink");
          break;
        case "MAIL":
          from = addressOf(arg);
          write("250 ok");
          break;
        case "RCPT":
          to.push(addressOf(arg));
          write("250 ok");
          break;
        case "DATA":
          mode = "data";
          data = "";
          write("354 send data");
          break;
        case "RSET":
          from = "";
          to.length = 0;
          write("250 ok");
          break;
        case "NOOP":
          write("250 ok");
          break;
        case "QUIT":
          write("221 bye");
          socket.end();
          break;
        default:
          write("502 command not implemented");
      }
    };

    write("220 commona-mail-sink");
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        onLine(line);
        nl = buffer.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mail sink did not bind a TCP port");
  }
  return {
    host: "127.0.0.1",
    port: address.port,
    messages,
    setFailing(next: boolean) {
      failing = next;
      if (next) {
        for (const socket of sockets) socket.destroy();
      }
    },
    stop() {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function addressOf(arg: string): string {
  const match = /<([^>]+)>/.exec(arg);
  return (match?.[1] ?? arg).trim();
}

function parseMail(from: string, to: string[], raw: string): CapturedMail {
  const splitAt = raw.indexOf("\n\n");
  const head = splitAt === -1 ? raw : raw.slice(0, splitAt);
  const body = splitAt === -1 ? "" : raw.slice(splitAt + 2);
  const headers: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { from, to, raw, headers, body };
}
