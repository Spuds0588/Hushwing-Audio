import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Job, JobStatus, ModelId, AppUrlParams } from '../types/hushwing'
import { logger } from '../lib/logger'
import { fileNameOf, isVideo } from '../lib/filekit'
import { isModelId } from '../lib/models'

/**
 * The studio is a three-step wizard, and the step lives here so that anything
 * which changes the queue can move the user along with it — a drop, an
 * `?autostart=true` boot, or the headless API queueing a file.
 */
export type WizardStep = 'add' | 'engine' | 'run'

export const WIZARD_STEPS: { id: WizardStep; label: string; hint: string }[] = [
  { id: 'add', label: 'Add files', hint: 'Drop the recordings you want cleaned up' },
  { id: 'engine', label: 'Pick an engine', hint: 'Choose how the noise gets removed' },
  { id: 'run', label: 'Process', hint: 'Follow the queue and download the results' },
]

interface AppState {
  /** Model used for newly queued jobs, and for every job still waiting. */
  model: ModelId
  /** Which wizard step is on screen. */
  step: WizardStep
  /** Mirror of the `?debug=true` URL flag. */
  showDebug: boolean
  /** Mirror of the `?autostart=true` URL flag. */
  autostart: boolean
  /** True while the queue runner is working through jobs. */
  processing: boolean
  jobs: Job[]

  setModel: (model: ModelId) => void
  setStep: (step: WizardStep) => void
  setShowDebug: (value: boolean) => void
  setAutostart: (value: boolean) => void
  setProcessing: (value: boolean) => void

  enqueue: (file: File | Blob, model: ModelId) => Job
  updateJob: (id: string, patch: Partial<Job>) => void
  setJobStatus: (id: string, status: JobStatus, error?: string) => void
  markJobResult: (id: string, url: string) => void
  removeJob: (id: string) => void
  clearFinished: () => void
  resetQueue: () => void
}

export const useAppStore = create<AppState>((set) => ({
  model: 'webaudio',
  step: 'add',
  showDebug: false,
  autostart: false,
  processing: false,
  jobs: [],

  // Choosing an engine applies to everything still waiting. Jobs the user has
  // already started keep the engine that made them, so a half-finished batch is
  // never silently re-interpreted.
  setModel: (model) =>
    set((state) => ({
      model,
      jobs: state.jobs.map((job) => (job.status === 'queued' ? { ...job, model } : job)),
    })),

  setStep: (step) => set({ step }),
  setShowDebug: (showDebug) => set({ showDebug }),
  setAutostart: (autostart) => set({ autostart }),
  setProcessing: (processing) => set({ processing }),

  enqueue: (file, model) => {
    // The output follows the source, and there is no control for it: a video keeps
    // its picture with the enhanced track muxed back in, audio comes back as a
    // 48 kHz WAV. Asking the user to choose would only let them choose wrong.
    const sourceKind: Job['sourceKind'] = isVideo(file) ? 'video' : 'audio'

    const job: Job = {
      id: uuidv4(),
      original: file,
      sourceName: fileNameOf(file) ?? 'pasted-media',
      sourceKind,
      status: 'queued',
      model,
      outputFormat: sourceKind === 'video' ? 'video' : 'wav',
      progress: 0,
      stage: 'Queued',
      createdAt: Date.now(),
    }

    set((state) => ({
      jobs: [...state.jobs, job],
      // Dropping a file is the end of step one, whichever path got us here. If a
      // batch is already running, go straight back to it: the new file simply
      // joins the queue instead of asking for an engine it cannot have.
      step: state.step === 'add' ? (state.processing ? 'run' : 'engine') : state.step,
    }))
    logger.info(`queued ${job.id} (${model}, ${job.sourceKind})`)
    return job
  },

  updateJob: (id, patch) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    })),

  setJobStatus: (id, status, error) =>
    set((state) => ({
      jobs: state.jobs.map((job) => {
        if (job.id !== id) return job
        return {
          ...job,
          status,
          error,
          startedAt: status === 'processing' ? (job.startedAt ?? Date.now()) : job.startedAt,
          completedAt:
            status === 'completed' || status === 'error' ? Date.now() : job.completedAt,
        }
      }),
    })),

  markJobResult: (id, resultUrl) =>
    set((state) => ({
      jobs: state.jobs.map((job) => (job.id === id ? { ...job, resultUrl } : job)),
    })),

  removeJob: (id) =>
    set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),

  clearFinished: () =>
    set((state) => ({
      jobs: state.jobs.filter(
        (job) => job.status !== 'completed' && job.status !== 'error'
      ),
    })),

  resetQueue: () => set({ jobs: [], processing: false, step: 'add' }),
}))

/** Read `?model=`, `?autostart=` and `?debug=` off a query string (AGENTS.md §6). */
export function parseUrlParams(search: string): AppUrlParams {
  const params = new URLSearchParams(search)
  const model = params.get('model')
  return {
    model: model && isModelId(model) ? model : undefined,
    autostart: params.get('autostart') === 'true',
    debug: params.get('debug') === 'true',
  }
}

/** Apply `?model=`, `?autostart=` and `?debug=` on boot. */
export function applyUrlParams(params: AppUrlParams) {
  const store = useAppStore.getState()
  if (params.model) store.setModel(params.model)
  if (params.autostart) store.setAutostart(true)
  if (params.debug) store.setShowDebug(true)
}
