import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { HOST_SECRET_HEADER } from "../../src/host/host-room.js";

const hostSecret = "host-test-secret";
const markup = 'Bring napkins <script>alert(1)</script> & "forks"';
const escaped = "&quot;Bring napkins &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;forks&quot;&quot;";

describe("worker room page", () => {
  it("serves the page with JavaScript off, escapes a form post, and refuses a second use", async () => {
    const created = await hostRoom("Sunday lunch");
    const opened = await SELF.fetch(`https://room.example.test/r/${created.roomId}?t=${created.secret}`);
    const page = await opened.text();
    expect(opened.status).toBe(200);
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain('<form method="post"');
    expect(page).toContain(">Post</button>");
    expect(page).toContain("<h1>Sunday lunch</h1>");
    expect(page.includes(created.secret)).toBe(false);
    expect(page.includes(created.credential)).toBe(false);
    expect(page.includes(hostSecret)).toBe(false);

    const header = opened.headers.getSetCookie().find((value) => value.startsWith("commona_agent=")) ?? "";
    const key = cookieValue(header);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(page.includes(`<pre>${key}</pre>`)).toBe(true);

    const nonce = nonceOf(page);
    const posted = await SELF.fetch(`https://room.example.test/r/${created.roomId}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `commona_agent=${key}`,
      },
      body: new URLSearchParams({ nonce, text: markup }),
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(`/r/${created.roomId}`);
    await posted.arrayBuffer();

    const after = await SELF.fetch(`https://room.example.test/r/${created.roomId}`, {
      headers: { cookie: `commona_agent=${key}` },
    });
    const shown = await after.text();
    expect(after.status).toBe(200);
    expect(shown).toContain("<blockquote>");
    expect(shown).toContain(escaped);
    expect(shown).not.toMatch(/<script/i);
    expect(shown.includes(key)).toBe(false);
    expect(shown.includes(created.secret)).toBe(false);

    const reused = await SELF.fetch(`https://room.example.test/r/${created.roomId}/${created.id}/${created.secret}`);
    const refused = await reused.text();
    expect(reused.status).toBe(403);
    expect(refused).toContain("This invite cannot be used");
    expect(refused.includes(created.secret)).toBe(false);
    expect(refused.includes(key)).toBe(false);

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const record = await runInDurableObject(stub, (instance) => instance.inviteRecord(created.id));
    expect(record?.usedAt).not.toBeNull();
    expect(record?.secretHash).toBe(hashToken(created.secret));
    const audit = await runInDurableObject(stub, (instance) => instance.auditSnapshot());
    const postedRow = audit.find((row) => row.action === "post" && row.result === "ok");
    expect(postedRow).toBeDefined();
    const auditText = JSON.stringify(audit);
    expect(auditText.includes(created.secret)).toBe(false);
    expect(auditText.includes(key)).toBe(false);
    expect(auditText.includes(created.credential)).toBe(false);
    expect(auditText.includes(hostSecret)).toBe(false);
  });

  it("refuses an expired invite and leaves it unused", async () => {
    const created = await hostRoom("Sunday lunch");
    const minted = await SELF.fetch(`https://room.example.test/rooms/${created.roomId}/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${created.credential}`,
      },
      body: JSON.stringify({ expiresInSeconds: 1 }),
    });
    const mintedText = await minted.text();
    expect(minted.status).toBe(201);
    expect(mintedText.includes(hostSecret)).toBe(false);
    const link = (JSON.parse(mintedText) as { invite?: { id?: string; link?: string } }).invite?.link ?? "";
    const parts = new URL(link).pathname.split("/");
    const id = parts[2] ?? "";
    const secret = parts[3] ?? "";
    expect(/^inv_[0-9a-f-]{36}$/.test(id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const opened = await SELF.fetch(`https://room.example.test/r/${created.roomId}?t=${secret}`);
    const body = await opened.text();
    expect(opened.status).toBe(403);
    expect(body).toContain("This invite cannot be used");
    expect(body.includes(secret)).toBe(false);
    expect(body.includes(created.credential)).toBe(false);

    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    const record = await runInDurableObject(stub, (instance) => instance.inviteRecord(id));
    expect(record?.usedAt).toBeNull();
    expect(record?.secretHash).toBe(hashToken(secret));
  });
});

async function hostRoom(title: string): Promise<{ roomId: string; id: string; secret: string; credential: string }> {
  const response = await SELF.fetch("https://room.example.test/host/room", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HOST_SECRET_HEADER]: hostSecret,
    },
    body: JSON.stringify({ title, hostName: "Host (demo)", inviteCount: 1 }),
  });
  const body = await response.text();
  expect(response.status).toBe(201);
  expect(body.includes(hostSecret)).toBe(false);
  const created = JSON.parse(body) as { invites?: string[]; roomId?: string; credential?: string };
  const link = created.invites?.[0] ?? "";
  const parts = new URL(link).pathname.split("/");
  return {
    roomId: created.roomId ?? "",
    id: parts[2] ?? "",
    secret: parts[3] ?? "",
    credential: created.credential ?? "",
  };
}

function cookieValue(header: string): string {
  const end = header.indexOf(";");
  const pair = end === -1 ? header : header.slice(0, end);
  return pair.slice("commona_agent=".length);
}

function nonceOf(html: string): string {
  return html.match(/name="nonce" value="([^"]+)"/)?.[1] ?? "";
}
