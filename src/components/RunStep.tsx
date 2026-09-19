import type { Job } from '../types/hushwing'
import { useAppStore } from '../store/app'
import { AbPreview } from './AbPreview'
import { JobQueue } from './JobQueue'
import { Badge, Button, Progress } from './ui'
import { formatBytes } from '../lib/filekit'

interface RunStepProps {
  onRun: (jobId: string) => void
  onRemove: (jobId: string) => void
  onClearFinished: () => void
  onPreview: (job: Job) => void
  onAddMore: () => void
  onStartOver: () => void
  previewJob: Job | null
  onClosePreview: () => void
}

/**
 * Step 3 — the queue.
 *
 * Everything the user needs while a batch runs: how far it has got, what each
 * file is doing, and the download for anything that finished. The start control
 * lives back on step 2, so there is nothing here that can kick off work by
 * accident.
 */
export function RunStep({
  onRun,
  onRemove,
  onClearFinished,
  onPreview,
  onAddMore,
  onStartOver,
  previewJob,
  onClosePreview,
}: RunStepProps) {
  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)
  const model = useAppStore((state) => state.model)

  return (
    <div className="flex flex-col gap-4">
      <BatchProgress jobs={jobs} processing={processing} />

      {previewJob?.original && (
        <AbPreview
          job={previewJob}
          source={previewJob.original}
          model={model}
          title="A/B preview"
          hint={`${previewJob.sourceName} · the live engine, not the rendered file`}
          onClose={onClosePreview}
        />
      )}

      <JobQueue
        jobs={jobs}
        onRun={onRun}
        onRemove={onRemove}
        onClearFinished={onClearFinished}
        onPreview={onPreview}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-4">
        <p className="text-xs text-[var(--color-ink-muted)]">
          Add more and they pick up right where this batch left off.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onStartOver} data-mcp-action="start-over">
            Start over
          </Button>
          <Button variant="secondary" onClick={onAddMore} data-mcp-action="wizard-back">
            Add more files
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The one piece of chrome a long job needs: how far the batch has got.
 */
export function BatchProgress({ jobs, processing }: { jobs: Job[]; processing: boolean }) {
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
    <section
      data-mcp-target="batch-progress"
      className="rounded-2xl border border-border bg-[var(--color-surface-1)] p-5"
    >
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

      <div className="mt-4">
        <Progress value={overall} />
        <p className="mt-1.5 text-[11px] text-[var(--color-ink-muted)]">
          {active
            ? `${active.sourceName} · ${active.stage ?? 'working'} · ${Math.round(active.progress)}%`
            : `${overall}% of the batch`}
        </p>
      </div>
    </section>
  )
}
