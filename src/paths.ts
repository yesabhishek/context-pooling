import { mkdirSync } from "node:fs";
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

export function ensureCtxDirs(paths = getCtxPaths()): CtxPaths {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.rawDir, { recursive: true });
  mkdirSync(paths.handoffsDir, { recursive: true });
  mkdirSync(paths.teamExportsDir, { recursive: true });
  return paths;
}
