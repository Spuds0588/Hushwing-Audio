import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Job, ModelId } from '../types/hushwing'
import { PreviewSession } from '../lib/preview'
import { formatDuration } from '../lib/filekit'
import { Badge, Button, Card, cx } from './ui'

interface AbPreviewProps {
  job: Job
  /** The source media to preview. The caller only mounts this for jobs that have one. */
  source: Blob
  /** The engine to audition. Changing it switches the live wet branch. */
  model: ModelId
  title?: string
  hint?: string
  /** Omit to render without a close control (step 2 keeps the audition pinned). */
  onClose?: () => void
}

/**
 * Pipeline B in the UI: play the source, then switch between the untouched
 * signal (A) and the live-processed signal (B) without stopping playback.
 */
export function AbPreview({ job, source, model, title, hint, onClose }: AbPreviewProps) {
  // Recreated only when the previewed file changes, so playback survives engine
  // switches (which are pushed into the running graph instead).
  const session = useMemo(
    () => new PreviewSession(source, model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [job.id, source]
  )

  const state = useSyncExternalStore(session.subscribe, session.getState)

  useEffect(() => {
    void session.load()
    return () => {
      void session.dispose()
    }
  }, [session])

  useEffect(() => {
    void session.setModel(model)
  }, [session, model])

  const position = state.duration > 0 ? state.currentTime / state.duration : 0

  return (
    <Card className="flex flex-col gap-4" data-mcp-target="ab-preview" data-preview-model={state.model}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
            {title ?? 'A/B preview'}
          </h2>
          <p className="mt-1 truncate text-xs text-[var(--color-ink-muted)]" title={job.sourceName}>
            {hint ?? `${job.sourceName} · ${formatDuration(state.duration || job.duration || 0)}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant={state.bypassed ? 'default' : 'success'}
            data-preview-mode={state.bypassed ? 'a' : 'b'}
          >
            {state.bypassed ? 'A · original' : 'B · enhanced'}
          </Badge>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} data-mcp-action="preview-close">
              Close
            </Button>
          )}
        </div>
      </div>

      <Waveform
        peaks={state.peaks}
        position={position}
        enhanced={!state.bypassed}
        onSeek={(ratio) => session.seek(ratio)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          data-mcp-action="preview-toggle-play"
          data-preview-status={state.status}
          disabled={state.status === 'loading'}
          onClick={() => {
            if (state.playing) session.pause()
            else void session.play()
          }}
        >
          {state.playing ? 'Pause' : state.status === 'loading' ? 'Loading…' : 'Play'}
        </Button>

        <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] p-1">
          <button
            type="button"
            data-mcp-action="preview-bypass"
            onClick={() => session.setBypassed(true)}
            aria-pressed={state.bypassed}
            className={cx(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              state.bypassed
                ? 'bg-[var(--color-surface-3)] text-[var(--color-ink-0)]'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink-0)]'
            )}
          >
            A · Before
          </button>
          <button
            type="button"
            data-mcp-action="preview-enhanced"
            onClick={() => session.setBypassed(false)}
            aria-pressed={!state.bypassed}
            className={cx(
              'rounded-md px-3 py-1 text-xs font-medium transition-colors',
              !state.bypassed
                ? 'bg-[var(--color-surface-3)] text-[var(--color-ink-0)]'
                : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink-0)]'
            )}
          >
            B · After
          </button>
        </div>

        <div className="flex min-w-[120px] flex-1 items-center gap-2">
          <span className="text-[11px] text-[var(--color-ink-muted)]">Level</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-3)]">
            <div
              data-preview-level
              className={cx(
                'h-full rounded-full transition-[width] duration-75',
                state.bypassed ? 'bg-[var(--color-ink-muted)]' : 'bg-accent'
              )}
              style={{ width: `${Math.round(state.level * 100)}%` }}
            />
          </div>
        </div>

        <span
          data-preview-position={state.currentTime.toFixed(2)}
          className="text-[11px] tabular-nums text-[var(--color-ink-muted)]"
        >
          {formatDuration(state.currentTime)} / {formatDuration(state.duration)}
        </span>
      </div>

      {state.status === 'error' && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Live preview unavailable: {state.error}. Batch processing still works without it.
        </p>
      )}

      {state.status !== 'error' && state.note && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{state.note}</p>
      )}
    </Card>
  )
}

function Waveform({
  peaks,
  position,
  enhanced,
  onSeek,
}: {
  peaks: Float32Array | null
  position: number
  enhanced: boolean
  onSeek: (ratio: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const width = canvas.width
    const height = canvas.height
    context.clearRect(0, 0, width, height)

    if (!peaks || peaks.length === 0) {
      context.fillStyle = 'rgba(139, 152, 176, 0.35)'
      context.fillRect(0, height / 2 - 1, width, 2)
    } else {
      context.fillStyle = enhanced ? '#7fe6c4' : '#8b98b0'
      const barWidth = width / peaks.length
      for (let i = 0; i < peaks.length; i++) {
        const amplitude = Math.max(0.02, peaks[i]) * (height / 2 - 2)
        context.fillRect(
          i * barWidth,
          height / 2 - amplitude,
          Math.max(1, barWidth - 1),
          amplitude * 2
        )
      }
    }

    context.fillStyle = '#ffb347'
    const x = Math.max(0, Math.min(width - 2, position * width))
    context.fillRect(x, 0, 2, height)
  }, [peaks, position, enhanced])

  return (
    <canvas
      ref={canvasRef}
      width={720}
      height={128}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onSeek((event.clientX - rect.left) / rect.width)
      }}
      className="h-32 w-full cursor-pointer rounded-xl border border-border bg-black/30"
      aria-label="Waveform — click to seek"
    />
  )
}
