import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useAppStore } from '../store/app'
import { enqueueFile } from '../lib/pipeline'
import { ACCEPT_ATTRIBUTE } from '../lib/filekit'
import { MODEL_SPECS } from '../lib/models'
import { logger } from '../lib/logger'
import type { ModelId, OutputFormat } from '../types/hushwing'
import { Button, cx } from './ui'

interface UploadZoneProps {
  disabled?: boolean
  /** Called after files are added when `?autostart=true` is active. */
  onAutostart?: () => void
}

export function UploadZone({ disabled = false, onAutostart }: UploadZoneProps) {
  const model = useAppStore((state) => state.model)
  const outputFormat = useAppStore((state) => state.outputFormat)
  const autostart = useAppStore((state) => state.autostart)
  const setModel = useAppStore((state) => state.setModel)
  const setOutputFormat = useAppStore((state) => state.setOutputFormat)

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return

      const store = useAppStore.getState()
      for (const file of list) {
        enqueueFile(file, store.model, store.outputFormat)
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

  return (
    <div className="flex flex-col gap-5">
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
          'flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-5 py-10 text-center transition-colors',
          disabled && 'cursor-not-allowed opacity-60',
          dragOver
            ? 'border-accent bg-[var(--color-surface-2)]'
            : 'border-border bg-[var(--color-surface-1)]/50 hover:bg-[var(--color-surface-2)]/60'
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
            'flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-[var(--color-surface-2)] transition-colors',
            dragOver ? 'text-accent' : 'text-[var(--color-ink-muted)]'
          )}
          aria-hidden="true"
        >
          <svg
            width="26"
            height="26"
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

        <p className="text-sm font-medium text-[var(--color-ink-0)]">
          {dragOver ? 'Drop to add to the queue' : 'Drag and drop audio or video'}
        </p>
        <p className="text-xs text-[var(--color-ink-muted)]">
          WAV · MP3 · M4A · FLAC · OGG · MP4 · MOV · MKV · WEBM · AVI
        </p>

        <Button variant="secondary" size="sm" className="mt-1" disabled={disabled}>
          Browse files
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Model
          </span>
          <select
            data-mcp-target="model-selector"
            value={model}
            disabled={disabled}
            onChange={(event) => setModel(event.target.value as ModelId)}
            className="rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink-0)] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          >
            {MODEL_SPECS.map((spec) => (
              <option key={spec.id} value={spec.id} disabled={!spec.ready}>
                {spec.label}
                {spec.ready ? '' : ' — coming soon'}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-[var(--color-ink-muted)] uppercase">
            Export
          </span>
          <select
            data-mcp-target="output-format"
            value={outputFormat}
            disabled={disabled}
            onChange={(event) => setOutputFormat(event.target.value as OutputFormat)}
            className="rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink-0)] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
          >
            <option value="wav">Enhanced WAV (48 kHz)</option>
            <option value="video">Video with enhanced audio</option>
          </select>
        </label>
      </div>

      <p className="text-xs text-[var(--color-ink-muted)]">
        {autostart
          ? 'Autostart is on: adding files begins processing immediately.'
          : 'Nothing is uploaded. Files are read and processed inside this browser tab.'}
      </p>
    </div>
  )
}
