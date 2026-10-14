import {
  WAKE_EMAIL_FROM,
  WAKE_EVENT_TYPE,
  WAKE_HEADER_EVENT,
  WAKE_HEADER_ROOM_ID,
  WAKE_HEADER_WAKE_ID,
  activityOnlyText,
  wakeEmailSubject,
  type WakeEmail,
  type WakeEvent,
  type WakeFileContent,
  type WakeMessageContent,
} from "../../contract/index.js";

/**
 * Activity-only events omit `content` and `activity.itemKind`.
 * The contract specifies that omission so the recipient cannot tell a message from a file.
 */
export function wireWakeEvent(event: WakeEvent): WakeEvent {
  const base = {
    type: WAKE_EVENT_TYPE,
    wakeId: event.wakeId,
    roomId: event.roomId,
    occurredAt: event.occurredAt,
    round: event.round,
    author: { agentId: event.author.agentId, ownerId: event.author.ownerId },
    recipient: { agentId: event.recipient.agentId, ownerId: event.recipient.ownerId },
  };
  if (event.disclosure === "activity_only") {
    return {
      ...base,
      disclosure: "activity_only",
      activity: {},
    };
  }
  const wired: WakeEvent = {
    ...base,
    disclosure: "content",
    activity: {},
  };
  if (event.activity.itemKind === "message" || event.activity.itemKind === "file") {
    wired.activity = { itemKind: event.activity.itemKind };
  }
  if (event.content) wired.content = wireContent(event.content);
  return wired;
}

function wireContent(content: WakeMessageContent | WakeFileContent): WakeMessageContent | WakeFileContent {
  if (content.kind === "message") {
    return {
      kind: "message",
      itemId: content.itemId,
      text: content.text,
      replyToId: content.replyToId,
      round: content.round,
    };
  }
  const file: WakeFileContent = {
    kind: "file",
    itemId: content.itemId,
    name: content.name,
    mediaType: content.mediaType,
    byteLength: content.byteLength,
    metadata: { ...content.metadata },
  };
  if (content.textBody !== undefined) file.textBody = content.textBody;
  return file;
}

/**
 * Body of a wake email.
 * Activity-only text is the contract string. The contract does not define the content body;
 * a message uses its text, and a file uses a one-line description plus textBody when present.
 */
export function wakeEmailText(event: Pick<WakeEvent, "disclosure" | "roomId" | "content">): string {
  if (event.disclosure === "activity_only") return activityOnlyText(event.roomId);
  if (event.content?.kind === "message") return event.content.text;
  if (event.content?.kind === "file") {
    const file = event.content;
    const summary = `New file ${file.name} (${file.mediaType}, ${file.byteLength} bytes) in room ${event.roomId}.`;
    return file.textBody === undefined ? summary : `${summary}\n\n${file.textBody}`;
  }
  return activityOnlyText(event.roomId);
}

export function buildWakeEmail(event: WakeEvent, to: string): WakeEmail {
  const wired = wireWakeEvent(event);
  return {
    from: WAKE_EMAIL_FROM,
    to,
    subject: wakeEmailSubject(wired),
    text: wakeEmailText(wired),
    headers: {
      [WAKE_HEADER_EVENT]: WAKE_EVENT_TYPE,
      [WAKE_HEADER_WAKE_ID]: wired.wakeId,
      [WAKE_HEADER_ROOM_ID]: wired.roomId,
    },
    event: wired,
  };
}
