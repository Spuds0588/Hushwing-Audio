import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useAppStore } from '../store/app'
import { enqueueFile } from '../lib/pipeline'
import { ACCEPT_ATTRIBUTE } from '../lib/filekit'
import { MODEL_SPECS, getModelSpec } from '../lib/models'
import { logger } from '../lib/logger'
import type { ModelId } from '../types/hushwing'
import { Button, cx } from './ui'

interface UploadZoneProps {
  disabled?: boolean
  /** Called after files are added when `?autostart=true` is active. */
  onAutostart?: () => void
}

/**
 * The whole start of the product: drop files, pick an engine. Nothing else.
 *
 * The output follows the source (video stays video, audio becomes a 48 kHz WAV),
 * so there is no format control — only the engine choice, which is a real decision.
 */
export function UploadZone({ disabled = false, onAutostart }: UploadZoneProps) {
  const model = useAppStore((state) => state.model)
  const autostart = useAppStore((state) => state.autostart)
  const setModel = useAppStore((state) => state.setModel)

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      const store = useAppStore.getState()
      for (const file of list) {
        enqueueFile(file, store.model)
      }

      logger.info(`added ${list.length} file(s) to the queue`)
      if (useAppStore.getState().autostart) onAutostart?.()
    },
    [onAutostart]
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragOver(false)
      if (disabled) return
      if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
    },
    [addFiles, disabled]
  )

  const spec = getModelSpec(model)

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => {
          if (!disabled) inputRef.current?.click()
        }}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onKeyDown={(event) => {
          if (disabled) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            inputRef.current?.click()
          }
        }}
        aria-label="Add audio or video files to the queue"
        className={cx(
          'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors',
          disabled && 'cursor-not-allowed opacity-60',
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
          {dragOver ? 'Drop to add to the queue' : 'Drag in your audio or video'}
        </p>
        <p className="max-w-md text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Drop as many as you like — they queue up and process one at a time. WAV · MP3 · M4A ·
          FLAC · OGG · MP4 · MOV · MKV · WEBM · AVI
        </p>

        <Button variant="secondary" size="sm" className="mt-1" disabled={disabled}>
          Browse files
        </Button>

        <p className="text-[11px] text-[var(--color-ink-muted)]">
          Video stays video · audio comes back as a 48 kHz WAV · nothing is uploaded
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-4 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-3">
          <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Engine
          </span>
          <select
            data-mcp-target="model-selector"
            value={model}
            disabled={disabled}
            onChange={(event) => setModel(event.target.value as ModelId)}
            className="rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink-0)] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          >
            {MODEL_SPECS.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.ready}>
                {option.label}
                {option.ready ? '' : ' — coming soon'}
              </option>
            ))}
          </select>
        </label>

        <p className="max-w-xl text-xs leading-relaxed text-[var(--color-ink-muted)]">
          {spec?.description}
          {autostart ? ' Autostart is on: adding files starts processing immediately.' : ''}
        </p>
      </div>
    </div>
  )
}
