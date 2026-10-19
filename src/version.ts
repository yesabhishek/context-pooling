import { createRequire } from "node:module";

// package.json sits one level above both src/ (dev) and dist/ (published).
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
