// Terminal output: quiet, aligned, monochrome. Color only marks status. Plain text when piped or NO_COLOR is set.
import { homedir } from "node:os";

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY) && process.env.TERM !== "dumb";
}

const useColor = colorEnabled(process.stdout);
const useErrorColor = colorEnabled(process.stderr);

const sgr = (open: number, close: number, enabled = useColor) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);

export const style = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  green: sgr(32, 39),
  red: sgr(31, 39),
  yellow: sgr(33, 39)
};

const errorStyle = { bold: sgr(1, 22, useErrorColor), dim: sgr(2, 22, useErrorColor), red: sgr(31, 39, useErrorColor) };

export const glyph = {
  ok: style.green("✓"),
  fail: style.red("✗"),
  warn: style.yellow("!"),
  unknown: style.dim("?"),
  active: "●",
  idle: style.dim("○")
};

const INDENT = "  ";

export function width(): number {
  return Math.min(process.stdout.columns || 100, 100);
}

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(text: string): number {
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function pad(text: string, size: number): string {
  return text + " ".repeat(Math.max(0, size - visibleLength(text)));
}

export function print(lines: (string | undefined | false)[]): void {
  process.stdout.write(`\n${lines.filter((line): line is string => line !== undefined && line !== false).join("\n")}\n\n`);
}

export function heading(text: string, detail?: string): string {
  return `${INDENT}${style.bold(text)}${detail ? `  ${style.dim(detail)}` : ""}`;
}

/** Aligned label/value rows. Long values wrap under the value column. */
export function rows(pairs: [string, string | undefined][]): string[] {
  const present = pairs.filter((pair): pair is [string, string] => Boolean(pair[1]));
  const labelWidth = Math.max(...present.map(([label]) => label.length), 0) + 3;
  const valueWidth = Math.max(30, width() - INDENT.length - labelWidth);
  return present.flatMap(([label, value]) =>
    wrap(value, valueWidth).map((line, index) => `${INDENT}${index === 0 ? style.dim(pad(label, labelWidth)) : " ".repeat(labelWidth)}${line}`)
  );
}

/** Column-aligned table without borders. */
export function table(data: string[][]): string[] {
  const widths = data[0]?.map((_, column) => Math.max(...data.map((row) => visibleLength(row[column] || "")))) || [];
  return data.map((row) => INDENT + row.map((cell, column) => (column === row.length - 1 ? cell : pad(cell, widths[column] + 3))).join("").trimEnd());
}

export function line(text: string): string {
  return `${INDENT}${text}`;
}

export function note(text: string): string {
  return `${INDENT}${style.dim(text)}`;
}

export function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && visibleLength(current) + 1 + visibleLength(word) > max) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function printError(message: string, hint?: string): void {
  process.stderr.write(`\n${INDENT}${errorStyle.red("✗")} ${errorStyle.bold(message)}\n${hint ? `${INDENT}  ${errorStyle.dim(hint)}\n` : ""}\n`);
}

export function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric", year: days > 300 ? "numeric" : undefined });
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
