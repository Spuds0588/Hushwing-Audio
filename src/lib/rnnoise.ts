import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import { logger } from './logger'

/**
 * RNNoise — the real one.
 *
 * `@sapphi-red/web-noise-suppressor` ships Shiguredo's WebAssembly build of
 * RNNoise together with an `AudioWorkletProcessor`. The same processor and the
 * same wasm binary drive both pipelines:
 *
 * There is only one RNNoise path in the app: rendered through an
 * `OfflineAudioContext`. RNNoise is a 48 kHz, frame-based recurrent network, so
 * the browser's own audio rendering thread is the cheapest correct way to run
 * it — `startRendering()` hands back the finished buffer. The A/B audition goes
 * through this same function, on an excerpt, rather than running a second live
 * implementation that could drift from the output.
 *
 * The wasm binaries are emitted by the bundler as hashed assets, so a deployed
 * build fetches them from its own origin and nothing else.
 */

/** RNNoise is trained at 48 kHz and only accepts 48 kHz frames. */
export const RNNOISE_RATE = 48_000

let binaryPromise: Promise<ArrayBuffer> | null = null

/** The wasm bytes, fetched once per session. */
export function loadRnnoiseBinary(): Promise<ArrayBuffer> {
  binaryPromise ??= loadRnnoise({ url: rnnoiseUrl, simdUrl: rnnoiseSimdUrl }).catch((error: unknown) => {
    // Do not cache a rejection: a transient network failure must not poison
    // every later job.
    binaryPromise = null
    throw error
  })
  return binaryPromise
}

/** True when this browser can run RNNoise at all. */
export function rnnoiseSupported(): boolean {
  return typeof OfflineAudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined'
}

/**
 * The worklet node type declares an `AudioContext`, but RNNoise is perfectly
 * happy in an `OfflineAudioContext` too (both are `BaseAudioContext`s and both
 * implement `audioWorklet`), which is how a whole file goes through it in one
 * pass.
 */
function createNode(context: BaseAudioContext, wasmBinary: ArrayBuffer): RnnoiseWorkletNode {
  return new RnnoiseWorkletNode(context as unknown as AudioContext, {
    maxChannels: 1,
    wasmBinary,
  })
}

/** Load the processor into a context. Idempotent per context. */
export async function addRnnoiseWorkletModule(context: BaseAudioContext): Promise<void> {
  await context.audioWorklet.addModule(rnnoiseWorkletUrl)
}

/**
 * Render one mono block of 48 kHz PCM through RNNoise.
 *
 * Returns a fresh buffer; the input is left alone so the pipeline can compare
 * or retry.
 */
export async function renderWithRnnoise(samples: Float32Array): Promise<Float32Array> {
  if (!rnnoiseSupported()) {
    throw new Error('This browser cannot run RNNoise (AudioWorklet or OfflineAudioContext missing)')
  }

  // A zero-length render is invalid, and a job that produced no samples has
  // nothing to denoise anyway.
  const length = Math.max(samples.length, RNNOISE_RATE / 4)

  const context = new OfflineAudioContext(1, length, RNNOISE_RATE)
  await addRnnoiseWorkletModule(context)

  const wasmBinary = await loadRnnoiseBinary()
  const node = createNode(context, wasmBinary)

  try {
    const buffer = context.createBuffer(1, length, RNNOISE_RATE)
    buffer.getChannelData(0).set(samples.subarray(0, Math.min(samples.length, length)))

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(node)
    node.connect(context.destination)
    source.start()

    const rendered = await context.startRendering()
    const output = new Float32Array(samples.length)
    rendered.copyFromChannel(output, 0)

    logger.debug(
      `rnnoise: rendered ${samples.length} samples @ ${RNNOISE_RATE}Hz (${(
        samples.length / RNNOISE_RATE
      ).toFixed(1)}s)`
    )
    return output
  } finally {
    // Releases the wasm-side denoise state and PCM buffers. An OfflineAudioContext
    // needs no close: it stops holding anything the moment rendering finishes.
    node.destroy()
  }
}

