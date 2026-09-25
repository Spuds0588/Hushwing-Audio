import type { ModelId } from '../types/hushwing'
import { useAppStore } from '../store/app'
import { MODEL_SPECS } from '../lib/models'
import { Badge, cx } from './ui'

/**
 * The one decision the product has: how the noise comes out.
 *
 * The choice is a real one, so it gets cards with honest descriptions instead of
 * a dropdown. Whatever is picked applies to every job still waiting — running
 * jobs keep the engine that made them.
 */
export function EnginePicker() {
  const model = useAppStore((state) => state.model)
  const setModel = useAppStore((state) => state.setModel)
  const pending = useAppStore(
    (state) => state.jobs.filter((job) => job.status === 'queued').length
  )

  return (
    <section className="rounded-2xl border border-border bg-[var(--color-surface-1)]/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-[var(--color-ink-1)] uppercase">
          How should the noise come out?
        </h2>
        <p className="text-xs text-[var(--color-ink-muted)]">
          {pending > 0
            ? `Applies to all ${pending} waiting file${pending === 1 ? '' : 's'}.`
            : 'Pick one, then drop a file.'}
        </p>
      </div>

      <div role="radiogroup" aria-label="Processing engine" className="mt-4 grid gap-3 sm:grid-cols-2">
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
    </section>
  )
}
