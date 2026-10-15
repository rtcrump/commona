import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  BlockCategory,
  BlockLocation,
  HEALTH_NUMBER_PATTERN,
  ReasonCode,
  type AuthPrincipal,
} from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/index.js";
import { openDatabase } from "../../src/db.js";
import { createPrivacyFilter, type PrivacyFilter } from "../../src/guard/filter.js";
import { loadFixtures } from "../helpers/fixtures.js";

const pack = loadFixtures();
const ts = "2026-04-01T00:00:00.000Z";

function owner(ownerId: string): AuthPrincipal {
  return { kind: "owner", ownerId };
}

function openFilter(): { close: () => void; filter: PrivacyFilter; audit: ReturnType<typeof createAuditLog> } {
  const db = openDatabase(":memory:");
  const insert = db.prepare(
    "INSERT INTO owners (id, email, display_name, role) VALUES (?, ?, ?, 'participant')",
  );
  insert.run("O1", "o1@example.test", "Owner One");
  insert.run("O2", "o2@example.test", "Owner Two");
  const clock = { now: () => new Date(ts) };
  const audit = createAuditLog(db, clock);
  const filter = createPrivacyFilter(db, audit, clock);
  filter.ensureDefault("O1");
  filter.ensureDefault("O2");
  return {
    filter,
    audit,
    close: () => db.close(),
  };
}

describe("privacy filter", () => {
  it("blocks an owner's custom term and ignores another owner's term", () => {
    const { filter, close } = openFilter();
    const saved = filter.update(owner("O1"), "O1", { terms: ["zephyr-token"] });
    expect(saved.allowed).toBe(true);

    const own = filter.check("O1", { kind: "message", text: "see zephyr-token please" });
    expect(own.outcome).toBe("block");
    expect(own.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.Text });

    const byName = filter.check("O1", { kind: "file", fileName: "zephyr-token.txt", text: "clean note" });
    expect(byName.hits[0]?.location).toBe(BlockLocation.FileName);

    const byBody = filter.check("O1", { kind: "file", fileName: "clean.txt", text: "zephyr-token inside" });
    expect(byBody.hits[0]?.location).toBe(BlockLocation.FileBody);

    const other = filter.check("O2", { kind: "message", text: "see zephyr-token please" });
    expect(other).toEqual({ outcome: "allow", hits: [] });
    close();
  });

  it("holds a missing row and a corrupt row, and keeps an omitted pattern flag on", () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO owners (id, email, display_name, role) VALUES ('O1', 'o1@example.test', 'Owner One', 'participant')").run();
    const clock = { now: () => new Date(ts) };
    const audit = createAuditLog(db, clock);
    const filter = createPrivacyFilter(db, audit, clock);
    filter.ensureDefault("O1");

    db.prepare("DELETE FROM privacy_filters WHERE owner_id = 'O1'").run();
    expect(filter.check("O1", { kind: "message", text: "Ready for the next question." }).outcome).toBe("block");

    filter.ensureDefault("O1");
    db.prepare("UPDATE privacy_filters SET config_json = '{' WHERE owner_id = 'O1'").run();
    expect(filter.check("O1", { kind: "message", text: "Ready for the next question." }).outcome).toBe("block");

    db.prepare("UPDATE privacy_filters SET config_json = ? WHERE owner_id = 'O1'").run(
      JSON.stringify({ terms: [], patterns: {}, presets: [] }),
    );
    const health = pack.notesWithPatient.match(new RegExp(HEALTH_NUMBER_PATTERN))?.[0] ?? "";
    expect(health.length).toBeGreaterThan(0);
    const decision = filter.check("O1", { kind: "message", text: `number ${health}` });
    expect(decision.outcome).toBe("block");
    expect(decision.hits[0]?.category).toBe(BlockCategory.HealthNumber);
    db.close();
  });

  it("refuses an agent edit and audits it, and audits an owner's edit", () => {
    const { filter, audit, close } = openFilter();
    const agent: AuthPrincipal = { kind: "agent", ownerId: "O1", agentId: "A1" };
    const refused = filter.update(agent, "O1", { terms: ["zephyr-token"] });
    expect(refused).toEqual({ allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing });
    expect(filter.check("O1", { kind: "message", text: "zephyr-token" })).toEqual({ outcome: "allow", hits: [] });

    const other = filter.update(owner("O2"), "O1", { terms: ["zephyr-token"] });
    expect(other).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });

    const saved = filter.update(owner("O1"), "O1", { terms: ["zephyr-token"] });
    expect(saved.allowed).toBe(true);

    const rows = audit.listForOwner("O1", "O1");
    expect(rows.map((row) => ({ action: row.action, result: row.result, agentId: row.agentId }))).toEqual([
      { action: AuditAction.SettingChangeRefused, result: AuditResult.Refused, agentId: "A1" },
      { action: AuditAction.SettingChange, result: AuditResult.Ok, agentId: "owner:O1" },
    ]);
    expect(rows[0]?.detail.reasonCode).toBe(ReasonCode.AgentCannotChangeSharing);
    expect(rows[1]?.ownerId).toBe("O1");
    close();
  });

  it("blocks a fake patient name only when the Clarity preset is enabled", () => {
    const { filter, close } = openFilter();
    const name = pack.names[0] ?? "";
    expect(name.length).toBeGreaterThan(0);
    expect(filter.check("O1", { kind: "message", text: name }).outcome).toBe("allow");
    expect(filter.check("O1", { kind: "file", fileName: "notes.md", text: pack.notesWithPatient }).hits[0]?.category).toBe(
      BlockCategory.HealthNumber,
    );

    const enabled = filter.update(owner("O1"), "O1", { presets: ["clarity-demo"] });
    expect(enabled.allowed).toBe(true);
    const blocked = filter.check("O1", { kind: "message", text: name });
    expect(blocked.outcome).toBe("block");
    expect(blocked.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.Text });
    expect(filter.check("O2", { kind: "message", text: name }).outcome).toBe("allow");
    close();
  });

  it("does not block ordinary text, emoji, or accented names that are not on the list", () => {
    const { filter, close } = openFilter();
    filter.update(owner("O1"), "O1", { presets: ["clarity-demo"] });
    const samples = [
      ...pack.normalMessages,
      "Ready for the next question. \u{1F44D}",
      "Ren\u00e9e Okonkwo sent the draft.",
      "Caf\u00e9 r\u00e9sum\u00e9 \u2014 na\u00efve fa\u00e7ade.",
      "All set \u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
    ];
    const blocked = samples.filter(
      (text) => filter.check("O1", { kind: "message", text }).outcome !== "allow",
    );
    expect(blocked).toEqual([]);
    const file = filter.check("O1", { kind: "file", fileName: "tree.md", text: pack.tree, metadata: {} });
    expect(file).toEqual({ outcome: "allow", hits: [] });
    expect(blocked.length).toBe(0);
    close();
  });
});
