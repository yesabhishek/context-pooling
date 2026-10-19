import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { ContextPack, HandoffPacket, HandoffSummary } from "./types.js";
import { ensureCtxDirs, getCtxPaths } from "./paths.js";
import { normalizeHandoffPacket } from "./handoff.js";
import { normalizeContextPack } from "./pack.js";

type Row = Record<string, SQLInputValue>;

const SCHEMA_VERSION = 2;

let sqlite: Promise<typeof import("node:sqlite")> | undefined;

/**
 * Open the local store. Backed by SQLite in WAL mode, so the CLI, the UI server, and the MCP server
 * can read and write concurrently without clobbering each other.
 */
export async function openStore(dbPath = getCtxPaths().dbPath): Promise<CtxStore> {
  ensureCtxDirs();
  sqlite ||= importSqlite();
  const { DatabaseSync } = await sqlite;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  return new CtxStore(db);
}

/** node:sqlite prints an ExperimentalWarning on load in Node 22; keep CLI output clean. */
async function importSqlite(): Promise<typeof import("node:sqlite")> {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning.message;
    if (/SQLite is an experimental feature/i.test(message)) return;
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}

export class CtxStore {
  private open = true;

  constructor(private readonly db: DatabaseSync) {
    this.migrate();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }

  saveHandoff(packet: HandoffPacket): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO handoffs (
          id, task, created_at, repo_path, branch, commit_hash, markdown_path,
          next_best_action, blockers_json, files_json, status_json, packet_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        packet.id,
        packet.task,
        packet.createdAt,
        packet.repo.repoPath,
        packet.repo.branch,
        packet.repo.commit,
        packet.markdownPath,
        packet.sections.nextBestAction,
        JSON.stringify(packet.sections.blockers),
        JSON.stringify(packet.sections.filesTouched),
        JSON.stringify(packet.sections.currentStatus),
        JSON.stringify(packet)
      );
  }

  listTasks(): { task: string; handoffCount: number; latestAt: string }[] {
    return this.all(
      `SELECT task, COUNT(*) AS handoffCount, MAX(created_at) AS latestAt
       FROM handoffs GROUP BY task ORDER BY latestAt DESC`
    ).map((row) => ({ task: String(row.task), handoffCount: Number(row.handoffCount), latestAt: String(row.latestAt) }));
  }

  listHandoffs(task?: string): HandoffSummary[] {
    return this.handoffRows(task).map(rowToSummary);
  }

  listHandoffPackets(task?: string): HandoffPacket[] {
    return this.handoffRows(task).map(rowToPacket);
  }

  getLatestHandoff(task?: string): HandoffPacket | undefined {
    const row = task
      ? this.get("SELECT * FROM handoffs WHERE task = ? ORDER BY created_at DESC LIMIT 1", task)
      : this.get("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 1");
    return row ? rowToPacket(row) : undefined;
  }

  getHandoffById(id: string): HandoffPacket | undefined {
    const row = this.get("SELECT * FROM handoffs WHERE id = ? LIMIT 1", id);
    return row ? rowToPacket(row) : undefined;
  }

  listRepoPaths(): string[] {
    return this.all("SELECT DISTINCT repo_path FROM handoffs").map((row) => String(row.repo_path));
  }

  saveContextPack(pack: ContextPack): ContextPack {
    const normalized = normalizeContextPack({ ...pack, updatedAt: pack.updatedAt || new Date().toISOString() });
    this.db
      .prepare("INSERT OR REPLACE INTO context_packs (id, name, created_at, updated_at, pack_json) VALUES (?, ?, ?, ?, ?)")
      .run(normalized.id, normalized.name, normalized.createdAt, normalized.updatedAt, JSON.stringify(normalized));
    return normalized;
  }

  listContextPacks(): ContextPack[] {
    return this.all("SELECT * FROM context_packs ORDER BY updated_at DESC").map(rowToContextPack);
  }

  getContextPackById(id: string): ContextPack | undefined {
    const row = this.get("SELECT * FROM context_packs WHERE id = ? LIMIT 1", id);
    return row ? rowToContextPack(row) : undefined;
  }

  deleteContextPack(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM context_packs WHERE id = ?").run(id).changes) > 0;
  }

  getStatus(): { home: string; dbPath: string; teamExportsDir: string; handoffCount: number; taskCount: number; packCount: number } {
    const paths = getCtxPaths();
    const counts = this.get(
      `SELECT (SELECT COUNT(*) FROM handoffs) AS handoffs,
              (SELECT COUNT(DISTINCT task) FROM handoffs) AS tasks,
              (SELECT COUNT(*) FROM context_packs) AS packs`
    )!;
    return {
      home: paths.home,
      dbPath: paths.dbPath,
      teamExportsDir: paths.teamExportsDir,
      handoffCount: Number(counts.handoffs),
      taskCount: Number(counts.tasks),
      packCount: Number(counts.packs)
    };
  }

  private handoffRows(task?: string): Row[] {
    return task
      ? this.all("SELECT * FROM handoffs WHERE task = ? ORDER BY created_at DESC", task)
      : this.all("SELECT * FROM handoffs ORDER BY created_at DESC");
  }

  private migrate(): void {
    const version = Number(this.get("PRAGMA user_version")?.user_version || 0);
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        created_at TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        branch TEXT NOT NULL,
        commit_hash TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        next_best_action TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        status_json TEXT NOT NULL,
        packet_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_handoffs_task_created ON handoffs(task, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_handoffs_created ON handoffs(created_at DESC);
      CREATE TABLE IF NOT EXISTS context_packs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pack_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_context_packs_updated ON context_packs(updated_at DESC);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
}

function rowToSummary(row: Row): HandoffSummary {
  return {
    id: String(row.id),
    task: String(row.task),
    createdAt: String(row.created_at),
    repoPath: String(row.repo_path),
    branch: String(row.branch),
    commit: String(row.commit_hash),
    markdownPath: String(row.markdown_path),
    nextBestAction: String(row.next_best_action),
    blockers: parseJsonArray(String(row.blockers_json)),
    filesTouched: parseJsonArray(String(row.files_json)),
    status: parseJsonArray(String(row.status_json))
  };
}

function rowToPacket(row: Row): HandoffPacket {
  const packet = JSON.parse(String(row.packet_json)) as HandoffPacket;
  if (!packet.markdown && existsSync(String(row.markdown_path))) packet.markdown = readFileSync(String(row.markdown_path), "utf8");
  return normalizeHandoffPacket(packet);
}

function rowToContextPack(row: Row): ContextPack {
  const pack = JSON.parse(String(row.pack_json)) as ContextPack;
  return normalizeContextPack({ ...pack, id: String(row.id), name: String(row.name), createdAt: String(row.created_at), updatedAt: String(row.updated_at) });
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
