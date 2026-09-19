import { useMemo, useState, useSyncExternalStore } from 'react'
import { clearLogs, downloadLogs, getLogsSnapshot, subscribeLogs } from '../lib/logger'
import { opfsSupported } from '../lib/opfs'
import { Badge, Button, Card, cx } from './ui'

const TAG_STYLE: Record<string, string> = {
  info: 'text-sky-300',
  debug: 'text-[var(--color-ink-muted)]',
  warn: 'text-amber-300',
  error: 'text-red-300',
}

export function DebugLog({ open }: { open: boolean }) {
  const logs = useSyncExternalStore(subscribeLogs, getLogsSnapshot)
  const [filter, setFilter] = useState<'all' | 'warn'>('all')

  const capabilities = useMemo(
    () => [
      { label: 'OPFS', ok: opfsSupported() },
      {
        label: 'AudioWorklet',
        ok: typeof AudioContext !== 'undefined' && 'audioWorklet' in AudioContext.prototype,
      },
      {
        label: 'SharedArrayBuffer',
        ok: typeof SharedArrayBuffer !== 'undefined',
      },
      {
        label: 'Cross-origin isolated',
        ok: typeof window !== 'undefined' && window.crossOriginIsolated === true,
      },
      {
        label: 'Web Workers',
        ok: typeof Worker !== 'undefined',
      },
    ],
    []
  )

  const visible = filter === 'all' ? logs : logs.filter((entry) => entry.tag !== 'info' && entry.tag !== 'debug')

  if (!open) return null

  return (
    <Card className="mt-8" aria-live="polite" data-mcp-target="diagnostics">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
            Diagnostics
          </h2>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Rolling log of {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}. Nothing here leaves your
            machine — download it if a job fails.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] p-1">
            {(['all', 'warn'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  filter === value
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-ink-0)]'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink-0)]'
                )}
              >
                {value === 'all' ? 'Everything' : 'Problems'}
              </button>
            ))}
          </div>

          <Button variant="ghost" size="sm" onClick={clearLogs}>
            Clear
          </Button>
          <Button variant="secondary" size="sm" onClick={downloadLogs}>
            Download .txt
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {capabilities.map((capability) => (
          <Badge key={capability.label} variant={capability.ok ? 'success' : 'default'}>
            {capability.label} {capability.ok ? '✓' : '✗'}
          </Badge>
        ))}
        <Badge variant="info">
          ffmpeg core {isFFmpegCoreLocal() ? 'local' : 'CDN'}
        </Badge>
      </div>

      <div className="max-h-80 overflow-auto rounded-xl border border-border bg-black/30 p-3 font-mono text-[11px] leading-relaxed">
        {visible.length === 0 ? (
          <p className="text-[var(--color-ink-muted)]">No log entries yet.</p>
        ) : (
          visible.map((entry, index) => (
            <div key={`${entry.time}-${index}`} className="break-words py-0.5">
              <span className="text-[var(--color-ink-muted)]">
                {new Date(entry.time).toLocaleTimeString()}
              </span>{' '}
              <span className={cx('uppercase', TAG_STYLE[entry.tag])}>{entry.tag}</span>{' '}
              <span className="break-all text-[var(--color-ink-1)]">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </Card>
  )
}

function isFFmpegCoreLocal(): boolean {
  return Boolean(import.meta.env.VITE_FFMPEG_CORE_BASE)
}
