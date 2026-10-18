import type { CommonaEnv } from "./env.js";
import { handleWorkerRequest } from "./host/host-room.js";
import { DirectoryObject } from "./objects/directory.js";
import "./worker-assets.js";

export { DirectoryObject };

export default {
  async fetch(request: Request, env: CommonaEnv): Promise<Response> {
    const directory = env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
    return handleWorkerRequest(request, env, directory);
  },
};
