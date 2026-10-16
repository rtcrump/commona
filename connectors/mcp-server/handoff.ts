import type { ConnectorConfig } from "./config.js";

/**
 * Swap a one-time connect link for an agent credential.
 * The credential stays on the config object. Callers must not put it in a response or a log.
 */
export async function adoptHandoff(
  config: ConnectorConfig,
  handoff: string,
  roomId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<() => void> {
  if (!config.baseUrl) throw new Error("connector link is dead");
  const response = await fetchImpl(`${config.baseUrl}/connect/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ handoff, roomId }),
  });
  if (!response.ok) throw new Error("connector link is dead");
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("connector link is dead");
  }
  const body = asRecord(parsed);
  const credential = body.credential;
  const agentId = body.agentId;
  const boundRoom = body.roomId;
  if (typeof credential !== "string" || typeof agentId !== "string" || typeof boundRoom !== "string") {
    throw new Error("connector link is dead");
  }
  config.agentToken = credential;
  config.agentId = agentId;
  config.roomId = boundRoom;
  const arrived = await fetchImpl(`${config.baseUrl}/connect/arrive`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
  });
  if (!arrived.ok) throw new Error("connector link is dead");
  return startCheckInLoop(config, fetchImpl);
}

/**
 * How often to look for Check connection.
 * The page waits one second. This stays under that and does not follow the wake-spool interval.
 */
const CHECK_IN_MS = 200;

/**
 * While this connector is open, answer Check connection.
 * The answer is a check-in. It does not post to a room.
 */
export function startCheckInLoop(config: ConnectorConfig, fetchImpl: typeof fetch): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = CHECK_IN_MS;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const token = config.agentToken;
      if (token && config.baseUrl) {
        const pending = await fetchImpl(`${config.baseUrl}/connect/pending`, {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        if (stopped) return;
        if (pending.ok) {
          const payload = (await pending.json()) as { checkId?: unknown };
          if (!stopped && typeof payload.checkId === "string" && payload.checkId.length > 0) {
            await fetchImpl(`${config.baseUrl}/connect/check-in`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
                accept: "application/json",
              },
              body: JSON.stringify({ checkId: payload.checkId }),
            });
          }
        }
      }
    } catch {
      // A failed check-in stays quiet so a secret cannot reach a log.
    }
    arm();
  };

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("connector link is dead");
  }
  return value as Record<string, unknown>;
}
