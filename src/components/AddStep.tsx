import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useAppStore } from '../store/app'
import { enqueueFile } from '../lib/pipeline'
import { ACCEPT_ATTRIBUTE, fileSizeOf, formatBytes } from '../lib/filekit'
import { logger } from '../lib/logger'
import { Badge, Button, cx } from './ui'

interface AddStepProps {
  /** Move on to the engine step. */
  onContinue: () => void
  onRemove: (jobId: string) => void
  /** Starts the queue; only used when `?autostart=true` is on. */
  onAutostart: () => void
}

/**
 * Step 1 — drop files, see exactly what landed, continue.
 *
 * Nothing else lives here on purpose: the engine choice is a whole step of its
 * own, and the progress UI does not exist until there is something to watch.
 */
export function AddStep({ onContinue, onRemove, onAutostart }: AddStepProps) {
  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const autostart = useAppStore((state) => state.autostart)

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const pending = jobs.filter((job) => job.status === 'queued')
  const totalSize = pending.reduce((sum, job) => sum + (job.original ? fileSizeOf(job.original) : 0), 0)

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      for (const file of list) enqueueFile(file, useAppStore.getState().model)

      logger.info(`added ${list.length} file(s) to the queue`)
      if (useAppStore.getState().autostart) onAutostart()
    },
    [onAutostart]
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragOver(false)
      if (processing) return
      if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
    },
    [addFiles, processing]
  )

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!processing) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (!processing) inputRef.current?.click()
        }}
        role="button"
        tabIndex={processing ? -1 : 0}
        aria-disabled={processing}
        onKeyDown={(event) => {
          if (processing) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        aria-label="Add audio or video files to the queue"
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors',
          processing && 'cursor-not-allowed opacity-60',
          dragOver
            ? 'border-accent bg-[var(--color-surface-2)]'
            : 'border-border bg-[var(--color-surface-1)]/50 hover:border-accent/60 hover:bg-[var(--color-surface-2)]/60'
        )}
      >
        <input
          ref={inputRef}
          data-mcp-action="upload"
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) addFiles(event.target.files)
            event.target.value = ''
          }}
        />

        <span
          className={cx(
            'flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-[var(--color-surface-2)] transition-colors',
            dragOver ? 'text-accent' : 'text-[var(--color-ink-muted)]'
          )}
          aria-hidden="true"
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </span>

        <p className="text-base font-medium text-[var(--color-ink-0)]">
          {dragOver ? 'Drop to add them' : 'Drag in your audio or video'}
        </p>
        <p className="max-w-md text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Drop as many as you like — they queue up and process one at a time. WAV · MP3 · M4A · FLAC
          · OGG · MP4 · MOV · MKV · WEBM · AVI
        </p>

        <Button variant="secondary" size="sm" className="mt-1" disabled={processing}>
          Browse files
        </Button>

        <p className="text-[11px] text-[var(--color-ink-muted)]">
          Video stays video · audio comes back as a 48 kHz WAV · nothing is uploaded
        </p>
      </div>

      {pending.length > 0 && (
        <div className="rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
              Ready to process
            </p>
            <span className="text-xs text-[var(--color-ink-muted)]">
              {pending.length} file{pending.length === 1 ? '' : 's'}
              {totalSize > 0 ? ` · ${formatBytes(totalSize)}` : ''}
            </span>
          </div>

          <ul
            data-mcp-target="added-files"
            className="mt-3 max-h-56 space-y-1 overflow-y-auto pr-1"
          >
            {pending.map((job) => (
              <li
                key={job.id}
                data-job-id={job.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-[var(--color-surface-2)]/60 px-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Badge>{job.sourceKind}</Badge>
                  <span
                    className="truncate text-xs text-[var(--color-ink-0)]"
                    title={job.sourceName}
                  >
                    {job.sourceName}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-[11px] tabular-nums text-[var(--color-ink-muted)]">
                    {job.original ? formatBytes(fileSizeOf(job.original)) : ''}
                  </span>
                  <button
                    type="button"
                    data-mcp-action="remove-file"
                    data-job-id={job.id}
                    onClick={() => onRemove(job.id)}
                    aria-label={`Remove ${job.sourceName}`}
                    className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink-0)]"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>

          {autostart && (
            <p className="mt-3 text-[11px] text-[var(--color-warn)]">
              Autostart is on: adding a file starts processing immediately.
            </p>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[11px] text-[var(--color-ink-muted)]">
              Files stay in this tab. Nothing is uploaded.
            </p>
            <Button data-mcp-action="wizard-next" onClick={onContinue}>
              Choose an engine →
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
