import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Header } from './components/Header'
import { Stepper } from './components/Stepper'
import { AddStep } from './components/AddStep'
import { EngineStep } from './components/EngineStep'
import { RunStep } from './components/RunStep'
import { DebugLog } from './components/DebugLog'
import { applyUrlParams, parseUrlParams, useAppStore, type WizardStep } from './store/app'
import { purgeJobFiles, runJob, runQueue } from './lib/pipeline'
import { installHushwingAPI } from './lib/hushwing-api'
import { availableModelIds } from './lib/models'
import { nativeKindFor } from './lib/decode'
import { preloadFFmpeg } from './lib/ffmpeg'
import { revokeMediaUrl } from './lib/filekit'
import { logger } from './lib/logger'
import { opfsSupported } from './lib/opfs'
import type { Job } from './types/hushwing'

/**
 * Hushwing Audio is one page and one flow: add files, pick an engine, watch the
 * queue. Each of those is a step, and only the current step is on screen — the
 * step the user is on is the only thing the app asks them to think about.
 */
export default function App() {
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)

  const jobs = useAppStore((state) => state.jobs)
  const step = useAppStore((state) => state.step)
  const setStep = useAppStore((state) => state.setStep)
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

  /*
   * Only pull the ~30 MB ffmpeg core for work that cannot be done without it.
   * An MP3, WAV, FLAC or Ogg-Opus job is decoded in JavaScript and never touches
   * it, so a queue of audio does not pay for a video tool it will not use.
   */
  const needsFFmpeg = jobs.some(
    (job) => job.sourceKind === 'video' || nativeKindFor(job.sourceName) === null
  )
  useEffect(() => {
    if (needsFFmpeg) preloadFFmpeg()
  }, [needsFFmpeg])

  const handleProcessQueue = useCallback(() => {
    setStep('run')
    void runQueue()
  }, [setStep])

  const handleRunJob = useCallback(
    (jobId: string) => {
      setStep('run')
      void runJob(jobId).catch(() => undefined)
    },
    [setStep]
  )

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

  /** Wipe the queue (and the results it is holding in OPFS) and start again. */
  const handleStartOver = useCallback(() => {
    for (const job of useAppStore.getState().jobs) {
      if (job.resultUrl) revokeMediaUrl(job.resultUrl)
      void purgeJobFiles(job)
    }
    setPreviewJobId(null)
    useAppStore.getState().resetQueue()
  }, [])

  const previewJob = useMemo(
    () => jobs.find((job) => job.id === previewJobId) ?? null,
    [jobs, previewJobId]
  )

  const canReach = useCallback(
    (target: WizardStep) => {
      if (target === 'add') return true
      if (target === 'engine') return jobs.length > 0
      return jobs.some((job) => job.status !== 'queued')
    },
    [jobs]
  )

  return (
    <div className="min-h-screen bg-[var(--color-surface-0)] text-[var(--color-ink-0)] selection:bg-[var(--color-accent)]/30">
      <Header onToggleLog={() => setShowDebug(!showDebug)} />

      <main
        data-wizard-step={step}
        className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10"
      >
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Clean up any recording
            <span className="block text-[var(--color-ink-muted)]">
              without uploading a single byte
            </span>
          </h1>
        </div>

        <Stepper step={step} canReach={canReach} onSelect={setStep} />

        <motion.section
          key={step}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
        >
          {step === 'add' && (
            <AddStep
              onContinue={() => setStep('engine')}
              onRemove={handleRemoveJob}
              onAutostart={handleProcessQueue}
            />
          )}

          {step === 'engine' && (
            <EngineStep onProcess={handleProcessQueue} onBack={() => setStep('add')} />
          )}

          {step === 'run' && (
            <RunStep
              onRun={handleRunJob}
              onRemove={handleRemoveJob}
              onClearFinished={handleClearFinished}
              onPreview={(job: Job) => setPreviewJobId(job.id)}
              onAddMore={() => setStep('add')}
              onStartOver={handleStartOver}
              previewJob={previewJob}
              onClosePreview={() => setPreviewJobId(null)}
            />
          )}
        </motion.section>

        <DebugLog open={showDebug} />
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-8 text-xs text-[var(--color-ink-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
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
