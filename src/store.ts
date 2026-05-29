import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic, type SqlValue } from "sql.js";
import type { ContextPack, HandoffPacket, HandoffSummary } from "./types.js";
import { ensureCtxDirs, getCtxPaths } from "./paths.js";
import { normalizeContextPack, normalizeHandoffPacket } from "./handoff.js";

type HandoffRow = {
  id: string;
  task: string;
  created_at: string;
  repo_path: string;
  branch: string;
  commit_hash: string;
  markdown_path: string;
  next_best_action: string;
  blockers_json: string;
  files_json: string;
  status_json: string;
  packet_json: string;
};

type ContextPackRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  pack_json: string;
};

let sqlModule: Promise<SqlJsStatic> | undefined;

export async function openStore(dbPath = getCtxPaths().dbPath): Promise<CtxStore> {
  ensureCtxDirs();
  sqlModule ||= initSqlJs({
    locateFile: (file) => {
      const require = createRequire(import.meta.url);
      return require.resolve(`sql.js/dist/${file}`);
    }
  });
  const SQL = await sqlModule;
  const db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  return new CtxStore(db, dbPath);
}

export class CtxStore {
  constructor(
    private db: Database,
    private dbPath: string
  ) {
    this.migrate();
  }

  close(): void {
    this.persist();
    this.db.close();
  }

  saveHandoff(packet: HandoffPacket): void {
    this.db.run(
      `
      INSERT OR REPLACE INTO handoffs (
        id, task, created_at, repo_path, branch, commit_hash, markdown_path,
        next_best_action, blockers_json, files_json, status_json, packet_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
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
      ]
    );
    this.persist();
  }

  listTasks(): { task: string; handoffCount: number; latestAt: string }[] {
    return this.queryRows(
      `
        SELECT task, COUNT(*) as handoffCount, MAX(created_at) as latestAt
        FROM handoffs
        GROUP BY task
        ORDER BY latestAt DESC
      `
    ) as { task: string; handoffCount: number; latestAt: string }[];
  }

  listHandoffs(task?: string): HandoffSummary[] {
    const rows = task
      ? (this.queryRows("SELECT * FROM handoffs WHERE task = ? ORDER BY created_at DESC", [task]) as HandoffRow[])
      : (this.queryRows("SELECT * FROM handoffs ORDER BY created_at DESC") as HandoffRow[]);
    return rows.map(rowToSummary);
  }

  listHandoffPackets(task?: string): HandoffPacket[] {
    const rows = task
      ? (this.queryRows("SELECT * FROM handoffs WHERE task = ? ORDER BY created_at DESC", [task]) as HandoffRow[])
      : (this.queryRows("SELECT * FROM handoffs ORDER BY created_at DESC") as HandoffRow[]);
    return rows.map(rowToPacket);
  }

  getLatestHandoff(task?: string): HandoffPacket | undefined {
    const rows = task
      ? (this.queryRows("SELECT * FROM handoffs WHERE task = ? ORDER BY created_at DESC LIMIT 1", [task]) as HandoffRow[])
      : (this.queryRows("SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 1") as HandoffRow[]);
    return rows[0] ? rowToPacket(rows[0]) : undefined;
  }

  getHandoffById(id: string): HandoffPacket | undefined {
    const rows = this.queryRows("SELECT * FROM handoffs WHERE id = ? LIMIT 1", [id]) as HandoffRow[];
    return rows[0] ? rowToPacket(rows[0]) : undefined;
  }

  saveContextPack(pack: ContextPack): ContextPack {
    const normalized = normalizeContextPack({
      ...pack,
      updatedAt: pack.updatedAt || new Date().toISOString()
    });
    this.db.run(
      `
      INSERT OR REPLACE INTO context_packs (
        id, name, created_at, updated_at, pack_json
      ) VALUES (?, ?, ?, ?, ?)
    `,
      [normalized.id, normalized.name, normalized.createdAt, normalized.updatedAt, JSON.stringify(normalized)]
    );
    this.persist();
    return normalized;
  }

  listContextPacks(): ContextPack[] {
    const rows = this.queryRows("SELECT * FROM context_packs ORDER BY updated_at DESC") as ContextPackRow[];
    return rows.map(rowToContextPack);
  }

  getContextPackById(id: string): ContextPack | undefined {
    const rows = this.queryRows("SELECT * FROM context_packs WHERE id = ? LIMIT 1", [id]) as ContextPackRow[];
    return rows[0] ? rowToContextPack(rows[0]) : undefined;
  }

  deleteContextPack(id: string): boolean {
    const before = Number((this.queryRows("SELECT COUNT(*) as count FROM context_packs WHERE id = ?", [id])[0] as { count: number }).count);
    this.db.run("DELETE FROM context_packs WHERE id = ?", [id]);
    this.persist();
    return before > 0;
  }

  getStatus(): { home: string; dbPath: string; teamExportsDir: string; handoffCount: number; taskCount: number } {
    const paths = getCtxPaths();
    const handoffCount = this.queryRows("SELECT COUNT(*) as count FROM handoffs")[0] as { count: number };
    const taskCount = this.queryRows("SELECT COUNT(DISTINCT task) as count FROM handoffs")[0] as { count: number };
    return {
      home: paths.home,
      dbPath: paths.dbPath,
      teamExportsDir: paths.teamExportsDir,
      handoffCount: Number(handoffCount.count),
      taskCount: Number(taskCount.count)
    };
  }

  private migrate(): void {
    this.db.run(`
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
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_handoffs_task_created
      ON handoffs(task, created_at DESC);
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS context_packs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        pack_json TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_context_packs_updated
      ON context_packs(updated_at DESC);
    `);
    this.persist();
  }

  private queryRows(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const stmt = this.db.prepare(sql, params);
    const rows: Record<string, SqlValue>[] = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  private persist(): void {
    writeFileSync(this.dbPath, this.db.export());
  }
}

function rowToSummary(row: HandoffRow): HandoffSummary {
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

function rowToPacket(row: HandoffRow): HandoffPacket {
  const packet = JSON.parse(String(row.packet_json)) as HandoffPacket;
  if (!packet.markdown && existsSync(String(row.markdown_path))) {
    packet.markdown = readFileSync(String(row.markdown_path), "utf8");
  }
  return normalizeHandoffPacket(packet);
}

function rowToContextPack(row: ContextPackRow): ContextPack {
  const pack = JSON.parse(String(row.pack_json)) as ContextPack;
  return normalizeContextPack({
    ...pack,
    id: String(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  });
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
