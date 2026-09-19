import { processFile } from './pipeline'
import { availableModelIds, isModelId } from './models'
import { downloadLogs } from './logger'
import { useAppStore } from '../store/app'
import { isActive } from './pipeline'
import type { ModelId } from '../types/hushwing'

export interface ProcessMediaOptions {
  file: File | Blob
  model?: ModelId
}

export interface HushwingAPI {
  /** Models that are actually implemented in this build. */
  getModels(): Promise<ModelId[]>
  /**
   * Clean one file and resolve with the enhanced media. The output follows the
   * source — a video comes back as a video, audio as a 48 kHz WAV — so there is no
   * format option to pass.
   */
  processMedia(options: ProcessMediaOptions): Promise<Blob>
  /** Queue one file without awaiting the result. Returns the job id. */
  queueMedia(options: ProcessMediaOptions): Promise<string>
  /** Snapshot of the current queue, for agents that poll. */
  getJobs(): {
    id: string
    status: string
    name: string
    progress: number
    stage?: string
    resultUrl?: string
    error?: string
    /** Non-fatal note, e.g. a video-format job whose source had no video track. */
    warning?: string
    /** Which decoder produced the PCM (`mp3`, `flac`, `wav reader`, `ffmpeg`). */
    decoder?: string
  }[]
  /** Download the rolling diagnostic log as a .txt file. */
  downloadDebugLog(): void
}

declare global {
  interface Window {
    HushwingAPI: HushwingAPI
  }
}

const api: HushwingAPI = {
  async getModels() {
    return availableModelIds()
  },

  async processMedia({ file, model }) {
    const job = await processFile(file, model ?? useAppStore.getState().model)

    if (job.status !== 'completed' || !job.resultUrl) {
      throw new Error(job.error ?? `Job ${job.id} did not complete`)
    }

    const response = await fetch(job.resultUrl)
    if (!response.ok) {
      throw new Error(`Could not read the result (HTTP ${response.status})`)
    }
    return response.blob()
  },

  async queueMedia({ file, model }) {
    const store = useAppStore.getState()
    // Fall back to whatever engine the studio has selected, so a headless caller
    // and the person watching the screen agree on what is about to run.
    const job = store.enqueue(file, model ?? store.model)
    return job.id
  },

  getJobs() {
    return useAppStore.getState().jobs.map((job) => ({
      id: job.id,
      status: job.status,
      name: job.sourceName,
      progress: job.progress,
      stage: job.stage,
      resultUrl: job.resultUrl,
      error: job.error,
      warning: job.warning,
      decoder: job.decoder,
    }))
  },

  downloadDebugLog() {
    downloadLogs()
  },
}

export function installHushwingAPI(): HushwingAPI {
  window.HushwingAPI = api
  return api
}

/** Guard used when a caller passes a model string straight from a URL or the console. */
export function coerceModel(value: string | null | undefined, fallback: ModelId = 'webaudio'): ModelId {
  return value && isModelId(value) ? value : fallback
}

export { isActive }
