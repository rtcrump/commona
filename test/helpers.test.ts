import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startMailSink } from "./helpers/mailSink.js";
import { startTestServer } from "./helpers/server.js";
import { startWebhookSink } from "./helpers/webhookSink.js";

describe("test helpers", () => {
  it("starts and stops an in-process server", async () => {
    const server = await startTestServer();
    const health = await fetch(`${server.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "commona" });
    const missing = await fetch(`${server.baseUrl}/rooms`, { method: "POST" });
    expect(missing.status).toBe(404);
    await server.stop();
  });

  it("records a webhook without leaving the machine", async () => {
    const sink = await startWebhookSink();
    const response = await fetch(sink.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "commona.wake", wakeId: "wake_1" }),
    });
    expect(response.status).toBe(200);
    expect(sink.hits).toHaveLength(1);
    expect(sink.hits[0]?.json).toEqual({ type: "commona.wake", wakeId: "wake_1" });
    sink.setStatus(503);
    const down = await fetch(sink.url, { method: "POST", body: "{}" });
    expect(down.status).toBe(503);
    await sink.stop();
  });

  it("captures SMTP locally", async () => {
    const sink = await startMailSink();
    await sendSmtp(sink.port);
    await sink.stop();
    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]?.to).toEqual(["a2@example.test"]);
    expect(sink.messages[0]?.headers.Subject).toBe("hello");
    expect(sink.messages[0]?.body).toBe("body line");
  });
});

function sendSmtp(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const commands = ["HELO local", "MAIL FROM:<commona@localhost>", "RCPT TO:<a2@example.test>", "DATA"];
    let phase: "command" | "body" | "quit" = "command";
    let index = 0;
    socket.on("error", reject);
    socket.on("data", () => {
      if (phase === "command") {
        const line = commands[index] ?? "";
        index += 1;
        socket.write(`${line}\r\n`);
        if (index === commands.length) phase = "body";
        return;
      }
      if (phase === "body") {
        socket.write("Subject: hello\r\n\r\nbody line\r\n.\r\n");
        phase = "quit";
        return;
      }
      socket.write("QUIT\r\n");
      socket.end();
      resolve();
    });
  });
}
