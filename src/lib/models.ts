import type { ModelId } from '../types/hushwing'

export interface ModelSpec {
  id: ModelId
  /** Short name shown on the engine card. */
  label: string
  /** One-line description shown under the name. */
  description: string
  tags: string[]
  /** False → the engine renders disabled. */
  ready: boolean
  /**
   * The rate the engine wants its input at. Audio is decoded and resampled to
   * this before it reaches the kernel, and the result is lifted to 48 kHz for
   * delivery.
   *
   * - 16 kHz for the voice-band Web Audio chain, which is a telephone-band
   *   chain by design: the band limit is part of what removes wideband hiss.
   * - 48 kHz for RNNoise, which is trained at 48 kHz and refuses anything else.
   */
  inferenceRate: number
  /** Present-tense note about what is actually implemented. */
  implementation: string
}

export const MODEL_SPECS: ModelSpec[] = [
  {
    id: 'webaudio',
    label: 'Native Web Audio',
    description:
      'High-pass filter, downward expander and dynamic compressor. Instant, zero download, good for steady room tone and level matching.',
    tags: ['instant', 'no download', 'offline'],
    ready: true,
    inferenceRate: 16_000,
    implementation:
      'Pure-JS chain rendered in a worker: RBJ high-pass biquad → adaptive noise-floor gate → soft-knee compressor → soft limiter. No AudioContext needed.',
  },
  {
    id: 'rnnoise',
    label: 'RNNoise',
    description:
      'Recurrent neural network trained on speech. Removes steady hiss, hum and fan noise while leaving speech untouched.',
    tags: ['neural', 'wasm', '48 kHz'],
    ready: true,
    inferenceRate: 48_000,
    implementation:
      'Real RNNoise (Shiguredo WebAssembly build) driven through an offline audio graph in the page — the same path the delivered file takes.',
  },
  {
    id: 'deepfilternet',
    label: 'DeepFilterNet 3',
    description:
      'Studio-grade neural suppression for complex, non-stationary background noise. Not available in this build.',
    tags: ['neural', 'planned'],
    ready: false,
    inferenceRate: 48_000,
    implementation: 'Not implemented yet.',
  },
]

export function getModelSpec(id: ModelId): ModelSpec | undefined {
  return MODEL_SPECS.find((spec) => spec.id === id)
}

/** The rate a model's kernel expects its input at. */
export function inferenceRateFor(id: ModelId): number {
  return getModelSpec(id)?.inferenceRate ?? 48_000
}

/** Only the models that actually run, i.e. what the headless API may advertise. */
export function availableModelIds(): ModelId[] {
  return MODEL_SPECS.filter((spec) => spec.ready).map((spec) => spec.id)
}

export function isModelId(value: string): value is ModelId {
  return MODEL_SPECS.some((spec) => spec.id === value)
}
