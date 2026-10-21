import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,opacity] select-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-ink text-ink-foreground hover:opacity-85",
        secondary: "border border-border-strong bg-background text-foreground shadow-[0_1px_0_rgba(0,0,0,0.03)] hover:bg-hover",
        ghost: "text-muted-foreground hover:bg-hover hover:text-foreground",
        danger: "text-bad hover:bg-bad/10"
      },
      size: {
        sm: "h-7 px-2 text-[12.5px] [&_svg]:size-3.5",
        md: "h-8 px-3 text-[13px] [&_svg]:size-4",
        icon: "size-7 [&_svg]:size-4",
        "icon-sm": "size-6 [&_svg]:size-3.5"
      }
    },
    defaultVariants: { variant: "ghost", size: "md" }
  }
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = "button", ...props }, ref) => (
  <button ref={ref} type={type} className={cn(buttonVariants({ variant, size, className }))} {...props} />
));
Button.displayName = "Button";

export const IconButton = React.forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(({ label, className, size = "icon", ...props }, ref) => (
  <Button ref={ref} aria-label={label} title={label} size={size} className={className} {...props} />
));
IconButton.displayName = "IconButton";
