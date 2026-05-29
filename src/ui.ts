import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentContext, buildTeamTimelineExport, createContextPack, deriveContextBlocks, renderContextPackOutput } from "./handoff.js";
import { openStore } from "./store.js";
import type { ContextBlock, ContextPack } from "./types.js";

const MAX_FILE_VIEW_BYTES = 512 * 1024;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

export type UiOptions = {
  host?: string;
  port?: number;
};

export type FileViewResult =
  | {
      ok: true;
      path: string;
      absolutePath: string;
      size: number;
      language: string;
      content: string;
      truncated: boolean;
      redacted?: boolean;
    }
  | {
      ok: false;
      path?: string;
      size?: number;
      error: string;
    };

export function isValidContextPackBody(body: Record<string, unknown>): boolean {
  return Boolean(parseContextPackBody(body));
}

export async function startUi(options: UiOptions = {}): Promise<void> {
  const host = options.host || "127.0.0.1";
  const requestedPort = options.port ?? 4377;
  const ports = options.port ? [requestedPort] : Array.from({ length: 11 }, (_, index) => requestedPort + index);

  for (const port of ports) {
    const server = createUiServer();
    const result = await listen(server, host, port);
    if (result.ok) {
      console.log(`ContextPool UI running at http://${host}:${port}`);
      return;
    }
    server.close();
    if (options.port || result.code !== "EADDRINUSE") {
      throw new Error(`Unable to start ContextPool UI on ${host}:${port}: ${result.code}`);
    }
  }

  throw new Error(`Unable to start ContextPool UI. Ports ${ports[0]}-${ports[ports.length - 1]} are already in use.`);
}

function createUiServer() {
  return createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
    }
  });
}

function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: error.code || error.message });
    });
    server.listen(port, host, () => {
      server.removeAllListeners("error");
      resolve({ ok: true });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const method = req.method || "GET";

  if (isMutatingMethod(method) && !isLocalRequest(req)) {
    return sendJson(res, 403, { error: "ContextPool UI only accepts local mutating requests" });
  }

  if (url.pathname === "/api/tasks") {
    const store = await openStore();
    try {
      return sendJson(res, 200, { tasks: store.listTasks() });
    } finally {
      store.close();
    }
  }

  if (url.pathname === "/api/handoffs") {
    const store = await openStore();
    try {
      return sendJson(res, 200, { handoffs: store.listHandoffPackets(url.searchParams.get("task") || undefined) });
    } finally {
      store.close();
    }
  }

  if (url.pathname === "/api/context-blocks") {
    const task = url.searchParams.get("task") || undefined;
    const store = await openStore();
    try {
      const handoffs = store.listHandoffPackets(task);
      const blocks = handoffs.flatMap(deriveContextBlocks);
      return sendJson(res, 200, { blocks });
    } finally {
      store.close();
    }
  }

  if (url.pathname === "/api/context-packs") {
    const store = await openStore();
    try {
      if (req.method === "GET") return sendJson(res, 200, { packs: store.listContextPacks() });
      if (req.method !== "POST") return sendJson(res, 405, { error: "Use GET or POST" });
      const body = await readJsonBody(req);
      const name = typeof body.name === "string" ? body.name : "Untitled context pack";
      const blocks = Array.isArray(body.blocks) ? (body.blocks as ContextBlock[]) : [];
      const includeRawTranscript = body.includeRawTranscript === true;
      const explicitPack = parseContextPackBody(body);
      const pack = explicitPack || createContextPack(name, blocks, { includeRawTranscript });
      return sendJson(res, 200, { pack: store.saveContextPack({ ...pack, updatedAt: new Date().toISOString() }) });
    } finally {
      store.close();
    }
  }

  if (url.pathname.startsWith("/api/context-packs/") && url.pathname.endsWith("/export")) {
    const id = decodeURIComponent(url.pathname.replace("/api/context-packs/", "").replace("/export", ""));
    if (!id) return sendJson(res, 400, { error: "Missing context pack id" });
    const store = await openStore();
    try {
      const pack = store.getContextPackById(id);
      if (!pack) return sendJson(res, 404, { error: "Context pack not found" });
      const output = renderContextPackOutput(pack);
      return url.searchParams.get("format") === "markdown" ? sendText(res, output.markdown) : sendJson(res, 200, output);
    } finally {
      store.close();
    }
  }

  if (url.pathname.startsWith("/api/context-packs/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/context-packs/", ""));
    if (!id) return sendJson(res, 400, { error: "Missing context pack id" });
    const store = await openStore();
    try {
      if (req.method === "GET") {
        const pack = store.getContextPackById(id);
        return sendJson(res, pack ? 200 : 404, pack ? { pack } : { error: "Context pack not found" });
      }
      if (req.method === "DELETE") {
        return sendJson(res, store.deleteContextPack(id) ? 200 : 404, { ok: true });
      }
      if (req.method !== "PUT") return sendJson(res, 405, { error: "Use GET, PUT, or DELETE" });
      const body = await readJsonBody(req);
      const pack = parseContextPackBody(body);
      if (!pack || pack.id !== id) return sendJson(res, 400, { error: "Invalid context pack body" });
      return sendJson(res, 200, { pack: store.saveContextPack({ ...pack, updatedAt: new Date().toISOString() }) });
    } finally {
      store.close();
    }
  }

  if (url.pathname.startsWith("/api/handoffs/") && url.pathname.endsWith("/agent-context")) {
    const id = decodeURIComponent(url.pathname.replace("/api/handoffs/", "").replace("/agent-context", ""));
    if (!id) return sendJson(res, 400, { error: "Missing handoff id" });
    const store = await openStore();
    try {
      const handoff = store.getHandoffById(id);
      if (!handoff) return sendJson(res, 404, { error: "Handoff not found" });
      const context = buildAgentContext(handoff);
      return url.searchParams.get("format") === "json" ? sendJson(res, 200, context) : sendText(res, context.markdown);
    } finally {
      store.close();
    }
  }

  if (url.pathname.startsWith("/api/handoffs/") && url.pathname.endsWith("/team-export")) {
    const id = decodeURIComponent(url.pathname.replace("/api/handoffs/", "").replace("/team-export", ""));
    if (!id) return sendJson(res, 400, { error: "Missing handoff id" });
    const store = await openStore();
    try {
      const handoff = store.getHandoffById(id);
      if (!handoff) return sendJson(res, 404, { error: "Handoff not found" });
      const includeRawTranscript = url.searchParams.get("includeRawTranscript") === "true";
      return sendJson(res, 200, buildTeamTimelineExport(handoff, { includeRawTranscript }));
    } finally {
      store.close();
    }
  }

  if (url.pathname.startsWith("/api/handoffs/")) {
    const id = decodeURIComponent(url.pathname.replace("/api/handoffs/", ""));
    if (!id) return sendJson(res, 400, { error: "Missing handoff id" });
    const store = await openStore();
    try {
      const handoff = store.getHandoffById(id);
      return sendJson(res, handoff ? 200 : 404, handoff ? { handoff } : { error: "Handoff not found" });
    } finally {
      store.close();
    }
  }

  if (url.pathname === "/api/latest") {
    const store = await openStore();
    try {
      const handoff = store.getLatestHandoff(url.searchParams.get("task") || undefined);
      return sendJson(res, handoff ? 200 : 404, handoff ? { handoff } : { error: "No handoff found" });
    } finally {
      store.close();
    }
  }

  if (url.pathname === "/api/files/view") {
    if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" });
    const repoPath = url.searchParams.get("repoPath") || "";
    const filePath = url.searchParams.get("path") || "";
    if (!(await isKnownRepoPath(repoPath))) return sendJson(res, 403, { ok: false, error: "Repository path is not in saved handoffs" });
    const result = readRepoFileForView(repoPath, filePath);
    return sendJson(res, result.ok ? 200 : fileViewStatus(result.error), result);
  }

  if (url.pathname === "/api/files/open") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
    const body = await readJsonBody(req);
    const repoPath = typeof body.repoPath === "string" ? body.repoPath : "";
    const filePath = typeof body.path === "string" ? body.path : "";
    const line = typeof body.line === "number" ? body.line : undefined;
    const mode = body.mode === "reveal" ? "reveal" : "open";
    if (!(await isKnownRepoPath(repoPath))) return sendJson(res, 403, { ok: false, error: "Repository path is not in saved handoffs" });
    const safe = resolveSafeRepoPath(repoPath, filePath);
    if (!safe.ok) return sendJson(res, 400, { ok: false, error: safe.error });
    if (!existsSync(safe.path)) return sendJson(res, 404, { ok: false, error: "File does not exist on disk" });
    return sendJson(res, 200, openLocalFile(safe.path, line, mode));
  }

  if (trySendStaticAsset(url.pathname, res)) return;
  if (url.pathname === "/" || isHandoffPage(url.pathname)) return sendWebApp(res);

  sendJson(res, 404, { error: "Not found" });
}

function isHandoffPage(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 2 && parts[0] === "handoffs" && parts[1].length > 0;
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function isLocalRequest(req: Pick<IncomingMessage, "headers">): boolean {
  const host = normalizeHost(req.headers.host);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!host || !isLocalHostname(host.hostname)) return false;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return isLocalHostname(parsed.hostname) && (!parsed.port || !host.port || parsed.port === host.port);
  } catch {
    return false;
  }
}

function normalizeHost(value: string | string[] | undefined): { hostname: string; port: string } | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    const parsed = new URL(`http://${raw}`);
    return { hostname: parsed.hostname, port: parsed.port };
  } catch {
    return undefined;
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

async function isKnownRepoPath(repoPath: string): Promise<boolean> {
  if (!repoPath) return false;
  const requested = resolve(repoPath);
  const store = await openStore();
  try {
    return store.listHandoffPackets().some((handoff) => resolve(handoff.repo.repoPath) === requested);
  } finally {
    store.close();
  }
}

function sendWebApp(res: ServerResponse): void {
  const indexPath = join(webDistDir(), "index.html");
  if (existsSync(indexPath)) return sendHtml(res, readFileSync(indexPath, "utf8"));
  return sendHtml(
    res,
    `<!doctype html><html><head><title>ContextPool</title><style>body{font-family:ui-sans-serif,system-ui;margin:40px;color:#09090b}code{background:#f4f4f5;padding:2px 4px;border-radius:4px}</style></head><body><h1>ContextPool UI assets are not built</h1><p>Run <code>npm run build:web</code> or <code>npm run build</code>, then restart <code>ctxpool ui</code>.</p></body></html>`
  );
}

function trySendStaticAsset(pathname: string, res: ServerResponse): boolean {
  const extension = extname(pathname);
  if (!extension) return false;
  const root = webDistDir();
  const requested = resolve(root, `.${decodeURIComponent(pathname)}`);
  const rel = relative(root, requested);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(requested)) return false;
  const stats = statSync(requested);
  if (!stats.isFile()) return false;
  res.writeHead(200, { "content-type": contentType(extension) });
  createReadStream(requested).pipe(res);
  return true;
}

function webDistDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, "..", "dist-web");
}

function contentType(extension: string): string {
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

export function readRepoFileForView(repoPath: string, filePath: string): FileViewResult {
  const safe = resolveSafeRepoPath(repoPath, filePath);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (!existsSync(safe.path)) return { ok: false, path: filePath, error: "File does not exist on disk" };

  const stats = statSync(safe.path);
  if (!stats.isFile()) return { ok: false, path: filePath, error: "Path is not a file" };
  if (stats.size > MAX_FILE_VIEW_BYTES) {
    return { ok: false, path: filePath, size: stats.size, error: `File is larger than ${MAX_FILE_VIEW_BYTES} bytes` };
  }

  const buffer = readFileSync(safe.path);
  if (isBinaryFile(filePath, buffer)) return { ok: false, path: filePath, size: stats.size, error: "Binary files cannot be previewed" };

  const redacted = redactSensitivePreview(filePath, buffer.toString("utf8"));
  return {
    ok: true,
    path: filePath,
    absolutePath: safe.path,
    size: stats.size,
    language: languageForPath(filePath),
    content: redacted.content,
    truncated: false,
    redacted: redacted.redacted
  };
}

function fileViewStatus(error: string): number {
  if (/outside|Missing|Repository/.test(error)) return 400;
  if (/does not exist/.test(error)) return 404;
  if (/larger|Binary|not a file/.test(error)) return 415;
  return 400;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw new Error(`JSON body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseContextPackBody(body: Record<string, unknown>): ContextPack | undefined {
  if (typeof body.id !== "string" || typeof body.name !== "string" || !Array.isArray(body.items)) return undefined;
  const now = new Date().toISOString();
  const items = body.items.filter(isContextPackItem);
  if (items.length !== body.items.length) return undefined;
  return {
    id: body.id,
    name: body.name,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : now,
    includeRawTranscript: body.includeRawTranscript === true,
    items
  };
}

function isContextPackItem(value: unknown): value is ContextPack["items"][number] {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.blockId === "string" &&
    typeof item.order === "number" &&
    typeof item.enabled === "boolean" &&
    isContextBlock(item.block)
  );
}

function isContextBlock(value: unknown): value is ContextBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  const provenance = block.provenance as Record<string, unknown> | undefined;
  return (
    typeof block.id === "string" &&
    typeof block.sourceHandoffId === "string" &&
    typeof block.sourceTask === "string" &&
    typeof block.sourceCreatedAt === "string" &&
    isContextBlockCategory(block.category) &&
    typeof block.title === "string" &&
    typeof block.text === "string" &&
    typeof block.estimatedChars === "number" &&
    Boolean(provenance) &&
    isProvenanceKind(provenance?.kind) &&
    isConfidence(provenance?.confidence) &&
    typeof provenance?.source === "string"
  );
}

function isContextBlockCategory(value: unknown): value is ContextBlock["category"] {
  return (
    value === "intent" ||
    value === "instruction" ||
    value === "decision" ||
    value === "constraint" ||
    value === "verification" ||
    value === "risk" ||
    value === "next-action" ||
    value === "changed-file" ||
    value === "transcript"
  );
}

function isProvenanceKind(value: unknown): boolean {
  return value === "user-authored" || value === "transcript-derived" || value === "diff-derived" || value === "command-derived" || value === "ai-inferred";
}

function isConfidence(value: unknown): boolean {
  return value === "high" || value === "medium" || value === "low";
}

export function resolveSafeRepoPath(repoPath: string, filePath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!repoPath || !filePath) return { ok: false, error: "Missing repoPath or path" };
  const repo = resolve(repoPath);
  if (!existsSync(repo)) return { ok: false, error: "Repository path does not exist" };
  if (isAbsolute(filePath)) {
    const absoluteRelative = relative(repo, resolve(filePath));
    if (absoluteRelative.startsWith("..") || isAbsolute(absoluteRelative)) return { ok: false, error: "File is outside the repository" };
    return { ok: true, path: resolve(filePath) };
  }
  const fullPath = resolve(repo, filePath);
  const rel = relative(repo, fullPath);
  if (rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: "File is outside the repository" };
  return { ok: true, path: fullPath };
}

function isBinaryFile(path: string, buffer: Buffer): boolean {
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|woff2?|ttf|otf|mp4|mov|mp3|wasm|sqlite|db)$/i.test(path)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "jsx";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".md":
    case ".mdx":
      return "markdown";
    case ".sql":
      return "sql";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".sh":
      return "shell";
    default:
      return "text";
  }
}

function redactSensitivePreview(path: string, content: string): { content: string; redacted: boolean } {
  if (!/(^|\/)\.env(?:\.|$)|\.env\./i.test(path)) return { content, redacted: false };
  let redacted = false;
  const next = content.replace(/^(\s*(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|URL|DSN)[A-Z0-9_]*)\s*=\s*)(.+)$/gim, (_match, prefix: string, value: string) => {
    if (!value || value.trim() === "" || value.trim().startsWith("#")) return `${prefix}${value}`;
    redacted = true;
    return `${prefix}[redacted]`;
  });
  return { content: next, redacted };
}

function openLocalFile(path: string, line: number | undefined, mode: "open" | "reveal"): { ok: boolean; method?: string; error?: string } {
  const editor = process.env.CTXPOOL_EDITOR;
  const editorTarget = line ? `${path}:${line}` : path;
  const candidates =
    mode === "reveal"
      ? process.platform === "darwin"
        ? [{ cmd: "open", args: ["-R", path], method: "open -R" }]
        : [{ cmd: "xdg-open", args: [dirname(path)], method: "xdg-open parent" }]
      : [
          ...(editor ? [{ cmd: editor, args: [editorTarget], method: "CTXPOOL_EDITOR" }] : []),
          { cmd: "code", args: ["-g", editorTarget], method: "code -g" },
          { cmd: "cursor", args: ["-g", editorTarget], method: "cursor -g" },
          ...(process.platform === "darwin" ? [{ cmd: "open", args: [path], method: "open" }] : [{ cmd: "xdg-open", args: [path], method: "xdg-open" }])
        ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.cmd, candidate.args, { stdio: "ignore" });
    if (!result.error && (result.status === 0 || result.status === null)) return { ok: true, method: candidate.method };
  }
  return { ok: false, error: "No local opener succeeded" };
}
