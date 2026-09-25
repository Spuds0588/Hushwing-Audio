import { useCallback, useRef, useState, type DragEvent } from 'react'
import { useAppStore } from '../store/app'
import { enqueueFile } from '../lib/pipeline'
import { ACCEPT_ATTRIBUTE } from '../lib/filekit'
import { logger } from '../lib/logger'
import { Button, cx } from './ui'

interface DropzoneProps {
  /** Starts the queue; only used when `?autostart=true` is on. */
  onAutostart: () => void
}

/**
 * The drop target — the first thing on the page, and the only way in.
 *
 * It never goes away: files added while a batch is draining land in the same
 * queue below, so there is no step to walk back to and no second list to keep in
 * sync with the first.
 */
export function Dropzone({ onAutostart }: DropzoneProps) {
  const processing = useAppStore((state) => state.processing)
  const autostart = useAppStore((state) => state.autostart)

  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

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
      if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files)
    },
    [addFiles]
  )

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          inputRef.current?.click()
        }
      }}
      aria-label="Add audio or video files to the queue"
      className={cx(
        'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors',
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
        Drop as many as you like — they queue up and process one at a time. WAV · MP3 · M4A · FLAC ·
        OGG · MP4 · MOV · MKV · WEBM · AVI
      </p>

      <Button variant="secondary" size="sm" className="mt-1">
        Browse files
      </Button>

      <p className="text-[11px] text-[var(--color-ink-muted)]">
        Video stays video · audio comes back as a 48 kHz WAV · nothing is uploaded
      </p>

      {autostart && (
        <p className="text-[11px] text-[var(--color-warn)]">
          Autostart is on: adding a file starts processing immediately.
        </p>
      )}

      {processing && (
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          A batch is running — anything you add joins the queue behind it.
        </p>
      )}
    </div>
  )
}
