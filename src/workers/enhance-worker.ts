import { createKernel } from '../lib/dsp'
import type { ModelId } from '../types/hushwing'

/**
 * Pipeline A — batch enhancement worker.
 *
 * Runs the pure-JS DSP kernels from `src/lib/dsp.ts` off the main thread so the
 * UI keeps painting while a long file renders. Mirrors `WorkerEngine` in
 * `src/lib/engine.ts`.
 *
 * Note: no `/// <reference lib="webworker" />` here on purpose — the app
 * tsconfig already loads the DOM libs, and mixing them in produces duplicate
 * global declarations. The worker scope is typed locally instead.
 */
export interface EnhanceInitMessage {
  type: 'init'
  model: ModelId
  sampleRate: number
}

export interface EnhanceProcessMessage {
  type: 'process'
  id: number
  samples: Float32Array
}

export type EnhanceRequest = EnhanceInitMessage | EnhanceProcessMessage

export interface EnhanceReadyMessage {
  type: 'ready'
}

export interface EnhanceResultMessage {
  type: 'result'
  id: number
  samples: Float32Array
}

export interface EnhanceErrorMessage {
  type: 'error'
  id: number
  message: string
}

export type EnhanceResponse = EnhanceReadyMessage | EnhanceResultMessage | EnhanceErrorMessage

interface WorkerScope {
  onmessage: ((event: MessageEvent<EnhanceRequest>) => void) | null
  postMessage: (message: EnhanceResponse, transfer?: Transferable[]) => void
}

const scope = self as unknown as WorkerScope

let kernel = createKernel('webaudio', 48_000)

scope.onmessage = (event) => {
  const message = event.data

  if (message.type === 'init') {
    try {
      kernel = createKernel(message.model, message.sampleRate)
      scope.postMessage({ type: 'ready' })
    } catch (error) {
      scope.postMessage({
        type: 'error',
        id: 0,
        message: error instanceof Error ? error.message : 'Could not initialise the model',
      })
    }
    return
  }

  const samples = message.samples

  try {
    // The buffer was transferred to us, so it can be processed and handed back
    // without another full-size allocation.
    kernel.process(samples)
    scope.postMessage({ type: 'result', id: message.id, samples }, [samples.buffer as ArrayBuffer])
  } catch (error) {
    scope.postMessage({
      type: 'error',
      id: message.id,
      message: error instanceof Error ? error.message : 'Enhancement failed',
    })
  }
}
