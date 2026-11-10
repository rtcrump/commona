import demoCss from "../../web/demo/demo.css";
import replayScript from "../../web/demo/replay.txt";
import { installDemoAssets } from "./assets.js";
import { handleDemoRequest, type DemoEnv } from "./handler.js";

installDemoAssets({ css: demoCss, script: replayScript });

/**
 * Isolated public demo Worker. It has no directory binding and does not
 * import the private room Worker.
 */
export default {
  async fetch(request: Request, env: DemoEnv): Promise<Response> {
    return handleDemoRequest(request, env ?? {});
  },
};
