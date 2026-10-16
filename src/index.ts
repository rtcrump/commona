import { buildApp } from "./app.js";
import { startHostListener } from "./room/host.js";
import { defaultRuntime } from "./runtime.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const app = buildApp();
const runtime = defaultRuntime();
await app.listen({ port, host });
await startHostListener({
  db: runtime.db,
  clock: runtime.clock,
  tokens: runtime.tokens,
  audit: runtime.audit,
  sharing: runtime.sharing,
  guard: runtime.guard,
  notices: runtime.notices,
  ...(runtime.smtp ? { smtp: runtime.smtp } : {}),
  wakeQueue: runtime.wake,
});
