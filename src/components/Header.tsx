import { useAppStore } from '../store/app'
import { Badge, Button } from './ui'

interface HeaderProps {
  onToggleLog: () => void
}

export function Header({ onToggleLog }: HeaderProps) {
  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const showDebug = useAppStore((state) => state.showDebug)

  const queued = jobs.filter((job) => job.status === 'queued').length
  const completed = jobs.filter((job) => job.status === 'completed').length
  const failed = jobs.filter((job) => job.status === 'error').length

  const status = processing
    ? { variant: 'info' as const, label: 'processing' }
    : failed > 0
      ? { variant: 'error' as const, label: `${failed} failed` }
      : queued > 0
        ? { variant: 'warn' as const, label: `${queued} queued` }
        : completed > 0
          ? { variant: 'success' as const, label: `${completed} done` }
          : { variant: 'default' as const, label: 'ready' }

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-[var(--color-surface-0)]/85 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent"
            aria-hidden="true"
          >
            <path d="M3 12c2.5-6 4.5-6 7 0s4.5 6 7 0 3.5-4 4-3" />
            <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          </svg>
          <span>
            <span className="block text-base leading-tight font-semibold tracking-tight">
              Hushwing Audio
            </span>
            <span className="block text-[11px] leading-tight text-[var(--color-ink-muted)]">
              local voice isolation · no uploads
            </span>
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleLog}
            aria-pressed={showDebug}
            aria-label="Toggle the diagnostic log"
          >
            {showDebug ? 'Hide log' : 'Show log'}
          </Button>
        </div>
      </div>
    </header>
  )
}
