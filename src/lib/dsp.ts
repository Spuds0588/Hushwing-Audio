import type { ModelId } from '../types/hushwing'

/**
 * Pure-JS DSP kernels for the `webaudio` engine.
 *
 * Everything here is allocation-light, streaming and dependency-free, which is
 * what lets the *same* kernels run in two places:
 *
 * - `src/workers/enhance-worker.ts` (offline batch render)
 * - `src/lib/engine.ts` on the main thread (fallback when workers are blocked)
 *
 * Kernels are stateful and block-size agnostic: state carries across calls, so
 * a kernel can be fed 5 ms frames in a worklet or one big buffer offline and
 * produce the same result.
 *
 * The `rnnoise` engine is not here: it is real WebAssembly, driven through the
 * browser audio graph — see `src/lib/rnnoise.ts`.
 */
export interface DspKernel {
  /** Process a block in place. */
  process(input: Float32Array): void
  reset(): void
}

export class Chain implements DspKernel {
  private kernels: DspKernel[]

  constructor(kernels: DspKernel[]) {
    this.kernels = kernels
  }

  process(input: Float32Array) {
    for (const kernel of this.kernels) kernel.process(input)
  }

  reset() {
    for (const kernel of this.kernels) kernel.reset()
  }
}

/** RBJ high-pass biquad, transposed direct form II. */
export class Highpass implements DspKernel {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(sampleRate: number, frequency: number, q = 0.7071) {
    const w0 = (2 * Math.PI * Math.min(frequency, sampleRate * 0.45)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha

    this.b0 = ((1 + cos) / 2) / a0
    this.b1 = (-(1 + cos)) / a0
    this.b2 = ((1 + cos) / 2) / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(input: Float32Array) {
    const { b0, b1, b2, a1, a2 } = this
    let { x1, x2, y1, y2 } = this

    for (let i = 0; i < input.length; i++) {
      const x0 = input[i]
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
      input[i] = y0
    }

    this.x1 = x1
    this.x2 = x2
    this.y1 = y1
    this.y2 = y2
  }

  reset() {
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0
  }
}

/**
 * Feed-forward compressor with soft knee and per-sample ballistics.
 * Used by the "Native Web Audio" chain (which no longer needs an
 * `OfflineAudioContext`, so it can run inside a worker).
 */
export class Compressor implements DspKernel {
  private threshold: number
  private ratio: number
  private knee: number
  private attackCoef: number
  private releaseCoef: number
  private makeup: number
  private env = 0

  constructor(
    sampleRate: number,
    options: {
      threshold?: number
      ratio?: number
      knee?: number
      attack?: number
      release?: number
      makeup?: number
    } = {}
  ) {
    this.threshold = options.threshold ?? -18
    this.ratio = options.ratio ?? 3
    this.knee = options.knee ?? 6
    this.makeup = options.makeup ?? 1.15
    this.attackCoef = Math.exp(-1 / Math.max(1e-5, (options.attack ?? 0.004) * sampleRate))
    this.releaseCoef = Math.exp(-1 / Math.max(1e-5, (options.release ?? 0.12) * sampleRate))
  }

  process(input: Float32Array) {
    const attack = this.attackCoef
    const release = this.releaseCoef

    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      const level = Math.abs(x)
      this.env = level > this.env ? level * (1 - attack) + this.env * attack : level * (1 - release) + this.env * release

      const db = 20 * Math.log10(Math.max(this.env, 1e-6))
      const over = db - this.threshold
      const knee = this.knee

      let reduction = 0
      if (over > knee / 2) {
        reduction = over - over / this.ratio
      } else if (over > -knee / 2) {
        // Quadratic soft knee.
        const t = over + knee / 2
        reduction = ((1 / this.ratio - 1) * t * t) / (2 * knee) * -1
        reduction = Math.max(0, reduction)
      }

      const gain = Math.pow(10, -reduction / 20) * this.makeup
      input[i] = x * gain
    }
  }

  reset() {
    this.env = 0
  }
}

/**
 * In-place soft limiter. Everything below `threshold` passes through untouched;
 * above it the signal approaches `ceiling` asymptotically, so the gain stages
 * before it cannot push the render into hard clipping.
 */
export class SoftLimiter implements DspKernel {
  private ceiling: number
  private threshold: number

  constructor(ceiling = 0.98, threshold = 0.8) {
    this.ceiling = ceiling
    this.threshold = Math.min(threshold, ceiling * 0.95)
  }

  process(input: Float32Array) {
    const ceiling = this.ceiling
    const threshold = this.threshold
    const range = ceiling - threshold

    for (let i = 0; i < input.length; i++) {
      const sample = input[i]
      const magnitude = Math.abs(sample)
      if (magnitude <= threshold) continue

      const over = magnitude - threshold
      const limited = threshold + over / (1 + over / range)
      input[i] = sample < 0 ? -limited : limited
    }
  }

  reset() {}
}

export function createKernel(model: ModelId, sampleRate: number): DspKernel {
  switch (model) {
    case 'webaudio':
      return new Chain([
        new Highpass(sampleRate, 85),
        new Compressor(sampleRate, {
          threshold: -18,
          ratio: 3,
          knee: 8,
          attack: 0.004,
          release: 0.14,
          makeup: 1.18,
        }),
        new SoftLimiter(),
      ])
    case 'rnnoise':
      // Not a JS kernel: RNNoise is WebAssembly, driven through the browser
      // audio graph by `src/lib/rnnoise.ts`. Reaching this means something
      // asked the wrong layer to render it.
      throw new Error('RNNoise renders through the WebAssembly engine, not the JS kernels')
    case 'deepfilternet':
      throw new Error('DeepFilterNet 3 is not available in this build yet.')
    default: {
      const exhaustive: never = model
      throw new Error(`Unknown model: ${String(exhaustive)}`)
    }
  }
}

/**
 * Resampler. Frame counts are exact so muxed video audio cannot drift.
 *
 * Upsampling (the 16 kHz → 48 kHz delivery path) uses Catmull-Rom cubic
 * interpolation: the source is already band-limited to 8 kHz, so there is no
 * aliasing to guard against and a 32-tap sinc filter would just be slow.
 * Downsampling keeps the windowed-sinc filter, which does need the anti-alias.
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input

  const ratio = toRate / fromRate
  const outputLength = Math.max(1, Math.round(input.length * ratio))
  const output = new Float32Array(outputLength)
  const last = input.length - 1
  const step = 1 / ratio

  if (ratio > 1) {
    for (let i = 0; i < outputLength; i++) {
      const position = i * step
      const base = Math.floor(position)
      const t = position - base
      const p0 = input[clampIndex(base - 1, last)]
      const p1 = input[clampIndex(base, last)]
      const p2 = input[clampIndex(base + 1, last)]
      const p3 = input[clampIndex(base + 2, last)]
      const t2 = t * t
      const t3 = t2 * t

      output[i] =
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
    }

    return output
  }

  const cutoff = ratio
  const taps = 16

  for (let i = 0; i < outputLength; i++) {
    const position = i * step
    const centre = Math.floor(position)
    let sum = 0
    let weight = 0

    for (let tap = -taps + 1; tap <= taps; tap++) {
      const index = centre + tap
      const sample = input[clampIndex(index, last)]
      const x = position - index
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x)
      const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * (x + taps)) / (2 * taps))
      const coefficient = sinc * window
      sum += sample * coefficient
      weight += coefficient
    }

    output[i] = weight !== 0 ? sum / weight : input[clampIndex(Math.round(position), last)]
  }

  return output
}

/** Max-abs peaks, one entry per bucket — the data the waveform canvas draws. */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const count = Math.max(1, Math.min(buckets, samples.length))
  const size = Math.max(1, Math.floor(samples.length / count))
  const peaks = new Float32Array(count)

  for (let bucket = 0; bucket < count; bucket++) {
    const start = bucket * size
    const end = Math.min(start + size, samples.length)
    let max = 0
    for (let i = start; i < end; i++) {
      const value = Math.abs(samples[i])
      if (value > max) max = value
    }
    peaks[bucket] = max
  }

  return peaks
}

export function peakLevel(samples: Float32Array): number {
  let max = 0
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i])
    if (value > max) max = value
  }
  return max
}

function clampIndex(index: number, last: number): number {
  return index < 0 ? 0 : index > last ? last : index
}
