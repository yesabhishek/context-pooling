import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CtxPaths = {
  home: string;
  dbPath: string;
  rawDir: string;
  handoffsDir: string;
  teamExportsDir: string;
  configPath: string;
};

export type CtxConfig = {
  version: 1;
  ui: { host: string; port: number };
  ollama: { enabled: boolean; model?: string };
};

export const DEFAULT_CONFIG: CtxConfig = {
  version: 1,
  ui: { host: "127.0.0.1", port: 4377 },
  ollama: { enabled: false }
};

export function getCtxPaths(): CtxPaths {
  const home = process.env.CTXPOOL_HOME || join(homedir(), ".ctxpool");
  return {
    home,
    dbPath: join(home, "ctxpool.db"),
    rawDir: join(home, "raw"),
    handoffsDir: join(home, "handoffs"),
    teamExportsDir: join(home, "team-exports"),
    configPath: join(home, "config.json")
  };
}

/** Create the store directories. They hold transcripts and diffs, so they are private to the user. */
export function ensureCtxDirs(paths = getCtxPaths()): CtxPaths {
  for (const dir of [paths.home, paths.rawDir, paths.handoffsDir, paths.teamExportsDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

/** Read config.json, falling back to defaults for anything missing or malformed. */
export function loadConfig(paths = getCtxPaths()): CtxConfig {
  if (!existsSync(paths.configPath)) return DEFAULT_CONFIG;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return DEFAULT_CONFIG;
  }
  const ui = (raw.ui || {}) as Record<string, unknown>;
  const ollama = (raw.ollama || {}) as Record<string, unknown>;
  return {
    version: 1,
    ui: {
      host: typeof ui.host === "string" && ui.host ? ui.host : DEFAULT_CONFIG.ui.host,
      port: typeof ui.port === "number" && Number.isInteger(ui.port) ? ui.port : DEFAULT_CONFIG.ui.port
    },
    ollama: {
      enabled: ollama.enabled === true,
      model: typeof ollama.model === "string" && ollama.model ? ollama.model : undefined
    }
  };
}
