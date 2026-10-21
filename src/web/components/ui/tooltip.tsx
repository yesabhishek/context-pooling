import * as React from "react";
import { cn } from "@/lib/utils";

export type TooltipState = { x: number; y: number; content: React.ReactNode } | undefined;

/** Pointer-following tooltip for charts, positioned inside a relative container and kept on-screen. */
export function ChartTooltip({ state, className }: { state: TooltipState; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [offset, setOffset] = React.useState({ left: 0, top: 0 });
  React.useLayoutEffect(() => {
    if (!state || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const parent = ref.current.offsetParent?.getBoundingClientRect();
    const width = box.width;
    const parentLeft = parent?.left || 0;
    let left = state.x + 12;
    if (parentLeft + left + width > window.innerWidth - 8) left = state.x - width - 12;
    if (parentLeft + left < 8) left = 8 - parentLeft;
    setOffset({ left, top: Math.max(0, state.y - box.height - 10) });
  }, [state]);
  if (!state) return null;
  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ left: offset.left, top: offset.top }}
      className={cn("pointer-events-none absolute z-30 min-w-[140px] rounded-lg border border-border-strong bg-background px-2.5 py-2 text-[12.5px] shadow-[0_8px_24px_rgba(0,0,0,0.14)]", className)}
    >
      {state.content}
    </div>
  );
}

/** Track an element's width for responsive SVG charts. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = React.useRef<T>(null);
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!ref.current) return;
    setWidth(ref.current.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
