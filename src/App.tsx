import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Header } from './components/Header'
import { UploadZone } from './components/UploadZone'
import { JobQueue } from './components/JobQueue'
import { DebugLog } from './components/DebugLog'
import { AbPreview } from './components/AbPreview'
import { Badge, Button, Progress } from './components/ui'
import { applyUrlParams, parseUrlParams, useAppStore } from './store/app'
import { isPending, purgeJobFiles, runJob, runQueue } from './lib/pipeline'
import { installHushwingAPI } from './lib/hushwing-api'
import { availableModelIds } from './lib/models'
import { preloadFFmpeg } from './lib/ffmpeg'
import { formatBytes, revokeMediaUrl } from './lib/filekit'
import { logger } from './lib/logger'
import { opfsSupported } from './lib/opfs'
import type { Job } from './types/hushwing'

/**
 * Hushwing Audio is one page, and that page is the studio: drop files, choose an
 * engine, watch the queue. There is no home page to get past and no output format
 * to choose — the output follows the source.
 */
export default function App() {
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)

  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const showDebug = useAppStore((state) => state.showDebug)
  const setShowDebug = useAppStore((state) => state.setShowDebug)

  /* Boot: URL parameters, headless API, capability report. */
  useEffect(() => {
    const params = parseUrlParams(window.location.search)
    applyUrlParams(params)
    installHushwingAPI()

    logger.info('Hushwing Audio booted')
    logger.info(
      `engine: ${availableModelIds().join(', ')} · OPFS ${opfsSupported() ? 'yes' : 'no'} · crossOriginIsolated ${
        window.crossOriginIsolated === true ? 'yes' : 'no'
      }`
    )
  }, [])

  /* Only pull the ~30 MB ffmpeg core once there is actually something to do. */
  const hasWork = jobs.length > 0
  useEffect(() => {
    if (hasWork) preloadFFmpeg()
  }, [hasWork])

  const handleProcessQueue = useCallback(() => {
    void runQueue()
  }, [])

  const handleRunJob = useCallback((jobId: string) => {
    void runJob(jobId).catch(() => undefined)
  }, [])

  const handleRemoveJob = useCallback((jobId: string) => {
    const job = useAppStore.getState().jobs.find((candidate) => candidate.id === jobId)
    if (job) {
      if (job.resultUrl) revokeMediaUrl(job.resultUrl)
      void purgeJobFiles(job)
    }
    useAppStore.getState().removeJob(jobId)
    setPreviewJobId((current) => (current === jobId ? null : current))
  }, [])

  const handleClearFinished = useCallback(() => {
    const finished = useAppStore
      .getState()
      .jobs.filter((job) => job.status === 'completed' || job.status === 'error')

    for (const job of finished) {
      if (job.resultUrl) revokeMediaUrl(job.resultUrl)
      void purgeJobFiles(job)
    }

    useAppStore.getState().clearFinished()
    setPreviewJobId(null)
  }, [])

  const previewJob = useMemo(
    () => jobs.find((job) => job.id === previewJobId) ?? null,
    [jobs, previewJobId]
  )

  return (
    <div className="min-h-screen bg-[var(--color-surface-0)] text-[var(--color-ink-0)] selection:bg-[var(--color-accent)]/30">
      <Header onToggleLog={() => setShowDebug(!showDebug)} />

      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-5"
        >
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Clean up any recording
              <span className="block text-[var(--color-ink-muted)]">
                without uploading a single byte
              </span>
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
              Drop in the files, pick an engine, and follow the queue. Everything runs in this tab —
              no account, no upload, no quota.
            </p>
          </div>

          <UploadZone disabled={processing} onAutostart={handleProcessQueue} />
        </motion.section>

        {jobs.length > 0 && (
          <BatchStatus
            jobs={jobs}
            processing={processing}
            onProcessQueue={handleProcessQueue}
          />
        )}

        {previewJob?.original && (
          <AbPreview
            job={previewJob}
            source={previewJob.original}
            onClose={() => setPreviewJobId(null)}
            onModelChange={(nextModel) =>
              useAppStore.getState().updateJob(previewJob.id, { model: nextModel })
            }
          />
        )}

        <JobQueue
          jobs={jobs}
          onRun={handleRunJob}
          onRemove={handleRemoveJob}
          onClearFinished={handleClearFinished}
          onPreview={(job: Job) => setPreviewJobId(job.id)}
        />

        <DebugLog open={showDebug} />
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-4 py-8 text-xs text-[var(--color-ink-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>Hushwing Audio — client-side voice isolation. Licensed under the terms in LICENSE.</p>
          <p>
            Capabilities for agents: <code>window.HushwingAPI</code> · <code>/mcp.json</code> ·{' '}
            <code>?debug=true</code>
          </p>
        </div>
      </footer>
    </div>
  )
}

/**
 * The one piece of chrome a long job needs: how far the batch has got, and the
 * button that starts it. Deliberately not a dashboard — nothing to configure.
 */
function BatchStatus({
  jobs,
  processing,
  onProcessQueue,
}: {
  jobs: Job[]
  processing: boolean
  onProcessQueue: () => void
}) {
  const pending = jobs.filter((job) => isPending(job) && job.status !== 'processing').length
  const active = jobs.find((job) => job.status === 'preparing' || job.status === 'processing')
  const finished = jobs.filter((job) => job.status === 'completed' || job.status === 'error').length
  const failed = jobs.filter((job) => job.status === 'error').length
  const rendered = jobs.reduce((total, job) => total + (job.outputSize ?? 0), 0)

  const overall = jobs.length
    ? Math.round(
        jobs.reduce(
          (sum, job) => sum + (job.status === 'completed' ? 100 : Math.min(job.progress, 99)),
          0
        ) / jobs.length
      )
    : 0

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-border bg-[var(--color-surface-1)] p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={processing ? 'info' : failed > 0 ? 'error' : 'success'}>
            {processing ? 'processing' : failed > 0 ? 'finished with errors' : 'done'}
          </Badge>
          <span className="text-sm text-[var(--color-ink-1)]">
            {finished} of {jobs.length} file{jobs.length === 1 ? '' : 's'}
            {rendered > 0 ? ` · ${formatBytes(rendered)} ready` : ''}
            {failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        </div>

        <Button
          data-mcp-action="process-queue"
          onClick={onProcessQueue}
          disabled={processing || pending === 0}
        >
          {processing
            ? 'Processing…'
            : pending > 0
              ? `Process ${pending} file${pending === 1 ? '' : 's'}`
              : 'All done'}
        </Button>
      </div>

      <div className="mt-4">
        <Progress value={overall} />
        <p className="mt-1.5 text-[11px] text-[var(--color-ink-muted)]">
          {active
            ? `${active.sourceName} · ${active.stage ?? 'working'} · ${Math.round(active.progress)}%`
            : `${overall}% of the batch`}
        </p>
      </div>
    </motion.section>
  )
}
