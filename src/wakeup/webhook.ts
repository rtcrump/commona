import {
  ContractError,
  ReasonCode,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_SIGNATURE,
  WAKE_HEADER_TIMESTAMP,
  WAKE_HEADER_WAKE_ID,
  WAKE_WEBHOOK_TIMEOUT_MS,
  assertWakeWebhookUrl,
  signWakeBody,
  type WakeEvent,
  type WakeWebhookUrlOptions,
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

/**
 * POST one wake.
 * The URL is checked again here, so a row that bypassed registration still cannot use plain http.
 * The body bytes that are signed are the body bytes that are sent.
 */
export async function postWakeWebhook(args: {
  url: string;
  event: WakeEvent;
  secret: string;
  timestamp: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  allowInsecureLocalhost?: boolean;
}): Promise<WebhookAttempt> {
  const options: WakeWebhookUrlOptions = { allowInsecureLocalhost: args.allowInsecureLocalhost === true };
  assertWakeWebhookUrl(args.url, options);
  if (args.secret.length === 0) {
    throw new ContractError("wake webhook signing secret is missing");
  }
  const timeoutMs = args.timeoutMs ?? WAKE_WEBHOOK_TIMEOUT_MS;
  const fetchImpl = args.fetchImpl ?? fetch;
  const rawBody = JSON.stringify(args.event);
  const signature = signWakeBody(args.secret, args.timestamp, rawBody);
  const target = new URL(args.url);

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
        [WAKE_HEADER_TIMESTAMP]: args.timestamp,
        [WAKE_HEADER_SIGNATURE]: signature,
      },
      body: rawBody,
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
