import type { HandoffListItem } from "../../types";
import { startOfDay } from "./format";

export type RangeKey = "7d" | "30d" | "90d" | "all";
export type TimeRange = { key: RangeKey; start: number; end: number; bucket: "day" | "week" };

const DAY = 86_400_000;
export const RANGE_OPTIONS: { value: RangeKey; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All time" }
];

export function resolveRange(key: RangeKey, handoffs: HandoffListItem[], now = Date.now()): TimeRange {
  const end = now;
  const days = key === "7d" ? 7 : key === "30d" ? 30 : key === "90d" ? 90 : 0;
  if (days) return { key, start: startOfDay(now - (days - 1) * DAY), end, bucket: days > 60 ? "week" : "day" };
  const first = handoffs.reduce((min, handoff) => Math.min(min, Date.parse(handoff.createdAt)), now);
  const start = startOfDay(Math.min(first, now - 6 * DAY));
  return { key, start, end, bucket: end - start > 60 * DAY ? "week" : "day" };
}

/** Prefer 30 days, but don't open on an empty dashboard when all work is older. */
export function defaultRange(handoffs: HandoffListItem[], now = Date.now()): RangeKey {
  const latest = handoffs.reduce((max, handoff) => Math.max(max, Date.parse(handoff.createdAt)), 0);
  if (!latest || now - latest < 30 * DAY) return "30d";
  return now - latest < 90 * DAY ? "90d" : "all";
}

export function inRange(handoff: HandoffListItem, range: TimeRange): boolean {
  const time = Date.parse(handoff.createdAt);
  return time >= range.start && time <= range.end;
}

export function buckets(range: TimeRange): number[] {
  const step = range.bucket === "week" ? 7 * DAY : DAY;
  const starts: number[] = [];
  for (let time = range.start; time <= range.end; time = startOfDay(time + step + 2 * 3_600_000)) starts.push(time);
  return starts;
}
