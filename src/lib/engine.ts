import type { EngineResult, ModelId } from '../types/hushwing'
import { createKernel, type DspKernel } from './dsp'
import { logger } from './logger'
import type { EnhanceRequest, EnhanceResponse } from '../workers/enhance-worker'

/**
 * A Hushwing engine only needs a sample buffer and a rate. Keeping that
 * contract means the same DSP can be driven from:
 *
 * - a Web Worker for batch renders (Pipeline A — `WorkerEngine`)
 * - the main thread when workers are unavailable (`LocalEngine`)
 * - an `AudioWorkletNode` for real-time preview (Pipeline B — see
 *   `src/lib/preview.ts`, which mirrors `src/lib/dsp.ts`)
 */
export interface HushwingEngine {
  readonly model: ModelId
  /** Enhance PCM in place-of-return. Takes ownership of `input` when it can. */
  process(input: Float32Array, sampleRate: number): Promise<EngineResult>
  dispose(): void
}

class LocalEngine implements HushwingEngine {
  readonly model: ModelId
  private rate: number
  private kernel: DspKernel

  constructor(model: ModelId, sampleRate: number) {
    this.model = model
    this.rate = sampleRate
    this.kernel = createKernel(model, sampleRate)
  }

  async process(input: Float32Array, sampleRate: number): Promise<EngineResult> {
    if (sampleRate !== this.rate) {
      this.kernel = createKernel(this.model, sampleRate)
      this.rate = sampleRate
    }

    this.kernel.process(input)
    return { samples: input, sampleRate, channelCount: 1 }
  }

  dispose() {
    this.kernel.reset()
  }
}

interface PendingCall {
  resolve: (samples: Float32Array) => void
  reject: (error: Error) => void
}

/** Pipeline A: renders blocks (and whole files) off the main thread. */
class WorkerEngine implements HushwingEngine {
  readonly model: ModelId
  private worker: Worker
  private rate: number
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private disposed = false

  constructor(model: ModelId, sampleRate: number) {
    this.model = model
    this.rate = sampleRate
    this.worker = new Worker(new URL('../workers/enhance-worker.ts', import.meta.url), {
      type: 'module',
      name: 'hushwing-enhance',
    })

    this.worker.onmessage = (event: MessageEvent<EnhanceResponse>) => {
      const message = event.data

      if (message.type === 'ready') {
        logger.debug(`enhance worker ready (${model})`)
        return
      }

      const call = this.pending.get(message.id)
      if (!call) return
      this.pending.delete(message.id)

      if (message.type === 'result') {
        call.resolve(message.samples)
      } else {
        call.reject(new Error(message.message))
      }
    }

    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The enhance worker crashed')
      logger.error(error.message)
      this.pending.forEach((call) => call.reject(error))
      this.pending.clear()
    }

    this.post({ type: 'init', model, sampleRate })
  }

  private post(message: EnhanceRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(message, transfer)
  }

  async process(input: Float32Array, sampleRate: number): Promise<EngineResult> {
    if (this.disposed) throw new Error('Engine has been disposed')

    if (sampleRate !== this.rate) {
      this.rate = sampleRate
      this.post({ type: 'init', model: this.model, sampleRate })
    }

    const id = this.nextId++
    const samples = await new Promise<Float32Array>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.post({ type: 'process', id, samples: input }, [input.buffer as ArrayBuffer])
    })

    return { samples, sampleRate, channelCount: 1 }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.pending.forEach((call) => call.reject(new Error('Engine disposed before finishing')))
    this.pending.clear()
    this.worker.terminate()
  }
}

function workersSupported(): boolean {
  return typeof Worker !== 'undefined'
}

/**
 * Build an engine for a model. Prefers the worker (Pipeline A) and falls back
 * to the main thread when the environment blocks workers, so a job never dies
 * just because the worker could not start.
 */
export function createEngine(model: ModelId, sampleRate: number): HushwingEngine {
  if (workersSupported()) {
    try {
      return new WorkerEngine(model, sampleRate)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      logger.warn(`Enhance worker unavailable (${message}); running on the main thread`)
    }
  }

  return new LocalEngine(model, sampleRate)
}

export type { DspKernel }
