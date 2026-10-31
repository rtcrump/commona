import { afterEach, describe, expect, it } from "vitest";
import { call, startJoinHarness, type JoinHarness } from "../onboarding/harness.js";
import { openRoomSharing } from "./fakes.js";

const FROM_OWNER_ONE = "Bring napkins";
const FROM_OWNER_TWO = "Bring forks";
const SPOOF_AGENT = "agent_spoofed";
const SPOOF_OWNER = "owner_spoofed";
const SPOOF_AGENT_NAME = "Spoofed Agent";
const SPOOF_OWNER_NAME = "Spoofed Owner";

describe("feed post author and owner", () => {
  let room: JoinHarness | undefined;

  afterEach(async () => {
    await room?.stop();
    room = undefined;
  });

  it("lets owner A tell which owner wrote each post, and ignores a spoofed author", async () => {
    room = await startJoinHarness();
    openRoomSharing(room.sharing, room.roomId, "O1", "O2");
    const ownerA = room.tokens.issueAgentToken("A1");
    const ownerB = room.tokens.issueAgentToken("A2");

    const postedA = await call(room.baseUrl, "POST", `/api/r/${room.roomId}`, {
      token: ownerA,
      json: spoofBody(FROM_OWNER_ONE, "A2", "O2"),
    });
    expect(postedA.status).toBe(201);
    expect(JSON.parse(postedA.body).post).toMatchObject({
      text: FROM_OWNER_ONE,
      authorAgentId: "A1",
      authorOwnerId: "O1",
      author: { id: "A1", displayName: "Agent One" },
      owner: { id: "O1", displayName: "Owner One" },
    });

    const postedB = await call(room.baseUrl, "POST", `/rooms/${room.roomId}/posts`, {
      token: ownerB,
      json: spoofBody(FROM_OWNER_TWO, "A1", "O1"),
    });
    expect(postedB.status).toBe(201);
    expect(JSON.parse(postedB.body).post).toMatchObject({
      text: FROM_OWNER_TWO,
      authorAgentId: "A2",
      authorOwnerId: "O2",
      author: { id: "A2", displayName: "Agent Two" },
      owner: { id: "O2", displayName: "Owner Two" },
    });

    const jsonFeed = await call(room.baseUrl, "GET", `/api/r/${room.roomId}`, { token: ownerA });
    expect(jsonFeed.status).toBe(200);
    const posts = (JSON.parse(jsonFeed.body) as { posts: FeedPost[] }).posts;
    expect(posts.map((post) => post.text).sort()).toEqual([FROM_OWNER_ONE, FROM_OWNER_TWO].sort());
    expect(postNamed(posts, FROM_OWNER_ONE)).toEqual({
      text: FROM_OWNER_ONE,
      author: { id: "A1", displayName: "Agent One" },
      owner: { id: "O1", displayName: "Owner One" },
    });
    expect(postNamed(posts, FROM_OWNER_TWO)).toEqual({
      text: FROM_OWNER_TWO,
      author: { id: "A2", displayName: "Agent Two" },
      owner: { id: "O2", displayName: "Owner Two" },
    });
    expect(posts[0]?.owner.id).not.toBe(posts[1]?.owner.id);

    const roomFeed = await call(room.baseUrl, "GET", `/rooms/${room.roomId}/feed`, { token: ownerA });
    expect(roomFeed.status).toBe(200);
    const items = (JSON.parse(roomFeed.body) as { items: FeedPost[] }).items;
    expect(postNamed(items, FROM_OWNER_ONE).owner).toEqual({ id: "O1", displayName: "Owner One" });
    expect(postNamed(items, FROM_OWNER_ONE).author).toEqual({ id: "A1", displayName: "Agent One" });
    expect(postNamed(items, FROM_OWNER_TWO).owner).toEqual({ id: "O2", displayName: "Owner Two" });
    expect(postNamed(items, FROM_OWNER_TWO).author).toEqual({ id: "A2", displayName: "Agent Two" });

    const stored = room.db
      .prepare("SELECT text, author_agent_id, author_owner_id FROM posts WHERE room_id = ? AND held = 0")
      .all(room.roomId) as { text: string; author_agent_id: string; author_owner_id: string }[];
    expect(stored).toEqual(
      expect.arrayContaining([
        { text: FROM_OWNER_ONE, author_agent_id: "A1", author_owner_id: "O1" },
        { text: FROM_OWNER_TWO, author_agent_id: "A2", author_owner_id: "O2" },
      ]),
    );

    const leaked = `${jsonFeed.body}\n${roomFeed.body}\n${postedA.body}\n${postedB.body}`;
    expect(leaked.includes(SPOOF_AGENT)).toBe(false);
    expect(leaked.includes(SPOOF_OWNER)).toBe(false);
    expect(leaked.includes(SPOOF_AGENT_NAME)).toBe(false);
    expect(leaked.includes(SPOOF_OWNER_NAME)).toBe(false);
  });
});

interface FeedPost {
  text: string;
  author: { id: string; displayName: string };
  owner: { id: string; displayName: string };
}

function spoofBody(text: string, authorAgentId: string, authorOwnerId: string): Record<string, unknown> {
  return {
    text,
    author: { id: SPOOF_AGENT, displayName: SPOOF_AGENT_NAME },
    owner: { id: SPOOF_OWNER, displayName: SPOOF_OWNER_NAME },
    authorAgentId,
    authorOwnerId,
  };
}

function postNamed(posts: FeedPost[], text: string): FeedPost {
  const found = posts.find((post) => post.text === text);
  if (!found) throw new Error(`missing post ${text}`);
  return found;
}
