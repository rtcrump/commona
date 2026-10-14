import { runAcceptance } from "../tests/acceptance/run.js";

const code = await runAcceptance();
process.exit(code);
