import { cpSync } from "node:fs";

cpSync("web/onboarding", "dist/web/onboarding", { recursive: true });
