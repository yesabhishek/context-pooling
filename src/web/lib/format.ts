const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "4m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  if (ms < 14 * DAY) return `${Math.floor(ms / DAY)}d ago`;
  return shortDate(iso, now);
}

export function shortDate(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "Today", "Yesterday", weekday within a week, then a date. */
export function dayLabel(iso: string, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(Date.parse(iso))) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Date(iso).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

export function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}

export function percent(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

/** Quote a value for POSIX shells. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function tildePath(path: string, home?: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

export function splitPath(path: string): { dir: string; name: string } {
  const index = path.replace(/\/$/, "").lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}
