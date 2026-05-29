import * as React from "react";
import { X } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  onOpenChange,
  children,
  className
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  return (
    <div className={cn("fixed inset-0 z-40 bg-black/20", className)} onClick={() => onOpenChange(false)}>
      {children}
    </div>
  );
}

export function SheetContent({
  className,
  children,
  side = "right"
}: {
  className?: string;
  children: React.ReactNode;
  side?: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "h-full w-[min(520px,94vw)] bg-background shadow-xl",
        side === "right" ? "ml-auto border-l border-border" : "mr-auto border-r border-border",
        className
      )}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

export function SheetHeader({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex h-12 items-center justify-between border-b border-border px-4">
      <div className="text-sm font-semibold">{children}</div>
      <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close panel">
        <X />
      </Button>
    </div>
  );
}
