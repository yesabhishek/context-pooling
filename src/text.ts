// Small text helpers shared by the CLI, MCP server, and web UI. Keep this module free of Node imports.

/** Rough token estimate (~4 characters per token for English and code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncate(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function labelize(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
