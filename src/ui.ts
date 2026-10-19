import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentContext, buildTeamTimelineExport, deriveContextBlocks } from "./handoff.js";
import { createContextPack, renderContextPackOutput } from "./pack.js";
import { redactSecrets } from "./redact.js";
import { openStore } from "./store.js";
import type { ContextBlock, ContextPack } from "./types.js";
import { CtxError } from "./util.js";

const MAX_FILE_VIEW_BYTES = 512 * 1024;
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export type UiOptions = {
  host?: string;
  port?: number;
  /** Try the next ports when the requested one is busy. */
  fallback?: boolean;
};

export type RunningUi = {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
};

export type FileViewResult =
  | { ok: true; path: string; absolutePath: string; size: number; language: string; content: string; truncated: boolean; redacted?: boolean }
  | { ok: false; path?: string; size?: number; error: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function isValidContextPackBody(body: Record<string, unknown>): boolean {
  return Boolean(parseContextPackBody(body));
}

export async function startUi(options: UiOptions = {}): Promise<RunningUi> {
  const host = options.host || "127.0.0.1";
  const requestedPort = options.port ?? 4377;
  const ports = options.fallback === false ? [requestedPort] : Array.from({ length: 11 }, (_, index) => requestedPort + index);
  const allowedHosts = allowedHostnames(host);

  for (const port of ports) {
    const server = createServer((req, res) => {
      handle(req, res, allowedHosts).catch((error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : "Unknown error" });
        else res.end();
      });
    });
    const result = await listen(server, host, port);
    if (result.ok) {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      const displayHost = host.includes(":") ? `[${host}]` : host;
      return { url: `http://${displayHost}:${boundPort}`, host, port: boundPort, close: () => closeServer(server) };
    }
    if (result.code !== "EADDRINUSE" || ports.length === 1) {
      throw new CtxError(`Could not start the UI on ${host}:${port} (${result.code}).`, result.code === "EADDRINUSE" ? "Pick another port with --port." : undefined);
    }
  }
  throw new CtxError(`Ports ${ports[0]}–${ports[ports.length - 1]} are all in use.`, "Pick another port with --port.");
}

function listen(server: Server, host: string, port: number): Promise<{ ok: true } | { ok: false; code: string }> {
  return new Promise((resolvePromise) => {
    server.once("error", (error: NodeJS.ErrnoException) => resolvePromise({ ok: false, code: error.code || error.message }));
    server.listen(port, host, () => {
      server.removeAllListeners("error");
      resolvePromise({ ok: true });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.closeAllConnections?.();
    server.close(() => resolvePromise());
  });
}

// ---------------------------------------------------------------------------
// Routing

async function handle(req: IncomingMessage, res: ServerResponse, allowedHosts: Set<string>): Promise<void> {
  setSecurityHeaders(res);
  const url = new URL(req.url || "/", "http://localhost");
  const method = req.method || "GET";

  // Reject requests addressed to any other hostname. This blocks DNS-rebinding pages from reading local data.
  if (!isAllowedRequest(req, allowedHosts)) return sendJson(res, 403, { error: "Forbidden host or origin" });
  if (isMutatingMethod(method) && !isJsonRequest(req)) return sendJson(res, 415, { error: "Use Content-Type: application/json" });

  const path = url.pathname;
  const param = (prefix: string, suffix = "") => decodeURIComponent(path.slice(prefix.length, suffix ? -suffix.length : undefined));

  if (path === "/api/tasks") return withStore((store) => sendJson(res, 200, { tasks: store.listTasks() }));

  if (path === "/api/handoffs") {
    return withStore((store) => sendJson(res, 200, { handoffs: store.listHandoffPackets(url.searchParams.get("task") || undefined) }));
  }

  if (path === "/api/context-blocks") {
    return withStore((store) => sendJson(res, 200, { blocks: store.listHandoffPackets(url.searchParams.get("task") || undefined).flatMap(deriveContextBlocks) }));
  }

  if (path === "/api/context-packs") {
    if (method === "GET") return withStore((store) => sendJson(res, 200, { packs: store.listContextPacks() }));
    if (method !== "POST") return sendJson(res, 405, { error: "Use GET or POST" });
    const body = await readJsonBody(req);
    const explicit = parseContextPackBody(body);
    if (!explicit && Array.isArray(body.blocks) && !body.blocks.every(isContextBlock)) return sendJson(res, 400, { error: "Invalid context blocks" });
    const pack =
      explicit ||
      createContextPack(typeof body.name === "string" ? body.name : "Untitled pack", Array.isArray(body.blocks) ? (body.blocks as ContextBlock[]) : [], {
        includeRawTranscript: body.includeRawTranscript === true
      });
    return withStore((store) => sendJson(res, 200, { pack: store.saveContextPack({ ...pack, updatedAt: new Date().toISOString() }) }));
  }

  if (path.startsWith("/api/context-packs/") && path.endsWith("/export")) {
    const id = param("/api/context-packs/", "/export");
    return withStore((store) => {
      const pack = store.getContextPackById(id);
      if (!pack) return sendJson(res, 404, { error: "Context pack not found" });
      const output = renderContextPackOutput(pack);
      return url.searchParams.get("format") === "markdown" ? sendText(res, output.markdown) : sendJson(res, 200, output);
    });
  }

  if (path.startsWith("/api/context-packs/")) {
    const id = param("/api/context-packs/");
    if (method === "GET") {
      return withStore((store) => {
        const pack = store.getContextPackById(id);
        return sendJson(res, pack ? 200 : 404, pack ? { pack } : { error: "Context pack not found" });
      });
    }
    if (method === "DELETE") return withStore((store) => (store.deleteContextPack(id) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Context pack not found" })));
    if (method !== "PUT") return sendJson(res, 405, { error: "Use GET, PUT, or DELETE" });
    const pack = parseContextPackBody(await readJsonBody(req));
    if (!pack || pack.id !== id) return sendJson(res, 400, { error: "Invalid context pack body" });
    return withStore((store) => sendJson(res, 200, { pack: store.saveContextPack({ ...pack, updatedAt: new Date().toISOString() }) }));
  }

  if (path.startsWith("/api/handoffs/") && path.endsWith("/agent-context")) {
    const id = param("/api/handoffs/", "/agent-context");
    return withStore((store) => {
      const handoff = store.getHandoffById(id);
      if (!handoff) return sendJson(res, 404, { error: "Handoff not found" });
      const context = buildAgentContext(handoff);
      return url.searchParams.get("format") === "json" ? sendJson(res, 200, context) : sendText(res, context.markdown);
    });
  }

  if (path.startsWith("/api/handoffs/") && path.endsWith("/team-export")) {
    const id = param("/api/handoffs/", "/team-export");
    return withStore((store) => {
      const handoff = store.getHandoffById(id);
      if (!handoff) return sendJson(res, 404, { error: "Handoff not found" });
      return sendJson(res, 200, buildTeamTimelineExport(handoff, { includeRawTranscript: url.searchParams.get("includeRawTranscript") === "true" }));
    });
  }

  if (path.startsWith("/api/handoffs/")) {
    const id = param("/api/handoffs/");
    return withStore((store) => {
      const handoff = store.getHandoffById(id);
      return sendJson(res, handoff ? 200 : 404, handoff ? { handoff } : { error: "Handoff not found" });
    });
  }

  if (path === "/api/latest") {
    return withStore((store) => {
      const handoff = store.getLatestHandoff(url.searchParams.get("task") || undefined);
      return sendJson(res, handoff ? 200 : 404, handoff ? { handoff } : { error: "No handoff found" });
    });
  }

  if (path === "/api/files/view") {
    if (method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" });
    const repoPath = url.searchParams.get("repoPath") || "";
    if (!(await isKnownRepoPath(repoPath))) return sendJson(res, 403, { ok: false, error: "Repository is not in any saved handoff" });
    const result = readRepoFileForView(repoPath, url.searchParams.get("path") || "");
    return sendJson(res, result.ok ? 200 : fileViewStatus(result.error), result);
  }

  if (path === "/api/files/open") {
    if (method !== "POST") return sendJson(res, 405, { error: "Use POST" });
    const body = await readJsonBody(req);
    const repoPath = typeof body.repoPath === "string" ? body.repoPath : "";
    if (!(await isKnownRepoPath(repoPath))) return sendJson(res, 403, { ok: false, error: "Repository is not in any saved handoff" });
    const safe = resolveSafeRepoPath(repoPath, typeof body.path === "string" ? body.path : "");
    if (!safe.ok) return sendJson(res, 400, { ok: false, error: safe.error });
    if (!existsSync(safe.path)) return sendJson(res, 404, { ok: false, error: "File does not exist on disk" });
    const line = typeof body.line === "number" && Number.isInteger(body.line) && body.line > 0 ? body.line : undefined;
    return sendJson(res, 200, openLocalFile(safe.path, line, body.mode === "reveal" ? "reveal" : "open"));
  }

  if (path.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
  if (method !== "GET" && method !== "HEAD") return sendJson(res, 405, { error: "Use GET" });
  if (trySendStaticAsset(path, res)) return;
  return sendWebApp(res);
}

async function withStore(fn: (store: Awaited<ReturnType<typeof openStore>>) => void): Promise<void> {
  const store = await openStore();
  try {
    fn(store);
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Request guards

function allowedHostnames(boundHost: string): Set<string> {
  const hosts = new Set(LOOPBACK);
  if (boundHost === "0.0.0.0" || boundHost === "::") {
    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) hosts.add(address.address);
  } else {
    hosts.add(boundHost);
  }
  return hosts;
}

export function isLocalRequest(req: Pick<IncomingMessage, "headers">): boolean {
  return isAllowedRequest(req, LOOPBACK);
}

function isAllowedRequest(req: Pick<IncomingMessage, "headers">, allowed: Set<string>): boolean {
  const host = parseHost(req.headers.host);
  if (!host || !allowed.has(host.hostname)) return false;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return allowed.has(parsed.hostname) && (parsed.port || "80") === (host.port || "80");
  } catch {
    return false;
  }
}

function parseHost(value: string | string[] | undefined): { hostname: string; port: string } | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  try {
    const parsed = new URL(`http://${raw}`);
    return { hostname: parsed.hostname, port: parsed.port };
  } catch {
    return undefined;
  }
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isJsonRequest(req: IncomingMessage): boolean {
  if (req.method === "DELETE") return true;
  return /^application\/json\b/i.test(req.headers["content-type"] || "");
}

async function isKnownRepoPath(repoPath: string): Promise<boolean> {
  if (!repoPath) return false;
  const requested = resolve(repoPath);
  const store = await openStore();
  try {
    return store.listRepoPaths().some((path) => resolve(path) === requested);
  } finally {
    store.close();
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw new HttpError(413, `Body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

function parseContextPackBody(body: Record<string, unknown>): ContextPack | undefined {
  if (typeof body.id !== "string" || typeof body.name !== "string" || !Array.isArray(body.items)) return undefined;
  if (!body.items.every(isContextPackItem)) return undefined;
  const now = new Date().toISOString();
  return {
    id: body.id,
    name: body.name,
    createdAt: typeof body.createdAt === "string" ? body.createdAt : now,
    updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : now,
    includeRawTranscript: body.includeRawTranscript === true,
    items: body.items
  };
}

function isContextPackItem(value: unknown): value is ContextPack["items"][number] {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.blockId === "string" && typeof item.order === "number" && typeof item.enabled === "boolean" && isContextBlock(item.block);
}

const CATEGORIES = new Set(["intent", "instruction", "decision", "constraint", "verification", "risk", "next-action", "changed-file", "transcript"]);
const PROVENANCE = new Set(["user-authored", "transcript-derived", "diff-derived", "command-derived", "ai-inferred"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

function isContextBlock(value: unknown): value is ContextBlock {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  const provenance = (block.provenance || {}) as Record<string, unknown>;
  return (
    typeof block.id === "string" &&
    typeof block.sourceHandoffId === "string" &&
    typeof block.sourceTask === "string" &&
    typeof block.sourceCreatedAt === "string" &&
    CATEGORIES.has(block.category as string) &&
    typeof block.title === "string" &&
    typeof block.text === "string" &&
    typeof block.estimatedChars === "number" &&
    PROVENANCE.has(provenance.kind as string) &&
    CONFIDENCE.has(provenance.confidence as string) &&
    typeof provenance.source === "string"
  );
}

// ---------------------------------------------------------------------------
// Responses

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function sendText(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function sendWebApp(res: ServerResponse): void {
  const indexPath = join(webDistDir(), "index.html");
  const html = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : `<!doctype html><html><head><meta charset="utf-8"><title>ContextPool</title><style>body{font:15px/1.6 ui-sans-serif,system-ui;margin:15vh auto;max-width:34rem;padding:0 24px;color:#37352f}code{background:#f1f1ef;padding:2px 6px;border-radius:4px}</style></head><body><h1 style="font-weight:600;font-size:20px">UI assets are not built</h1><p>Run <code>npm run build</code>, then restart <code>ctxpool ui</code>.</p></body></html>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  });
  res.end(html);
}

function trySendStaticAsset(pathname: string, res: ServerResponse): boolean {
  const extension = extname(pathname);
  if (!extension) return false;
  const root = webDistDir();
  const requested = resolve(root, `.${decodeURIComponent(pathname)}`);
  const rel = relative(root, requested);
  if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(requested) || !statSync(requested).isFile()) return false;
  res.writeHead(200, {
    "content-type": contentType(extension),
    "cache-control": rel.startsWith("assets") ? "public, max-age=31536000, immutable" : "no-cache"
  });
  createReadStream(requested).pipe(res);
  return true;
}

function webDistDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-web");
}

function contentType(extension: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon"
  };
  return types[extension] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// File preview

export function readRepoFileForView(repoPath: string, filePath: string): FileViewResult {
  const safe = resolveSafeRepoPath(repoPath, filePath);
  if (!safe.ok) return { ok: false, error: safe.error };
  if (!existsSync(safe.path)) return { ok: false, path: filePath, error: "File does not exist on disk" };

  const stats = statSync(safe.path);
  if (!stats.isFile()) return { ok: false, path: filePath, error: "Path is not a file" };
  if (stats.size > MAX_FILE_VIEW_BYTES) return { ok: false, path: filePath, size: stats.size, error: `File is larger than ${MAX_FILE_VIEW_BYTES} bytes` };

  const buffer = readFileSync(safe.path);
  if (isBinaryFile(filePath, buffer)) return { ok: false, path: filePath, size: stats.size, error: "Binary files cannot be previewed" };

  const preview = redactPreview(filePath, buffer.toString("utf8"));
  return { ok: true, path: filePath, absolutePath: safe.path, size: stats.size, language: languageForPath(filePath), content: preview.content, truncated: false, redacted: preview.redacted };
}

/** Resolve `filePath` inside `repoPath`, following symlinks so a link cannot point outside the repository. */
export function resolveSafeRepoPath(repoPath: string, filePath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (!repoPath || !filePath) return { ok: false, error: "Missing repoPath or path" };
  const repo = resolve(repoPath);
  if (!existsSync(repo)) return { ok: false, error: "Repository path does not exist" };
  const target = isAbsolute(filePath) ? resolve(filePath) : resolve(repo, filePath);
  if (!isInside(target, repo)) return { ok: false, error: "File is outside the repository" };
  if (existsSync(target) && !isInside(realpathSync(target), realpathSync(repo))) return { ok: false, error: "File is outside the repository" };
  return { ok: true, path: target };
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function fileViewStatus(error: string): number {
  if (/does not exist/.test(error)) return 404;
  if (/larger|Binary|not a file/.test(error)) return 415;
  return 400;
}

function isBinaryFile(path: string, buffer: Buffer): boolean {
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|woff2?|ttf|otf|mp4|mov|mp3|wasm|sqlite|db)$/i.test(path)) return true;
  return buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
}

function languageForPath(path: string): string {
  const languages: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "jsx",
    ".json": "json",
    ".css": "css",
    ".html": "html",
    ".md": "markdown",
    ".mdx": "markdown",
    ".sql": "sql",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".toml": "toml",
    ".sh": "shell"
  };
  return languages[extname(path).toLowerCase()] || "text";
}

function redactPreview(path: string, content: string): { content: string; redacted: boolean } {
  let next = redactSecrets(content);
  if (/(^|\/)\.env(?:\.|$)/i.test(path)) {
    next = next.replace(/^(\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|URL|DSN)[A-Z0-9_]*\s*=\s*)(.+)$/gim, (match, prefix: string, value: string) =>
      value.trim() && !value.trim().startsWith("#") ? `${prefix}[redacted]` : match
    );
  }
  return { content: next, redacted: next !== content };
}

// Opening these with the OS handler would execute them; reveal them instead.
const EXECUTABLE = /\.(app|command|tool|terminal|sh|bash|zsh|scpt|applescript|workflow|pkg|dmg|exe|bat|cmd|ps1|msi|desktop|jar)$/i;

function openLocalFile(path: string, line: number | undefined, mode: "open" | "reveal"): { ok: boolean; method?: string; error?: string } {
  const editorTarget = line ? `${path}:${line}` : path;
  const reveal =
    process.platform === "darwin"
      ? [{ cmd: "open", args: ["-R", path], method: "open -R" }]
      : process.platform === "win32"
        ? [{ cmd: "explorer", args: [`/select,${path}`], method: "explorer" }]
        : [{ cmd: "xdg-open", args: [dirname(path)], method: "xdg-open" }];
  const editors = [
    ...(process.env.CTXPOOL_EDITOR ? [{ cmd: process.env.CTXPOOL_EDITOR, args: [editorTarget], method: "CTXPOOL_EDITOR" }] : []),
    { cmd: "cursor", args: ["-g", editorTarget], method: "cursor" },
    { cmd: "code", args: ["-g", editorTarget], method: "code" },
    { cmd: "zed", args: [editorTarget], method: "zed" }
  ];
  const systemOpen = EXECUTABLE.test(path)
    ? reveal
    : process.platform === "darwin"
      ? [{ cmd: "open", args: ["-t", path], method: "open -t" }]
      : process.platform === "win32"
        ? []
        : [{ cmd: "xdg-open", args: [path], method: "xdg-open" }];

  for (const candidate of mode === "reveal" ? reveal : [...editors, ...systemOpen]) {
    const result = spawnSync(candidate.cmd, candidate.args, { stdio: "ignore", timeout: 5_000 });
    if (!result.error && (result.status === 0 || result.status === null)) return { ok: true, method: candidate.method };
  }
  return { ok: false, error: "No editor or file opener succeeded" };
}
