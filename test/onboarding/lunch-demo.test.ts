import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_AGENT_ROUNDS } from "../../contract/index.js";
import {
  ARTIFACT_HEADER,
  agreementText,
  agreedSlot,
  MESSAGE_CANARY,
  overlap,
  proposalSlots,
  PROPOSALS,
  runLunchDemo,
  slotText,
  stdoutIsReport,
  type LunchDemoResult,
} from "../../scripts/demo-lunch.js";

const STDOUT_WORDS = [MESSAGE_CANARY, "North Cafe", "proposal ", "agreed ", ARTIFACT_HEADER, "handoff="];

describe("lunch demo", () => {
  let result: LunchDemoResult | undefined;

  afterEach(async () => {
    await result?.stop();
    result = undefined;
  });

  it("agrees one slot and prints only the report", async () => {
    const captured: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      result = await runLunchDemo();
    } finally {
      process.stdout.write = write;
    }
    const demo = result;
    expect(demo.ok, demo.error).toBe(true);
    const stdout = captured.join("");
    expect(stdout).toBe(demo.stdout);
    expect(stdoutIsReport(stdout)).toBe(true);
    for (const word of STDOUT_WORDS) expect(stdout).not.toContain(word);
    expect(stdout).toContain("pass create-room");
    expect(stdout).toContain("pass deliver");
    expect(stdout).toMatch(/members 3\n/);
    expect(stdout).toMatch(/messages 4\n/);
    expect(stdout).toMatch(/rounds 3\n/);
    expect(stdout).not.toMatch(/^fail /m);

    expect(demo.owners).toHaveLength(3);
    expect(demo.agreed).toEqual({ day: "Wed", time: "12:30", place: "North Cafe" });
    const expected = overlap([PROPOSALS.trafford, PROPOSALS.ava, PROPOSALS.ben]);
    expect(expected).toHaveLength(1);
    expect(demo.agreed && slotText(demo.agreed)).toBe(slotText(expected[0]!));

    const posts = demo.db
      .prepare("SELECT author_owner_id, text, round, held FROM posts WHERE room_id = ? ORDER BY created_at, id")
      .all(demo.roomId) as { author_owner_id: string; text: string; round: number; held: number }[];
    expect(posts.every((post) => post.held === 0)).toBe(true);
    expect(Math.max(...posts.map((post) => post.round))).toBeLessThanOrEqual(DEFAULT_MAX_AGENT_ROUNDS);
    const proposals = posts.filter((post) => post.text.startsWith("proposal "));
    expect(proposals).toHaveLength(3);
    const byOwner = new Map(demo.owners.map((owner) => [owner.ownerId, owner.key]));
    for (const post of proposals) {
      const key = byOwner.get(post.author_owner_id);
      expect(key).toBeTruthy();
      if (!key) continue;
      expect(proposalSlots(post.text)).toEqual([...PROPOSALS[key]]);
    }
    const agreements = posts.filter((post) => post.text.startsWith("agreed "));
    expect(agreements).toHaveLength(1);
    expect(agreedSlot(agreements[0]?.text ?? "")).toEqual(demo.agreed);
    for (const post of proposals) {
      expect(proposalSlots(post.text).some((slot) => demo.agreed && slot.day === demo.agreed.day && slot.time === demo.agreed.time)).toBe(
        true,
      );
    }

    const agreedLine = agreementText(demo.agreed!);
    for (const owner of demo.owners) {
      expect(demo.connectorText[owner.key]).toContain(agreedLine);
    }

    const members = demo.db.prepare("SELECT owner_id FROM memberships WHERE room_id = ?").all(demo.roomId) as {
      owner_id: string;
    }[];
    expect(new Set(members.map((row) => row.owner_id)).size).toBe(3);
    const friendIds = demo.owners.filter((owner) => owner.key !== "trafford").map((owner) => owner.ownerId);
    const levels = demo.db
      .prepare("SELECT from_owner_id, to_owner_id, level FROM sharing WHERE room_id = ?")
      .all(demo.roomId) as { from_owner_id: string; to_owner_id: string; level: string }[];
    for (const friendId of friendIds) {
      const outgoing = levels.filter((row) => row.from_owner_id === friendId);
      expect(outgoing.length).toBeGreaterThan(0);
      expect(outgoing.every((row) => row.level === "messages")).toBe(true);
    }

    expect(demo.audit.verify()).toEqual({ ok: true });
    const tip = demo.db.prepare("SELECT seq, hash FROM audit_chain_tip WHERE id = 1").get() as {
      seq: number;
      hash: string;
    };
    const last = demo.db.prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as {
      seq: number;
      hash: string;
    };
    expect(tip).toEqual(last);

    const postText = new Map(
      (
        demo.db.prepare("SELECT id, text FROM posts").all() as { id: string; text: string }[]
      ).map((row) => [row.id, row.text]),
    );
    for (const owner of demo.owners) {
      const rows = demo.audit.listForOwner(owner.ownerId, owner.ownerId);
      const labels = rows.flatMap((row) => {
        if (row.action === "join" && row.result === "ok") return ["join"];
        if (row.action === "setting_change" && row.detail.level === "messages") return ["sharing"];
        if (row.action === "setting_change" && row.detail.authorAgentId && row.detail.level === undefined) {
          return ["connect"];
        }
        if (row.action === "post" || row.action === "wake") {
          const text = postText.get(row.detail.itemId ?? "") ?? "";
          if (text.startsWith("agreed ")) return ["agreement"];
          if (text.startsWith("proposal ")) return ["message"];
        }
        return [];
      });
      expect(labels[0]).toBe("join");
      const sharingAt = labels.indexOf("sharing");
      const connectAt = labels.indexOf("connect");
      const messageAt = labels.indexOf("message");
      const agreementAt = labels.lastIndexOf("agreement");
      expect(sharingAt).toBeGreaterThan(0);
      expect(connectAt).toBeGreaterThan(sharingAt);
      expect(messageAt).toBeGreaterThan(connectAt);
      expect(agreementAt).toBeGreaterThan(messageAt);
      expect(labels.filter((label) => label === "connect")).toHaveLength(1);
      expect(labels.slice(agreementAt + 1).some((label) => label === "message" || label === "connect")).toBe(false);
    }
    const loopStops = demo.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'loop_stop'").get() as {
      n: number;
    };
    expect(loopStops.n).toBe(0);

    const artifact = readFileSync(demo.artifactPath, "utf8");
    expect(artifact.startsWith(`${ARTIFACT_HEADER}\n`)).toBe(true);
    expect(artifact).toContain(MESSAGE_CANARY);
    expect(artifact).toContain(agreedLine);
    const ignored = execFileSync("git", ["check-ignore", "-q", demo.artifactPath], { encoding: "utf8" });
    expect(ignored).toBe("");
    for (const secret of demo.secrets) {
      expect(secret.length).toBeGreaterThan(16);
      expect(artifact).not.toContain(secret);
      expect(demo.serverLog).not.toContain(secret);
      expect(stdout).not.toContain(secret);
    }
  }, 30_000);
});
