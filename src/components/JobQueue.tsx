import { useMemo, useState } from 'react'
import type { Job } from '../types/hushwing'
import { Badge, Button, Card, Progress, cx } from './ui'
import { downloadResultsAsZip, hasExportableResults } from '../lib/batch'
import { formatBytes } from '../lib/filekit'
import { logger } from '../lib/logger'

type Filter = 'all' | 'active' | 'completed' | 'failed'

const STATUS_LABEL: Record<Job['status'], string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  processing: 'Processing',
  completed: 'Completed',
  error: 'Failed',
}

const STATUS_VARIANT: Record<Job['status'], 'default' | 'info' | 'success' | 'error'> = {
  queued: 'default',
  preparing: 'info',
  processing: 'info',
  completed: 'success',
  error: 'error',
}

const FILTERS: Filter[] = ['all', 'active', 'completed', 'failed']

export function isActiveJob(job: Job): boolean {
  return job.status === 'queued' || job.status === 'preparing' || job.status === 'processing'
}

interface JobQueueProps {
  jobs: Job[]
  onRun: (jobId: string) => void
  onRemove: (jobId: string) => void
  onClearFinished: () => void
}

export function JobQueue({ jobs, onRun, onRemove, onClearFinished }: JobQueueProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const [exporting, setExporting] = useState(false)

  const counts = useMemo(
    () => ({
      all: jobs.length,
      active: jobs.filter(isActiveJob).length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => job.status === 'error').length,
    }),
    [jobs]
  )

  const visible = useMemo(() => {
    switch (filter) {
      case 'active':
        return jobs.filter(isActiveJob)
      case 'completed':
        return jobs.filter((job) => job.status === 'completed')
      case 'failed':
        return jobs.filter((job) => job.status === 'error')
      default:
        return jobs
    }
  }, [jobs, filter])

  const canExport = hasExportableResults(jobs)

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
            Job queue
          </h2>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            One job runs at a time, so a long video cannot exhaust memory.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] p-1">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                aria-pressed={filter === value}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
                  filter === value
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-ink-0)]'
                    : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink-0)]'
                )}
              >
                {value} ({counts[value]})
              </button>
            ))}
          </div>

          <Button
            variant="ghost"
            size="sm"
            data-mcp-action="export-zip"
            disabled={!canExport || exporting}
            onClick={async () => {
              setExporting(true)
              try {
                const count = await downloadResultsAsZip(jobs)
                logger.info(`exported ${count} result(s) as a zip`)
              } catch (error) {
                logger.error(error instanceof Error ? error.message : 'zip export failed')
              } finally {
                setExporting(false)
              }
            }}
          >
            {exporting ? 'Zipping…' : 'Export all (.zip)'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            disabled={counts.completed + counts.failed === 0}
            onClick={onClearFinished}
          >
            Clear finished
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-[var(--color-ink-muted)]">
          {jobs.length === 0
            ? 'The queue is empty. Go back a step and add some files.'
            : 'No jobs match this filter.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onRun={onRun}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </Card>
  )
}

function JobRow({
  job,
  onRun,
  onRemove,
}: {
  job: Job
  onRun: (jobId: string) => void
  onRemove: (jobId: string) => void
}) {
  return (
    <li
      data-job-id={job.id}
      data-status={job.status}
      data-job-name={job.sourceName}
      data-job-model={job.model}
      data-job-decoder={job.decoder}
      className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-[var(--color-ink-0)]" title={job.sourceName}>
            {job.sourceName}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant={STATUS_VARIANT[job.status]}>{STATUS_LABEL[job.status]}</Badge>
            <Badge>{job.model}</Badge>
            <Badge>{job.outputFormat === 'video' ? 'video' : 'wav'}</Badge>
            {job.decoder && <Badge>{job.decoder}</Badge>}
            {job.duration !== undefined && (
              <span className="text-[11px] tabular-nums text-[var(--color-ink-muted)]">
                {job.duration.toFixed(1)}s source
              </span>
            )}
            {job.durationMs !== undefined && job.status === 'completed' && (
              <span className="text-[11px] tabular-nums text-[var(--color-ink-muted)]">
                {(job.durationMs / 1000).toFixed(1)}s render
                {job.outputSize ? ` · ${formatBytes(job.outputSize)}` : ''}
              </span>
            )}
          </div>
          {job.error && (
            <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-300">
              {job.error}
            </p>
          )}
          {job.warning && !job.error && (
            <p className="mt-2 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
              {job.warning}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {job.status === 'completed' && job.resultUrl && (
            <a
              data-mcp-action="download-result"
              data-job-id={job.id}
              href={job.resultUrl}
              download={job.outputName}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-[var(--color-surface-2)] px-3 text-xs font-medium text-[var(--color-ink-0)] transition-colors hover:bg-[var(--color-surface-3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Download
            </a>
          )}

          {(job.status === 'queued' || job.status === 'error') && (
            <Button variant="secondary" size="sm" onClick={() => onRun(job.id)}>
              {job.status === 'error' ? 'Retry' : 'Start'}
            </Button>
          )}

          {!isActiveJob(job) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onRemove(job.id)}
              aria-label={`Remove job ${job.id}`}
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {isActiveJob(job) && job.status !== 'queued' && (
        <div>
          <Progress value={job.progress} />
          <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
            {job.stage ?? 'Working'} · {Math.round(job.progress)}%
          </p>
        </div>
      )}
    </li>
  )
}
