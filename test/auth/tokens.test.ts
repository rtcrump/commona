import { describe, expect, it } from "vitest";
import { hashToken } from "../../contract/index.js";
import { createTokenStore } from "../../src/auth/index.js";
import { openDatabase } from "../../src/db.js";
import { loadFixtures, seedFixtures } from "../helpers/fixtures.js";

describe("bearer tokens", () => {
  it("stores only the hash and authenticates the owner or agent", () => {
    const db = openDatabase(":memory:");
    seedFixtures(db, loadFixtures());
    const tokens = createTokenStore(db);
    const ownerToken = tokens.issueOwnerToken("O1");
    const agentToken = tokens.issueAgentToken("A1");

    expect(tokens.authenticate(ownerToken)).toEqual({ kind: "owner", ownerId: "O1" });
    expect(tokens.authenticate(agentToken)).toEqual({ kind: "agent", ownerId: "O1", agentId: "A1" });
    expect(tokens.authenticate("not-a-token")).toBeNull();

    const owner = db.prepare("SELECT token_hash FROM owners WHERE id = 'O1'").get() as { token_hash: string };
    const agent = db.prepare("SELECT token_hash FROM agents WHERE id = 'A1'").get() as { token_hash: string };
    expect(owner.token_hash).toBe(hashToken(ownerToken));
    expect(agent.token_hash).toBe(hashToken(agentToken));
    expect(owner.token_hash).not.toContain(ownerToken);
    expect(agent.token_hash).not.toContain(agentToken);
    db.close();
  });

  it("replaces an agent token and refuses unknown ids", () => {
    const db = openDatabase(":memory:");
    seedFixtures(db, loadFixtures());
    const tokens = createTokenStore(db);
    const first = tokens.issueAgentToken("AX");
    const second = tokens.issueAgentToken("AX");
    expect(tokens.authenticate(first)).toBeNull();
    const current = tokens.authenticate(second);
    expect(current).toEqual({ kind: "agent", ownerId: "O3", agentId: "AX" });
    expect(() => tokens.issueOwnerToken("nope")).toThrow(/unknown owner/);
    expect(() => tokens.issueAgentToken("nope")).toThrow(/unknown agent/);
    expect(() => tokens.issueNarrowToken("nope")).toThrow(/unknown owner/);
    db.close();
  });

  it("stores a narrow sharing key as a hash and leaves the owner token in place", () => {
    const db = openDatabase(":memory:");
    seedFixtures(db, loadFixtures());
    const tokens = createTokenStore(db);
    const ownerToken = tokens.issueOwnerToken("O1");
    const sharingKey = tokens.issueNarrowToken("O1");
    const replaced = tokens.issueNarrowToken("O1");

    expect(tokens.authenticate(ownerToken)).toEqual({ kind: "owner", ownerId: "O1" });
    expect(tokens.authenticate(sharingKey)).toBeNull();
    expect(tokens.authenticate(replaced)).toEqual({ kind: "narrow", ownerId: "O1" });

    const owner = db.prepare("SELECT token_hash FROM owners WHERE id = 'O1'").get() as { token_hash: string };
    const narrow = db.prepare("SELECT token_hash FROM owner_narrow_tokens WHERE owner_id = 'O1'").get() as {
      token_hash: string;
    };
    expect(owner.token_hash).toBe(hashToken(ownerToken));
    expect(narrow.token_hash).toBe(hashToken(replaced));
    expect(narrow.token_hash).not.toContain(replaced);
    expect(JSON.stringify(db.prepare("SELECT * FROM owner_narrow_tokens").all())).not.toContain(replaced);
    db.close();
  });
});
