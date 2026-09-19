/*
 * Hushwing Audio — Pipeline B preview processor (AudioWorklet).
 *
 * This file is deliberately plain JavaScript: an AudioWorklet module is loaded
 * on its own, outside the bundler, so it cannot import the TypeScript DSP. It
 * mirrors the kernels in `src/lib/dsp.ts` (high-pass → adaptive gate →
 * compressor → soft limiter) so the preview sounds like the batch render.
 *
 * Messages accepted on the port:
 *   { type: 'model',  value: 'rnnoise' | 'webaudio' }
 *   { type: 'bypass', value: true | false }
 *   { type: 'reset' }
 */

const MIN_GAIN = 0.07
const OPEN_RATIO = 4
const CLOSED_RATIO = 1.5

class HushwingPreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.model = 'webaudio'
    this.bypass = false

    this.port.onmessage = (event) => {
      const message = event.data || {}
      if (message.type === 'model') {
        this.model = message.value
        this.reset()
      } else if (message.type === 'bypass') {
        this.bypass = Boolean(message.value)
      } else if (message.type === 'reset') {
        this.reset()
      }
    }

    this.reset()
  }

  reset() {
    this.updateFilters()

    // High-pass state
    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0

    // Gate state
    this.env = 0
    this.floor = null
    this.gain = 1

    // Compressor state
    this.compEnv = 0
  }

  updateFilters() {
    const rate = sampleRate
    const frequency = this.model === 'rnnoise' ? 70 : 85
    const w0 = (2 * Math.PI * Math.min(frequency, rate * 0.45)) / rate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * 0.7071)
    const a0 = 1 + alpha

    this.b0 = (1 + cos) / 2 / a0
    this.b1 = -(1 + cos) / a0
    this.b2 = (1 + cos) / 2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0

    this.envCoef = Math.exp(-1 / Math.max(1, rate * 0.01))
    this.attackCoef = Math.exp(-1 / Math.max(1, rate * 0.003))
    this.releaseCoef = Math.exp(-1 / Math.max(1, rate * 0.12))

    if (this.model === 'rnnoise') {
      this.compThreshold = -12
      this.compRatio = 2
      this.compKnee = 6
      this.compAttack = Math.exp(-1 / Math.max(1, rate * 0.01))
      this.compRelease = Math.exp(-1 / Math.max(1, rate * 0.2))
      this.makeup = 1.1
    } else {
      this.compThreshold = -18
      this.compRatio = 3
      this.compKnee = 8
      this.compAttack = Math.exp(-1 / Math.max(1, rate * 0.004))
      this.compRelease = Math.exp(-1 / Math.max(1, rate * 0.14))
      this.makeup = 1.18
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || input.length === 0 || !output || output.length === 0) return true

    const source = input[0]
    const target = output[0]
    const gateEnabled = this.model === 'rnnoise'

    for (let i = 0; i < source.length; i++) {
      const dry = source[i]

      // High-pass (transposed direct form II)
      const y0 = this.b0 * dry + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = dry
      this.y2 = this.y1
      this.y1 = y0
      let sample = y0

      if (gateEnabled) {
        this.env = sample * sample + this.envCoef * (this.env - sample * sample)
        if (this.floor === null) this.floor = this.env
        this.floor =
          this.env < this.floor
            ? this.env + (this.floor - this.env) * 0.05
            : this.floor + (this.env - this.floor) * 0.0004

        const noise = Math.sqrt(Math.max(this.floor, 1e-10))
        const level = Math.sqrt(Math.max(this.env, 1e-10))
        const ratio = level / Math.max(noise, 1e-5)

        let gainTarget = MIN_GAIN
        if (ratio >= OPEN_RATIO) {
          gainTarget = 1
        } else if (ratio > CLOSED_RATIO) {
          const shape =
            (Math.log(ratio) - Math.log(CLOSED_RATIO)) / (Math.log(OPEN_RATIO) - Math.log(CLOSED_RATIO))
          gainTarget = MIN_GAIN + (1 - MIN_GAIN) * Math.min(1, Math.max(0, shape))
        }

        const coef = gainTarget > this.gain ? 1 - this.attackCoef : 1 - this.releaseCoef
        this.gain += (gainTarget - this.gain) * coef
        sample *= this.gain
      }

      // Compressor with soft knee
      const magnitude = Math.abs(sample)
      this.compEnv =
        magnitude > this.compEnv
          ? magnitude * (1 - this.compAttack) + this.compEnv * this.compAttack
          : magnitude * (1 - this.compRelease) + this.compEnv * this.compRelease

      const db = 20 * Math.log10(Math.max(this.compEnv, 1e-6))
      const over = db - this.compThreshold
      let reduction = 0
      if (over > this.compKnee / 2) {
        reduction = over - over / this.compRatio
      } else if (over > -this.compKnee / 2) {
        const t = over + this.compKnee / 2
        reduction = Math.max(0, ((1 / this.compRatio - 1) * t * t) / (2 * this.compKnee) * -1)
      }

      sample *= Math.pow(10, -reduction / 20) * this.makeup

      // Soft limiter — mirrors SoftLimiter in src/lib/dsp.ts (ceiling 0.98, knee 0.8)
      const peak = Math.abs(sample)
      if (peak > 0.8) {
        const over = peak - 0.8
        const limited = 0.8 + over / (1 + over / 0.18)
        sample = sample < 0 ? -limited : limited
      }

      target[i] = this.bypass ? dry : sample
    }

    return true
  }
}

registerProcessor('hushwing-preview', HushwingPreviewProcessor)
