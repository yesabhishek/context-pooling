import * as React from "react";
import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue | undefined>(undefined);

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
  className
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}) {
  const [internalValue, setInternalValue] = React.useState(defaultValue || "");
  const currentValue = value ?? internalValue;
  const setValue = React.useCallback(
    (next: string) => {
      setInternalValue(next);
      onValueChange?.(next);
    },
    [onValueChange]
  );

  return (
    <TabsContext.Provider value={{ value: currentValue, onValueChange: setValue }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" className={cn("inline-flex h-9 items-center gap-1 rounded-md bg-muted p-1", className)} {...props} />;
}

export function TabsTrigger({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const context = React.useContext(TabsContext);
  const selected = context?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => context?.onValueChange(value)}
      className={cn(
        "inline-flex h-7 items-center justify-center rounded px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
        selected && "bg-background text-foreground shadow-sm",
        className
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const context = React.useContext(TabsContext);
  if (context?.value !== value) return null;
  return <div className={cn("mt-3", className)}>{children}</div>;
}
