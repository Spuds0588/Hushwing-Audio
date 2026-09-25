import { useCallback, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Header } from './components/Header'
import { Dropzone } from './components/Dropzone'
import { EnginePicker } from './components/EnginePicker'
import { BatchProgress, JobQueue } from './components/JobQueue'
import { DebugLog } from './components/DebugLog'
import { Button } from './components/ui'
import { applyUrlParams, parseUrlParams, useAppStore } from './store/app'
import { purgeJobFiles, runJob, runQueue } from './lib/pipeline'
import { installHushwingAPI } from './lib/hushwing-api'
import { availableModelIds } from './lib/models'
import { mayNeedFfmpeg } from './lib/decode'
import { preloadFFmpeg } from './lib/ffmpeg'
import { fileSizeOf, formatBytes, revokeMediaUrl } from './lib/filekit'
import { logger } from './lib/logger'
import { opfsSupported } from './lib/opfs'
import { BUILD_MARKER } from './lib/build'

/**
 * Hushwing is one page: drop a file, pick an engine, watch the queue. Everything
 * needed at any moment is on screen at once, so there is no step to navigate and
 * nothing a drop can hide from the user.
 */
export default function App() {
  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const showDebug = useAppStore((state) => state.showDebug)
  const setShowDebug = useAppStore((state) => state.setShowDebug)

  /* Boot: URL parameters, headless API, capability report. */
  useEffect(() => {
    const params = parseUrlParams(window.location.search)
    applyUrlParams(params)
    installHushwingAPI()

    logger.info(`Hushwing booted · build ${BUILD_MARKER}`)
    logger.info(
      `engine: ${availableModelIds().join(', ')} · OPFS ${opfsSupported() ? 'yes' : 'no'} · crossOriginIsolated ${
        window.crossOriginIsolated === true ? 'yes' : 'no'
      }`
    )
  }, [])

  /*
   * Only pull the ~30 MB ffmpeg core for work that cannot be done without it.
   * An MP3, WAV, FLAC or Ogg-Opus job is decoded in JavaScript and never touches
   * it, so a queue of audio does not pay for a video tool it will not use.
   */
  const needsFFmpeg = jobs.some((job) => mayNeedFfmpeg(job.sourceName, job.sourceKind))
  useEffect(() => {
    if (needsFFmpeg) preloadFFmpeg()
  }, [needsFFmpeg])

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
  }, [])

  /** Wipe the queue (and the results it is holding in OPFS) and start again. */
  const handleStartOver = useCallback(() => {
    for (const job of useAppStore.getState().jobs) {
      if (job.resultUrl) revokeMediaUrl(job.resultUrl)
      void purgeJobFiles(job)
    }
    useAppStore.getState().resetQueue()
  }, [])

  const pending = jobs.filter((job) => job.status === 'queued')
  const pendingSize = pending.reduce(
    (sum, job) => sum + (job.original ? fileSizeOf(job.original) : 0),
    0
  )

  return (
    <div className="min-h-screen bg-[var(--color-surface-0)] text-[var(--color-ink-0)] selection:bg-[var(--color-accent)]/30">
      <Header onToggleLog={() => setShowDebug(!showDebug)} />

      <main
        data-mcp-target="studio"
        className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10"
      >
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Clean up any recording
          <span className="block text-[var(--color-ink-muted)]">
            without uploading a single byte
          </span>
        </h1>

        <Dropzone onAutostart={handleProcessQueue} />

        <EnginePicker />

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-4">
          <p className="text-xs text-[var(--color-ink-muted)]">
            {pending.length > 0
              ? `${pending.length} file${pending.length === 1 ? '' : 's'} queued${pendingSize > 0 ? ` · ${formatBytes(pendingSize)}` : ''} · one runs at a time`
              : 'Nothing is waiting. Add a file and press Process.'}
          </p>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={handleStartOver}
              data-mcp-action="start-over"
              disabled={jobs.length === 0}
            >
              Start over
            </Button>
            <Button
              data-mcp-action="process-queue"
              onClick={handleProcessQueue}
              disabled={processing || pending.length === 0}
            >
              {processing
                ? 'Processing…'
                : pending.length > 0
                  ? `Process ${pending.length} file${pending.length === 1 ? '' : 's'}`
                  : 'Process'}
            </Button>
          </div>
        </div>

        <motion.div
          key={jobs.length > 0 ? 'active' : 'empty'}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="flex flex-col gap-4"
        >
          {jobs.length > 0 && <BatchProgress jobs={jobs} processing={processing} />}

          <JobQueue
            jobs={jobs}
            onRun={handleRunJob}
            onRemove={handleRemoveJob}
            onClearFinished={handleClearFinished}
          />
        </motion.div>

        <DebugLog open={showDebug} />
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 text-xs text-[var(--color-ink-muted)] sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p>Hushwing — client-side voice isolation. Licensed under the terms in LICENSE.</p>
            {/* Which revision is actually on screen: the fastest way to tell a
                cached tab from a fresh deploy. */}
            <p data-mcp-target="build-marker" title={BUILD_MARKER}>
              build <code className="text-[var(--color-ink-1)]">{BUILD_MARKER}</code>
            </p>
          </div>
          <p>
            Capabilities for agents: <code>window.HushwingAPI</code> · <code>/mcp.json</code> ·{' '}
            <code>?debug=true</code>
          </p>
        </div>
      </footer>
    </div>
  )
}
