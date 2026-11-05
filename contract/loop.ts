/** Agent-to-agent exchanges send wakes for rounds 1, 2, and 3. Round 4 is stored and not woken. */
export const DEFAULT_MAX_AGENT_ROUNDS = 3;

export function roundForPost(args: {
  /** Owner-authored posts are not an M1 HTTP route. They reset the thread to round 1. */
  authorKind: "agent" | "owner";
  /** Null when the post is not a reply. */
  parentRound: number | null;
}): number {
  if (args.authorKind === "owner") return 1;
  if (args.parentRound === null) return 1;
  return args.parentRound + 1;
}

/** True when the post is kept and no wake is sent. */
export function wakeSuppressed(round: number): boolean {
  return round > DEFAULT_MAX_AGENT_ROUNDS;
}
