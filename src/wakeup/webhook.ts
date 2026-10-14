import {
  ReasonCode,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_WAKE_ID,
  WAKE_WEBHOOK_TIMEOUT_MS,
  type WakeEvent,
} from "../../contract/index.js";

export interface WebhookSuccess {
  ok: true;
  httpStatus: number;
}

export interface WebhookFailure {
  ok: false;
  reasonCode: typeof ReasonCode.WebhookTimeout | typeof ReasonCode.WebhookHttp | typeof ReasonCode.WebhookNetwork;
  httpStatus?: number;
}

export type WebhookAttempt = WebhookSuccess | WebhookFailure;

export async function postWakeWebhook(args: {
  url: string;
  event: WakeEvent;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<WebhookAttempt> {
  const timeoutMs = args.timeoutMs ?? WAKE_WEBHOOK_TIMEOUT_MS;
  const fetchImpl = args.fetchImpl ?? fetch;
  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    return { ok: false, reasonCode: ReasonCode.WebhookNetwork };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { ok: false, reasonCode: ReasonCode.WebhookNetwork };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        [WAKE_HEADER_EVENT]: WAKE_EVENT_TYPE,
        [WAKE_HEADER_WAKE_ID]: args.event.wakeId,
        [WAKE_HEADER_ROOM_ID]: args.event.roomId,
      },
      body: JSON.stringify(args.event),
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, httpStatus: response.status };
    }
    return { ok: false, reasonCode: ReasonCode.WebhookHttp, httpStatus: response.status };
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, reasonCode: ReasonCode.WebhookTimeout };
    }
    return { ok: false, reasonCode: ReasonCode.WebhookNetwork };
  } finally {
    clearTimeout(timer);
  }
}
