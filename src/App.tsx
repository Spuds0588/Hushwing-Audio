import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Header } from './components/Header'
import { Landing } from './components/Landing'
import { UploadZone } from './components/UploadZone'
import { JobQueue } from './components/JobQueue'
import { DebugLog } from './components/DebugLog'
import { AbPreview } from './components/AbPreview'
import { CloudImport } from './components/CloudImport'
import { Badge, Button, Card } from './components/ui'
import { applyUrlParams, parseUrlParams, useAppStore } from './store/app'
import { isPending, purgeJobFiles, runJob, runQueue } from './lib/pipeline'
import { installHushwingAPI } from './lib/hushwing-api'
import { availableModelIds, getModelSpec } from './lib/models'
import { preloadFFmpeg } from './lib/ffmpeg'
import { formatBytes, revokeMediaUrl } from './lib/filekit'
import { logger } from './lib/logger'
import { opfsSupported } from './lib/opfs'
import type { Job, ModelId } from './types/hushwing'

type View = 'landing' | 'dashboard'

export default function App() {
  const [view, setView] = useState<View>(() =>
    typeof window !== 'undefined' && window.location.hash === '#studio' ? 'dashboard' : 'landing'
  )
  const [previewJobId, setPreviewJobId] = useState<string | null>(null)

  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const showDebug = useAppStore((state) => state.showDebug)
  const model = useAppStore((state) => state.model)
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

  const navigate = useCallback((next: View) => {
    setView(next)
    try {
      const url = new URL(window.location.href)
      url.hash = next === 'dashboard' ? 'studio' : ''
      window.history.replaceState(null, '', url)
    } catch {
      // Sandboxed frames may reject history updates; the view state still applies.
    }
  }, [])

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
      <Header
        view={view}
        onNavigate={navigate}
        onToggleLog={() => setShowDebug(!showDebug)}
      />

      {view === 'landing' ? (
        <Landing onStart={() => navigate('dashboard')} />
      ) : (
        <Studio
          jobs={jobs}
          processing={processing}
          model={model}
          onProcessQueue={handleProcessQueue}
          onRunJob={handleRunJob}
          onRemoveJob={handleRemoveJob}
          onClearFinished={handleClearFinished}
          onPreview={(job) => setPreviewJobId(job.id)}
          onAutostart={handleProcessQueue}
        />
      )}

      {view === 'dashboard' && previewJob?.original && (
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <AbPreview
            job={previewJob}
            source={previewJob.original}
            onClose={() => setPreviewJobId(null)}
            onModelChange={(nextModel) =>
              useAppStore.getState().updateJob(previewJob.id, { model: nextModel })
            }
          />
        </div>
      )}

      {view === 'dashboard' && (
        <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
          <DebugLog open={showDebug} />
        </div>
      )}

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-[var(--color-ink-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            Hushwing Audio — client-side voice isolation. Licensed under the terms in{' '}
            <code>LICENSE</code>.
          </p>
          <p>
            Capabilities for agents: <code>window.HushwingAPI</code> · <code>/mcp.json</code> ·{' '}
            <code>?debug=true</code>
          </p>
        </div>
      </footer>
    </div>
  )
}

interface StudioProps {
  jobs: Job[]
  processing: boolean
  model: ModelId
  onProcessQueue: () => void
  onRunJob: (jobId: string) => void
  onRemoveJob: (jobId: string) => void
  onClearFinished: () => void
  onPreview: (job: Job) => void
  onAutostart: () => void
}

function Studio({
  jobs,
  processing,
  model,
  onProcessQueue,
  onRunJob,
  onRemoveJob,
  onClearFinished,
  onPreview,
  onAutostart,
}: StudioProps) {
  const pending = jobs.filter((job) => isPending(job) && job.status !== 'processing').length
  const active = jobs.filter((job) => job.status === 'processing').length
  const done = jobs.filter((job) => job.status === 'completed')
  const failed = jobs.filter((job) => job.status === 'error').length
  const rendered = done.reduce((total, job) => total + (job.outputSize ?? 0), 0)

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between"
      >
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Studio</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--color-ink-muted)]">
            Drop files, pick an engine, and process them here. One job runs at a time; results stay
            in this tab until you download them.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={processing ? 'info' : 'default'}>
            {processing ? 'running' : 'idle'}
          </Badge>
          <Button
            data-mcp-action="process-queue"
            onClick={onProcessQueue}
            disabled={processing || pending === 0}
          >
            {processing ? 'Processing…' : `Process queue${pending ? ` (${pending})` : ''}`}
          </Button>
          <Button
            variant="secondary"
            disabled={jobs.length === 0}
            onClick={() => useAppStore.getState().resetQueue()}
          >
            Reset queue
          </Button>
        </div>
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <h2 className="mb-4 text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
              Add media
            </h2>
            <UploadZone disabled={processing} onAutostart={onAutostart} />
          </Card>

          <CloudImport disabled={processing} onImported={onAutostart} />
        </div>

        <aside className="flex flex-col gap-6">
          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
              Selected engine
            </h2>
            <ModelSummary model={model} />
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
                Queue status
              </h2>
              <Badge variant={failed > 0 ? 'error' : active > 0 ? 'info' : 'default'}>
                {active > 0 ? 'working' : failed > 0 ? 'needs attention' : 'clear'}
              </Badge>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              <Stat label="Waiting" value={String(pending)} />
              <Stat label="Running" value={String(active)} />
              <Stat label="Done" value={String(done.length)} />
              <Stat label="Failed" value={String(failed)} />
            </dl>
            <p className="mt-4 text-xs text-[var(--color-ink-muted)]">
              {rendered > 0
                ? `${formatBytes(rendered)} of enhanced media is ready to download.`
                : 'Finished files appear here with a download link.'}
            </p>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
              Storage
            </h2>
            <p className="mt-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              {opfsSupported()
                ? 'Inputs are copied into the Origin Private File System and results are streamed back there, so peak memory stays roughly one buffer per job.'
                : 'This browser has no Origin Private File System, so staging and result storage are unavailable.'}{' '}
              Nothing is uploaded anywhere.
            </p>
          </Card>
        </aside>
      </div>

      <section className="mt-8">
        <JobQueue
          jobs={jobs}
          onRun={onRunJob}
          onRemove={onRemoveJob}
          onClearFinished={onClearFinished}
          onPreview={onPreview}
        />
      </section>
    </main>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-[var(--color-ink-muted)] uppercase">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function ModelSummary({ model }: { model: ModelId }) {
  const spec = getModelSpec(model)
  if (!spec) return <p className="mt-3 text-sm text-[var(--color-ink-muted)]">No engine selected.</p>

  return (
    <div className="mt-3 space-y-2">
      <p className="text-sm font-medium text-[var(--color-ink-0)]">{spec.label}</p>
      <p className="text-xs leading-relaxed text-[var(--color-ink-muted)]">{spec.description}</p>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {spec.tags.map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-[var(--color-surface-3)] px-2 py-0.5 text-[10px] text-[var(--color-ink-muted)]"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="pt-1 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
        {spec.implementation}
      </p>
    </div>
  )
}
