import * as React from "react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

type DropdownContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const DropdownContext = React.createContext<DropdownContextValue | undefined>(undefined);

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div className="relative inline-flex">{children}</div>
    </DropdownContext.Provider>
  );
}

export function DropdownMenuTrigger({ children }: { children: React.ReactNode }) {
  const context = React.useContext(DropdownContext);
  return (
    <Button type="button" variant="secondary" size="sm" onClick={() => context?.setOpen(!context.open)}>
      {children}
    </Button>
  );
}

export function DropdownMenuContent({ children, className }: { children: React.ReactNode; className?: string }) {
  const context = React.useContext(DropdownContext);
  if (!context?.open) return null;
  return <div className={cn("absolute right-0 top-9 z-30 w-44 rounded-md border border-border bg-popover p-1 shadow-md", className)}>{children}</div>;
}

export function DropdownMenuItem({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  const context = React.useContext(DropdownContext);
  return (
    <button
      type="button"
      className="flex h-8 w-full items-center rounded px-2 text-left text-sm text-foreground hover:bg-muted"
      onClick={() => {
        onClick?.();
        context?.setOpen(false);
      }}
    >
      {children}
    </button>
  );
}
