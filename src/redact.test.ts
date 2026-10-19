import { describe, expect, it } from "vitest";
import { isSensitivePath, redactSecrets } from "./redact.js";
import { commandStatus, isVerificationCommand, verificationLabel } from "./verify.js";

describe("redactSecrets", () => {
  it.each([
    ["OPENAI_API_KEY=abc123", "OPENAI_API_KEY=[redacted]"],
    ["key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here", "key [redacted-token] here"],
    ["ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123", "ANTHROPIC_API_KEY=[redacted-token]"],
    ["aws AKIAIOSFODNN7EXAMPLE", "aws [redacted-aws-key]"],
    ["ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab", "[redacted-token]"],
    ["postgres://admin:hunter2pass@db.internal:5432/app", "postgres://admin:[redacted]@db.internal:5432/app"],
    ['authToken: "q8Zp3LmN7vR2sT9wX4yB"', 'authToken: "[redacted]"'],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", "Authorization: Bearer [redacted]"]
  ])("redacts %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    "commit 8083c13e5f1d2c3b4a5968778899aabbccddeeff00",
    "session 01a15320-41c8-7c70-ad5b-f9198383e6d9",
    "src/web/components/ui/dropdown-menu.tsx",
    "const token = await getToken();",
    "password: z.string().min(8)",
    "tokenizer = buildTokenizer",
    "class ContextPoolAgentHandoffSummaryComponent2 {}"
  ])("leaves %s alone", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("recognizes files whose contents never belong in a handoff", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("apps/web/.env.local")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("src/env.ts")).toBe(false);
  });
});

describe("verification commands", () => {
  it("recognizes checks across ecosystems and ignores look-alikes", () => {
    for (const command of ["npm test", "pnpm run typecheck", "npx vitest run", "cargo clippy -- -D warnings", "go test ./...", "uv run pytest", "xcodebuild -scheme App test"]) {
      expect(isVerificationCommand(command), command).toBe(true);
    }
    for (const command of ["npm install", "cat vitest.config.ts", 'git commit -m "fix npm test"', "python3 - <<'EOF'\nprint('npm test')\nEOF"]) {
      expect(isVerificationCommand(command), command).toBe(false);
    }
  });

  it("labels compound commands by their checks", () => {
    expect(verificationLabel("cd app && CI=1 npm test 2>&1 | tail -20; npm run lint > lint.log")).toBe("npm test · npm run lint");
  });

  it("does not trust exit codes hidden behind a pipe", () => {
    expect(commandStatus("npm test | tail -5", 0, "Tests  1 failed | 3 passed")).toBe("failed");
    expect(commandStatus("npm test | tail -5", 0, "Tests  4 passed (4)")).toBe("passed");
    expect(commandStatus("npm test | tail -5", 0, "done")).toBe("unknown");
    expect(commandStatus("set -o pipefail; npm test | tail -5", 0, "")).toBe("passed");
    expect(commandStatus("npm test", 1, "")).toBe("failed");
  });
});
