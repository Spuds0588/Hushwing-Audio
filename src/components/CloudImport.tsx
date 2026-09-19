import { useState } from 'react'
import { useAppStore } from '../store/app'
import { importFromUrl, pickFromGoogleDrive, pickFromOneDrive, cloudImportStatus } from '../lib/cloud-import'
import { logger } from '../lib/logger'
import { Button, Card } from './ui'

interface CloudImportProps {
  disabled?: boolean
  onImported?: () => void
}

export function CloudImport({ disabled = false, onImported }: CloudImportProps) {
  const model = useAppStore((state) => state.model)
  const outputFormat = useAppStore((state) => state.outputFormat)

  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const status = cloudImportStatus()

  const run = async (label: string, task: () => Promise<string | null>) => {
    setBusy(label)
    setError(null)
    setNote(null)

    try {
      const jobId = await task()
      if (jobId) {
        setNote(`Added to the queue (${label}).`)
        setUrl('')
        onImported?.()
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `${label} failed`
      logger.error(message)
      setError(message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
        Import
      </h3>
      <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
        Pull a file in from a direct link or a cloud drive. Enhanced results always download to this
        device — nothing is written back.
      </p>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault()
          if (!url.trim()) return
          void run('link', () => importFromUrl(url.trim(), { model, outputFormat }))
        }}
      >
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/interview.wav"
          disabled={disabled || busy !== null}
          aria-label="Media URL to import"
          className="min-w-0 flex-1 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink-0)] placeholder:text-[var(--color-ink-muted)] focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || busy !== null || !url.trim()}>
          {busy === 'link' ? 'Importing…' : 'Add link'}
        </Button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || busy !== null}
          onClick={() => void run('Google Drive', () => pickFromGoogleDrive({ model, outputFormat }))}
          title={status.drive ? 'Pick a file with the Google Picker' : 'Needs VITE_GOOGLE_CLIENT_ID'}
        >
          {busy === 'Google Drive' ? 'Opening Drive…' : 'Google Drive'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || busy !== null}
          onClick={() => void run('OneDrive', () => pickFromOneDrive({ model, outputFormat }))}
          title={status.oneDrive ? 'Pick a file with the OneDrive picker' : 'Needs VITE_ONEDRIVE_CLIENT_ID'}
        >
          {busy === 'OneDrive' ? 'Opening OneDrive…' : 'OneDrive'}
        </Button>
      </div>

      {!status.drive && !status.oneDrive && (
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
          Cloud pickers stay disabled until an OAuth client is configured: set{' '}
          <code className="text-[var(--color-ink-1)]">VITE_GOOGLE_CLIENT_ID</code> +{' '}
          <code className="text-[var(--color-ink-1)]">VITE_GOOGLE_API_KEY</code> for Drive, and{' '}
          <code className="text-[var(--color-ink-1)]">VITE_ONEDRIVE_CLIENT_ID</code> for OneDrive.
        </p>
      )}

      {note && <p className="mt-3 text-xs text-emerald-300">{note}</p>}
      {error && (
        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">{error}</p>
      )}
    </Card>
  )
}
