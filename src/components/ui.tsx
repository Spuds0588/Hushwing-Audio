import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Allows semantic agent hooks such as `data-mcp-action="process-queue"`. */
  [dataAttribute: `data-${string}`]: unknown
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-[var(--color-ink-inverse)] hover:bg-accent-2 border-transparent',
  secondary:
    'bg-[var(--color-surface-2)] text-[var(--color-ink-0)] border-border hover:bg-[var(--color-surface-3)]',
  ghost:
    'bg-transparent text-[var(--color-ink-1)] border-transparent hover:bg-[var(--color-surface-2)]',
  danger: 'bg-[var(--color-warn)] text-white border-transparent hover:brightness-110',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl border font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface-0)]',
        'disabled:pointer-events-none disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      {...rest}
    />
  )
}

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div
      className={cx(
        'rounded-2xl border border-border bg-[var(--color-surface-1)] p-5',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

type BadgeVariant = 'default' | 'info' | 'success' | 'warn' | 'error'

const BADGE_VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-[var(--color-surface-3)] text-[var(--color-ink-2)]',
  info: 'bg-sky-500/15 text-sky-300',
  success: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
}

export function Badge({ variant = 'default', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        BADGE_VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

interface ProgressProps {
  value: number
  label?: string
  className?: string
}

export function Progress({ value, label, className }: ProgressProps) {
  const percent = Math.max(0, Math.min(100, value))
  return (
    <div className={cx('w-full', className)}>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-3)]"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      {label !== undefined && (
        <p className="mt-1 text-[11px] tabular-nums text-[var(--color-ink-muted)]">{label}</p>
      )}
    </div>
  )
}
