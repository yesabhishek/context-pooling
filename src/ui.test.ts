import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isLocalRequest, isValidContextPackBody, readRepoFileForView, startUi, type RunningUi } from "./ui.js";
import { isolateEnv, tempDir } from "./test-helpers.js";

describe("file preview", () => {
  it("reads text files and redacts .env values", () => {
    const repo = tempDir("viewer");
    writeFileSync(join(repo, "app.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, ".env.local"), "OPENAI_API_KEY=abc123\nPORT=3000\n");

    const result = readRepoFileForView(repo, "app.ts");
    const env = readRepoFileForView(repo, ".env.local");
    expect(result).toMatchObject({ ok: true, language: "typescript" });
    expect(env).toMatchObject({ ok: true, redacted: true });
    if (env.ok) expect(env.content).toBe("OPENAI_API_KEY=[redacted]\nPORT=3000\n");
  });

  it("refuses paths outside the repository, including through symlinks", () => {
    const repo = tempDir("viewer");
    const outside = tempDir("outside");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    writeFileSync(join(repo, "image.png"), Buffer.from([0, 1, 2]));
    mkdirSync(join(repo, "docs"));
    symlinkSync(join(outside, "secret.txt"), join(repo, "docs/link.txt"));

    expect(readRepoFileForView(repo, "../secret.txt").ok).toBe(false);
    expect(readRepoFileForView(repo, join(outside, "secret.txt")).ok).toBe(false);
    expect(readRepoFileForView(repo, "docs/link.txt").ok).toBe(false);
    expect(readRepoFileForView(repo, "image.png").ok).toBe(false);
  });
});

describe("request guards", () => {
  it("accepts only local hosts and same-origin requests", () => {
    expect(isLocalRequest({ headers: { host: "127.0.0.1:4377", origin: "http://127.0.0.1:4377" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "localhost:4377" } })).toBe(true);
    expect(isLocalRequest({ headers: { host: "127.0.0.1:4377", origin: "https://example.com" } })).toBe(false);
    expect(isLocalRequest({ headers: { host: "attacker.example:4377" } })).toBe(false);
    expect(isLocalRequest({ headers: { host: "127.0.0.1:4377", origin: "http://127.0.0.1:9999" } })).toBe(false);
  });

  it("validates context pack bodies", () => {
    expect(isValidContextPackBody({ id: "p", name: "Bad", items: [{ id: "i" }] })).toBe(false);
    expect(
      isValidContextPackBody({
        id: "p",
        name: "Good",
        items: [
          {
            id: "i",
            blockId: "b",
            order: 0,
            enabled: true,
            block: {
              id: "b",
              sourceHandoffId: "h",
              sourceTask: "t",
              sourceCreatedAt: "2026-10-19T00:00:00.000Z",
              category: "decision",
              title: "Decision",
              text: "Use packs.",
              provenance: { kind: "user-authored", confidence: "high", source: "test" },
              estimatedChars: 10
            }
          }
        ]
      })
    ).toBe(true);
  });
});

describe("server", () => {
  let ui: RunningUi;
  beforeAll(async () => {
    isolateEnv();
    ui = await startUi({ port: 0, fallback: false });
  });
  afterAll(() => ui.close());

  const request = (path: string, init: RequestInit & { host?: string } = {}) =>
    fetch(`${ui.url}${path}`, { ...init, headers: { ...(init.host ? { host: init.host } : {}), ...(init.headers as Record<string, string>) } });

  it("serves the API with security headers", async () => {
    const response = await request("/api/tasks");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ tasks: [] });
  });

  it("rejects cross-origin writes and non-JSON bodies", async () => {
    const crossOrigin = await request("/api/context-packs", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    const formPost = await request("/api/context-packs", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    const badJson = await request("/api/context-packs", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect([crossOrigin.status, formPost.status, badJson.status]).toEqual([403, 415, 400]);
  });

  it("creates and deletes a pack", async () => {
    const created = await request("/api/context-packs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "From test", blocks: [] }) });
    const { pack } = (await created.json()) as { pack: { id: string; name: string } };
    expect(pack.name).toBe("From test");
    expect((await request(`/api/context-packs/${pack.id}`, { method: "DELETE" })).status).toBe(200);
  });
});
