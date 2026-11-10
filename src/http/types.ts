import type { Context, Hono } from "hono";

export type AppEnv = { Variables: { parsedBody: unknown } };

export type AppContext = Context<AppEnv>;

export type CommonaHono = Hono<AppEnv>;
