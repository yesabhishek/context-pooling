import type { VerificationStatus } from "./types.js";

// Test, type-check, lint, and build commands across common ecosystems.
const VERIFICATION_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\S+|typecheck|type-check|tsc|lint|build|check|verify|e2e|ci)\b`,
    String.raw`\b(?:npx|pnpm\s+exec|bunx)\s+(?:vitest|jest|tsc|eslint|playwright|biome|mocha)\b`,
    String.raw`(?:^|[\s;&|(])(?:vitest|jest|mocha|tsc|eslint)(?=$|[\s;&|)])`,
    String.raw`\bplaywright\s+test\b`,
    String.raw`\bbiome\s+(?:check|lint|ci)\b`,
    String.raw`\b(?:pytest|mypy|pyright|rspec|phpunit|golangci-lint)\b`,
    String.raw`\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
    String.raw`\bruff\s+check\b`,
    String.raw`\bcargo\s+(?:test|check|clippy|build|nextest)\b`,
    String.raw`\bgo\s+(?:test|vet|build)\b`,
    String.raw`\b(?:mvn|mvnw)\s+(?:test|verify|package)\b`,
    String.raw`\bgradlew?\s+(?:test|check|build)\b`,
    String.raw`\bswift\s+(?:test|build)\b`,
    String.raw`\bxcodebuild\b.*\b(?:test|build)\b`,
    String.raw`\bdotnet\s+(?:test|build)\b`,
    String.raw`\bmix\s+test\b`,
    String.raw`\bdeno\s+(?:test|check|lint)\b`,
    String.raw`\b(?:make|just)\s+(?:test|check|lint|ci|build)\b`
  ].join("|"),
  "i"
);

const FAILURE_MARKERS = /(?:\b[1-9]\d* (?:failed|failing|errors?)\b|^\s*FAIL\b|\bTests? failed\b|\berror TS\d+|\bBuild failed\b|\bERR!|\bpanicked at\b|\bAssertionError\b|^E\s{2,}|✗|✖|❌)/im;
const SUCCESS_MARKERS = /(?:\b\d+ passed\b|\ball tests passed\b|\bTests?:\s+\d+ passed|^\s*ok\b|\bPASS\b|\bBuild succeeded\b|\bbuilt in\b|✓|✔|\b0 errors?\b|Finished .*(?:test|dev|release))/im;

export function isVerificationCommand(command: string): boolean {
  return VERIFICATION_COMMAND.test(executablePart(command));
}

/** Drop heredoc bodies and quoted strings, which can mention commands without running them. */
function executablePart(command: string): string {
  return command.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, "").replace(/'[^']*'|"[^"]*"/g, "''");
}

/**
 * The checks inside a shell command, without `cd`, redirections, or output filters:
 * `cd app && npm test 2>&1 | tail -5; npm run lint` -> `npm test · npm run lint`.
 */
export function verificationLabel(command: string): string {
  const checks = command
    .replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, "")
    .split(/&&|\|\||;|\n/)
    .map((segment) =>
      segment
        .replace(/(?<!\|)\|(?!\|)[\s\S]*$/, "")
        .replace(/\s+\d?>>?\s*\S+|\s+\d?>&\d/g, "")
        .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "")
        .trim()
    )
    .filter((segment) => segment && isVerificationCommand(segment));
  return checks.length ? checks.join(" · ") : command.trim();
}

/** A stable key so repeated runs of the same checks supersede each other. */
export function verificationKey(command: string): string {
  return verificationLabel(command).replace(/\s+/g, " ").toLowerCase();
}

/** True when a pipeline's exit code comes from a filter (`| tail`), not from the command that matters. */
export function exitCodeIsMasked(command: string): boolean {
  if (/\bset -o pipefail\b|\bpipefail\b/.test(command)) return false;
  return /(?<!\|)\|(?!\|)\s*(?:tail|head|grep|rg|less|more|cat|tee|sed|awk|sort|uniq|wc|cut)\b/.test(command);
}

/**
 * Status for a finished command. Uses the exit code when it is trustworthy; for verification commands
 * whose exit code is masked by a pipe, falls back to pass/fail markers in the output.
 */
export function commandStatus(command: string, exitCode: number | undefined, output: string): VerificationStatus {
  if (exitCode === undefined) return "unknown";
  if (exitCode !== 0) return "failed";
  if (!exitCodeIsMasked(command) || !isVerificationCommand(command)) return "passed";
  if (FAILURE_MARKERS.test(output)) return "failed";
  if (SUCCESS_MARKERS.test(output)) return "passed";
  return "unknown";
}
