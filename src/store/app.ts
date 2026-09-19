import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { Job, JobStatus, ModelId, AppUrlParams } from '../types/hushwing'
import { logger } from '../lib/logger'
import { fileNameOf, isVideo } from '../lib/filekit'
import { isModelId } from '../lib/models'

interface AppState {
  /** Model used for newly queued jobs. */
  model: ModelId
  /** Mirror of the `?debug=true` URL flag. */
  showDebug: boolean
  /** Mirror of the `?autostart=true` URL flag. */
  autostart: boolean
  /** True while the queue runner is working through jobs. */
  processing: boolean
  jobs: Job[]

  setModel: (model: ModelId) => void
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
  showDebug: false,
  autostart: false,
  processing: false,
  jobs: [],

  setModel: (model) => set({ model }),
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

    set((state) => ({ jobs: [...state.jobs, job] }))
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

  resetQueue: () => set({ jobs: [], processing: false }),
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
