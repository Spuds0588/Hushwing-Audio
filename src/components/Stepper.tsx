import { WIZARD_STEPS, type WizardStep } from '../store/app'
import { cx } from './ui'

interface StepperProps {
  step: WizardStep
  /** Which steps can be jumped to right now, given what is in the queue. */
  canReach: (step: WizardStep) => boolean
  onSelect: (step: WizardStep) => void
}

/**
 * The wizard chrome. It is the only navigation in the studio, and it doubles as
 * the progress indicator: the current step is highlighted, finished steps are
 * ticked, and a step you cannot reach yet renders disabled rather than hidden —
 * so the shape of the flow is always visible.
 */
export function Stepper({ step, canReach, onSelect }: StepperProps) {
  const current = WIZARD_STEPS.findIndex((entry) => entry.id === step)

  return (
    <nav
      data-mcp-target="wizard-steps"
      aria-label="Studio steps"
      className="rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-2"
    >
      <ol className="flex flex-col gap-1 sm:flex-row sm:items-stretch">
        {WIZARD_STEPS.map((entry, index) => {
          const active = entry.id === step
          const done = index < current
          const enabled = canReach(entry.id)

          return (
            <li key={entry.id} className="flex-1">
              <button
                type="button"
                data-mcp-target="wizard-step"
                data-step={entry.id}
                data-state={active ? 'current' : done ? 'done' : 'later'}
                aria-current={active ? 'step' : undefined}
                disabled={!enabled}
                onClick={() => onSelect(entry.id)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                  active && 'bg-[var(--color-surface-3)]',
                  !active && enabled && 'hover:bg-[var(--color-surface-2)]',
                  !enabled && 'cursor-not-allowed opacity-45'
                )}
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums',
                    active
                      ? 'border-accent bg-accent text-[var(--color-ink-inverse)]'
                      : done
                        ? 'border-accent/60 text-accent'
                        : 'border-border text-[var(--color-ink-muted)]'
                  )}
                >
                  {done ? '✓' : index + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className={cx(
                      'block truncate text-sm font-medium',
                      active ? 'text-[var(--color-ink-0)]' : 'text-[var(--color-ink-1)]'
                    )}
                  >
                    {entry.label}
                  </span>
                  <span className="hidden truncate text-[11px] text-[var(--color-ink-muted)] sm:block">
                    {entry.hint}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
