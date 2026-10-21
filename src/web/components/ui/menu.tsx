import * as React from "react";
import { cn } from "@/lib/utils";

type MenuProps = {
  trigger: (props: { open: boolean; toggle: () => void; ref: React.Ref<HTMLButtonElement> }) => React.ReactNode;
  children: (close: () => void) => React.ReactNode;
  align?: "start" | "end";
  className?: string;
};

/** A small popover menu. Closes on outside click, Escape, or picking an item. */
export function Menu({ trigger, children, align = "end", className }: MenuProps) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = Array.from(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") || []);
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((value) => !value), ref: button })}
      {open && (
        <div
          role="menu"
          className={cn(
            "animate-pop-in absolute top-[calc(100%+6px)] z-40 min-w-[240px] rounded-lg border border-border-strong bg-background p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]",
            align === "end" ? "right-0" : "left-0",
            className
          )}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, hint, onSelect, className }: { icon?: React.ReactNode; children: React.ReactNode; hint?: React.ReactNode; onSelect: () => void; className?: string }) {
  return (
    <button
      role="menuitem"
      onClick={onSelect}
      className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover focus-visible:outline-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground", className)}
    >
      {icon}
      <span className="min-w-0 flex-1 whitespace-nowrap">{children}</span>
      {hint !== undefined && <span className="shrink-0 pl-3 text-[12px] text-faint">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pb-1 pt-1.5 text-[11.5px] font-medium text-faint">{children}</div>;
}

export function MenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />;
}
