import { listenDemo } from "../src/demo/node-listen.js";

const token = process.env.COMMONA_DEMO_ANALYTICS_TOKEN;
const env = token === undefined ? {} : { COMMONA_DEMO_ANALYTICS_TOKEN: token };
const server = await listenDemo(env, "127.0.0.1", 3010);
console.log(`public demo ${server.origin}`);
