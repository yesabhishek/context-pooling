import * as React from "react";
import { cn } from "@/lib/utils";

/** Modal dialog with a scrim. Escape and scrim clicks close it; focus returns to where it was. */
export function Dialog({ open, onClose, children, className, label }: { open: boolean; onClose: () => void; children: React.ReactNode; className?: string; label: string }) {
  const panel = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    window.requestAnimationFrame(() => (panel.current?.querySelector<HTMLElement>("input, [data-autofocus], button") || panel.current)?.focus());
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1px] dark:bg-black/50" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn("animate-pop-in relative flex max-h-[76vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-strong bg-background shadow-[0_24px_80px_rgba(0,0,0,0.25)] outline-none", className)}
      >
        {children}
      </div>
    </div>
  );
}
