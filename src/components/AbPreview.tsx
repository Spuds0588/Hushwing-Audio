import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { Job, ModelId } from '../types/hushwing'
import { PreviewSession } from '../lib/preview'
import { MODEL_SPECS } from '../lib/models'
import { formatDuration } from '../lib/filekit'
import { Badge, Button, Card, cx } from './ui'

interface AbPreviewProps {
  job: Job
  /** The source media to preview. The caller only mounts this for jobs that have one. */
  source: Blob
  onClose: () => void
  onModelChange: (model: ModelId) => void
}

/**
 * Pipeline B in the UI: play the source, then switch between the untouched
 * signal (A) and the live-processed signal (B) without stopping playback.
 */
export function AbPreview({ job, source, onClose, onModelChange }: AbPreviewProps) {
  // Recreated only when the previewed file changes, so playback survives model
  // switches (which are pushed into the worklet instead).
  const session = useMemo(
    () => new PreviewSession(source, job.model),
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

  const position = state.duration > 0 ? state.currentTime / state.duration : 0

  return (
    <Card className="mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
            A/B preview
          </h2>
          <p className="mt-1 truncate text-xs text-[var(--color-ink-muted)]" title={job.sourceName}>
            {job.sourceName} · {formatDuration(state.duration || job.duration || 0)} · checked with
            the live engine, not the rendered file
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant={state.bypassed ? 'default' : 'success'}
            data-preview-mode={state.bypassed ? 'a' : 'b'}
          >
            {state.bypassed ? 'A · original' : 'B · enhanced'}
          </Badge>
          <Button variant="ghost" size="sm" onClick={onClose} data-mcp-action="preview-close">
            Close
          </Button>
        </div>
      </div>

      <Waveform
        peaks={state.peaks}
        position={position}
        enhanced={!state.bypassed}
        onSeek={(ratio) => session.seek(ratio)}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
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

        <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
          <span>Live model</span>
          <select
            data-mcp-target="preview-model-selector"
            value={job.model}
            onChange={(event) => {
              const model = event.target.value as ModelId
              session.setModel(model)
              onModelChange(model)
            }}
            className="rounded-lg border border-border bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[var(--color-ink-0)] focus:border-accent focus:outline-none"
          >
            {MODEL_SPECS.filter((spec) => spec.ready).map((spec) => (
              <option key={spec.id} value={spec.id}>
                {spec.label}
              </option>
            ))}
          </select>
        </label>

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
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Live preview unavailable: {state.error}. Batch processing still works without it.
        </p>
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
