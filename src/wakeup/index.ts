import type { WakeEnqueueInput, WakeEvent, WakeQueue } from "../../contract/index.js";
import { todo } from "../todo.js";

/** T5 and T6. Webhook delivery, retry, email fallback, and the round cap. */
export const wakeQueue: WakeQueue = {
  enqueue(_input: WakeEnqueueInput): WakeEvent[] {
    return todo("wakeup");
  },
};
