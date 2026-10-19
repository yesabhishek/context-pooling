import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition-colors placeholder:text-faint focus:border-transparent focus:ring-2 focus:ring-ring",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";
