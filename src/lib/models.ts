import type { ModelId } from '../types/hushwing'

export interface ModelSpec {
  id: ModelId
  /** Short name shown in the selector. */
  label: string
  /** One-line description shown in the model card. */
  description: string
  tags: string[]
  /** False → the option renders disabled. */
  ready: boolean
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
    implementation:
      'Pure-JS chain: RBJ high-pass biquad → soft-knee compressor → soft limiter, so it renders in a worker without an AudioContext.',
  },
  {
    id: 'rnnoise',
    label: 'RNNoise-class denoiser',
    description:
      'Adaptive noise gate driven by a measured noise floor. Removes steady hiss and hum while leaving speech untouched.',
    tags: ['fast', 'offline', 'speech-first'],
    ready: true,
    implementation:
      'Ships a framed gate/expander DSP profile. The id stays `rnnoise` for API compatibility; the RNNoise WASM weights are a drop-in follow-up.',
  },
  {
    id: 'deepfilternet',
    label: 'DeepFilterNet 3',
    description:
      'Studio-grade neural suppression for complex, non-stationary background noise. Not available in this build.',
    tags: ['neural', 'planned'],
    ready: false,
    implementation: 'Not implemented yet.',
  },
]

export function getModelSpec(id: ModelId): ModelSpec | undefined {
  return MODEL_SPECS.find((spec) => spec.id === id)
}

/** Only the models that actually run, i.e. what the headless API may advertise. */
export function availableModelIds(): ModelId[] {
  return MODEL_SPECS.filter((spec) => spec.ready).map((spec) => spec.id)
}

export function isModelId(value: string): value is ModelId {
  return MODEL_SPECS.some((spec) => spec.id === value)
}
