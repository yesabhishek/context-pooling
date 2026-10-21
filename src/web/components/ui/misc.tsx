import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-background", className)} {...props} />;
}

export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 px-4 pt-3.5", className)}>
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-medium text-foreground">{title}</h2>
        {description && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "good" | "bad" | "warn" | "outline" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium [&_svg]:size-3",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "outline" && "border border-border text-muted-foreground",
        tone === "good" && "bg-good/12 text-good",
        tone === "bad" && "bg-bad/12 text-bad",
        tone === "warn" && "bg-warn/12 text-warn",
        className
      )}
      {...props}
    />
  );
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border-strong bg-background px-1 font-sans text-[10.5px] font-medium text-muted-foreground", className)}>{children}</kbd>;
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded bg-muted px-1 py-px font-mono text-[0.88em]", className)}>{children}</code>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 items-center rounded-md border border-border-strong bg-background p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-full rounded-[5px] px-2.5 text-[12.5px] font-medium transition-colors",
            value === option.value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-[13px] text-muted-foreground">
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("relative h-[18px] w-8 shrink-0 rounded-full transition-colors", checked ? "bg-ink" : "bg-border-strong")}
      >
        <span className={cn("absolute top-0.5 size-[14px] rounded-full bg-background shadow-sm transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
      </button>
      {label}
    </label>
  );
}

export function EmptyState({ icon, title, children, action, className }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-subtle text-muted-foreground [&_svg]:size-5">{icon}</div>}
      <h3 className="text-[14px] font-medium">{title}</h3>
      {children && <div className="mt-1 max-w-sm text-[13px] leading-5 text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block size-4 animate-spin rounded-full border-2 border-border-strong border-t-foreground", className)} />;
}

export function PageHeader({ title, description, actions, children }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{title}</h1>
          {description && <p className="mt-1 text-[13.5px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </header>
  );
}
