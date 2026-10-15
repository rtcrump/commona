import { describe, expect, it } from "vitest";
import {
  AuditAction,
  AuditResult,
  BlockCategory,
  BlockLocation,
  ReasonCode,
  systemClock,
  type AuthPrincipal,
} from "../../contract/index.js";
import { createAuditLog } from "../../src/audit/log.js";
import { openDatabase } from "../../src/db.js";
import {
  ensureDefaultFilter,
  updatePrivacyFilter,
  type FilterEditorDeps,
} from "../../src/guard/filter-store.js";
import { createPrivacyGuard } from "../../src/guard/index.js";
import { CLARITY_PRESET } from "../../src/guard/preset.js";
import { loadFixtures } from "../helpers/fixtures.js";

const pack = loadFixtures();
const listedName = pack.names[0] ?? "";
const term = "zephyrcode";

function owner(ownerId: string): AuthPrincipal {
  return { kind: "owner", ownerId };
}

function agent(ownerId: string, agentId: string): AuthPrincipal {
  return { kind: "agent", ownerId, agentId };
}

function setup() {
  const db = openDatabase(":memory:");
  const audit = createAuditLog(db, systemClock);
  const guard = createPrivacyGuard(db);
  const deps: FilterEditorDeps = { db, audit, clock: systemClock };
  return { db, audit, guard, deps };
}

describe("privacy filter", () => {
  it("blocks an owner's term and ignores another owner's term", () => {
    const { db, guard, deps } = setup();
    expect(updatePrivacyFilter(deps, owner("O1"), "O1", { terms: [term] }).allowed).toBe(true);
    ensureDefaultFilter(db, "O2");
    const own = guard.checkForOwner("O1", { kind: "message", text: `see ${term} today` });
    const other = guard.checkForOwner("O2", { kind: "message", text: `see ${term} today` });
    expect(own.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.Text });
    expect(JSON.stringify(own)).not.toContain(term);
    expect(other).toEqual({ outcome: "allow", hits: [] });
    db.close();
  });

  it("holds the item when the config is missing or corrupt", () => {
    const { db, guard } = setup();
    const missing = guard.checkForOwner("O1", { kind: "message", text: "ordinary hello" });
    expect(missing.outcome).toBe("block");
    db.prepare(
      `INSERT INTO privacy_filters (owner_id, terms_json, patterns_json, presets_json)
       VALUES ('O2', '{', '[]', '[]')`,
    ).run();
    const corrupt = guard.checkForOwner("O2", { kind: "message", text: "ordinary hello" });
    expect(corrupt.outcome).toBe("block");
    expect(JSON.stringify(corrupt)).not.toContain("ordinary hello");
    db.close();
  });

  it("refuses an agent edit and audits the refusal without storing the term", () => {
    const { db, audit, deps } = setup();
    ensureDefaultFilter(db, "O1");
    const before = db.prepare("SELECT terms_json FROM privacy_filters WHERE owner_id = 'O1'").get() as {
      terms_json: string;
    };
    const refused = updatePrivacyFilter(deps, agent("O1", "A1"), "O1", { terms: [term] });
    const after = db.prepare("SELECT terms_json FROM privacy_filters WHERE owner_id = 'O1'").get() as {
      terms_json: string;
    };
    expect(refused).toEqual({ allowed: false, reasonCode: ReasonCode.AgentCannotChangeSharing });
    expect(after).toEqual(before);
    const rows = audit.listForOwner("O1", "O1");
    expect(rows.some((row) => row.action === AuditAction.SettingChangeRefused && row.result === AuditResult.Refused)).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain(term);
    const other = updatePrivacyFilter(deps, owner("O2"), "O1", { terms: [term] });
    expect(other).toEqual({ allowed: false, reasonCode: ReasonCode.NotOwner });
    db.close();
  });

  it("audits an owner edit without writing the term into the log", () => {
    const { db, audit, deps } = setup();
    expect(updatePrivacyFilter(deps, owner("O1"), "O1", { terms: [term] })).toEqual({ allowed: true });
    const rows = audit.listForOwner("O1", "O1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: AuditAction.SettingChange,
      result: AuditResult.Ok,
      ownerId: "O1",
      detail: { fromOwnerId: "O1" },
    });
    expect(JSON.stringify(rows)).not.toContain(term);
    db.close();
  });

  it("blocks the invented patient name only when the Clarity preset is enabled", () => {
    const { db, guard, deps } = setup();
    ensureDefaultFilter(db, "O1");
    ensureDefaultFilter(db, "O2");
    expect(guard.checkForOwner("O1", { kind: "message", text: listedName }).outcome).toBe("allow");
    expect(updatePrivacyFilter(deps, owner("O1"), "O1", { preset: CLARITY_PRESET, enabled: true }).allowed).toBe(true);
    const blocked = guard.checkForOwner("O1", { kind: "message", text: `Please see ${listedName} today.` });
    expect(blocked.hits[0]).toEqual({ category: BlockCategory.Name, location: BlockLocation.Text });
    expect(guard.checkForOwner("O2", { kind: "message", text: listedName }).outcome).toBe("allow");
    db.close();
  });

  it("does not block ordinary text, emoji, or accented names that are not on the list", () => {
    const { db, guard, deps } = setup();
    ensureDefaultFilter(db, "O1");
    updatePrivacyFilter(deps, owner("O1"), "O1", { preset: CLARITY_PRESET, enabled: true });
    const samples = [
      ...pack.normalMessages,
      "Ship the note 🌿 today.",
      "José Exampleson sent the agenda.",
      "Renée Sample kept the accent.",
    ];
    for (const text of samples) {
      expect(guard.checkForOwner("O1", { kind: "message", text }).outcome).toBe("allow");
    }
    expect(
      guard.checkForOwner("O1", { kind: "file", fileName: "tree.md", text: pack.tree, metadata: {} }).outcome,
    ).toBe("allow");
    db.close();
  });
});
