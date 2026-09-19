import type { Job, ModelId } from '../types/hushwing'
import { useAppStore } from '../store/app'
import { MODEL_SPECS } from '../lib/models'
import { AbPreview } from './AbPreview'
import { Badge, Button, cx } from './ui'

interface EngineStepProps {
  onProcess: () => void
  onBack: () => void
}

/**
 * Step 2 — choose how the noise gets removed, and hear it first.
 *
 * The choice is a real one, so it gets cards with honest descriptions instead of
 * a dropdown. Whatever is picked applies to every job still waiting, which is
 * why changing it here also updates the queue.
 */
export function EngineStep({ onProcess, onBack }: EngineStepProps) {
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const jobs = useAppStore((state) => state.jobs)
  const processing = useAppStore((state) => state.processing)

  const pending = jobs.filter((job) => job.status === 'queued')
  const audition: Job | undefined = pending.find((job) => job.original)

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-5">
        <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
          How should the noise come out?
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {pending.length > 0
            ? `Applies to all ${pending.length} waiting file${pending.length === 1 ? '' : 's'}.`
            : 'Nothing is waiting yet — add files first.'}
        </p>

        <div
          role="radiogroup"
          aria-label="Processing engine"
          className="mt-4 grid gap-3 sm:grid-cols-2"
        >
          {MODEL_SPECS.map((spec) => {
            const selected = spec.id === model
            return (
              <button
                key={spec.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!spec.ready}
                data-mcp-target="model-selector"
                data-model-id={spec.id}
                data-selected={selected}
                onClick={() => spec.ready && setModel(spec.id as ModelId)}
                className={cx(
                  'flex flex-col gap-2 rounded-2xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-[var(--color-surface-1)] hover:border-accent/50 hover:bg-[var(--color-surface-2)]',
                  !spec.ready && 'cursor-not-allowed opacity-55 hover:border-border'
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-[var(--color-ink-0)]">
                    {spec.label}
                  </span>
                  {spec.ready ? (
                    selected ? (
                      <Badge variant="success">selected</Badge>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {spec.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag}>{tag}</Badge>
                        ))}
                      </span>
                    )
                  ) : (
                    <Badge variant="warn">not in this build</Badge>
                  )}
                </span>

                <span className="text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  {spec.description}
                </span>

                <span className="text-[11px] leading-relaxed text-[var(--color-ink-muted)]/80">
                  {spec.implementation}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {audition && audition.original && (
        <AbPreview
          job={audition}
          source={audition.original}
          model={model}
          title="Hear it before you commit"
          hint={`${audition.sourceName} · the live engine, not the rendered file`}
        />
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-4">
        <Button variant="ghost" onClick={onBack} data-mcp-action="wizard-back">
          ← Back
        </Button>

        <div className="flex items-center gap-3">
          <span className="text-xs text-[var(--color-ink-muted)]">
            {pending.length} file{pending.length === 1 ? '' : 's'} queued
          </span>
          <Button
            data-mcp-action="process-queue"
            onClick={onProcess}
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
    </div>
  )
}
