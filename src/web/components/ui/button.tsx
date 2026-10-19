import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-ink text-ink-foreground hover:opacity-90",
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
        outline: "border border-border text-foreground hover:bg-hover"
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2",
        icon: "size-7"
      }
    },
    defaultVariants: { variant: "ghost", size: "default" }
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />
));
Button.displayName = "Button";
