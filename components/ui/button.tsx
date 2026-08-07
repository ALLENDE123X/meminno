import * as React from "react"
import { cn } from "@/lib/utils"

export type ButtonVariant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
export type ButtonSize = 'default' | 'sm' | 'lg' | 'icon'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
}

const baseClasses = "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background"

// MEM-008: token-based, not hardcoded gray/black/blue — see app/globals.css
// for the actual coral-orange/charcoal/off-white values behind these
// classes. `default` is the one warm accent color; everything else is a
// neutral (border/muted) so the accent doesn't get diluted by competing
// "loud" colors on the same screen.
const variantClasses: Record<ButtonVariant, string> = {
  default: "bg-accent text-accent-foreground hover:bg-accent/90",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  outline: "border border-border bg-transparent text-foreground hover:bg-muted",
  secondary: "bg-muted text-foreground hover:bg-muted/80",
  ghost: "text-foreground hover:bg-muted",
  link: "underline-offset-4 hover:underline text-accent",
}

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-10 py-2 px-4",
  sm: "h-9 px-3 rounded-md",
  lg: "h-11 px-8 rounded-md",
  icon: "h-10 w-10",
}

// Exported so a non-<button> element that needs to look like a Button (most
// commonly an <a> used as a same-page nav/CTA link) can reuse the exact same
// classes without wrapping a real <button> inside an <a> — nesting
// interactive content like that is invalid HTML and an accessibility trap
// (browsers/AT disagree on how to handle a focusable button inside a
// focusable link). Prefer this over <a><Button>...</Button></a>.
export function buttonVariants({
  variant = 'default',
  size = 'default',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  // eslint-disable-next-line security/detect-object-injection -- variant/size are typed unions, not arbitrary input
  return cn(baseClasses, variantClasses[variant], sizeClasses[size], className)
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    return (
      <button
        className={buttonVariants({ variant, size, className })}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
