import * as React from "react"
import { cn } from "@/lib/utils"

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'
  size?: 'default' | 'sm' | 'lg' | 'icon'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    const baseClasses = "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none ring-offset-background"

    const variantClasses = {
      default: "bg-black text-white hover:bg-gray-800",
      destructive: "bg-red-500 text-white hover:bg-red-600",
      outline: "border border-gray-200 hover:bg-gray-100",
      secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200",
      ghost: "hover:bg-gray-100",
      link: "underline-offset-4 hover:underline text-blue-600",
    }

    const sizeClasses = {
      default: "h-10 py-2 px-4",
      sm: "h-9 px-3 rounded-md",
      lg: "h-11 px-8 rounded-md",
      icon: "h-10 w-10",
    }

    return (
      <button
        // eslint-disable-next-line security/detect-object-injection
        className={cn(baseClasses, variantClasses[variant], sizeClasses[size], className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
