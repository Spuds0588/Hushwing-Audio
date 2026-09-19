/*
 * Hushwing Audio — Pipeline B preview processor (AudioWorklet).
 *
 * This file is deliberately plain JavaScript: an AudioWorklet module is loaded
 * on its own, outside the bundler, so it cannot import the TypeScript DSP. It
 * mirrors `createKernel('webaudio', 16000)` in `src/lib/dsp.ts` — RBJ high-pass
 * → soft-knee compressor → soft limiter — so the preview sounds like the batch
 * render. Change both together.
 *
 * RNNoise is not here: it is WebAssembly and runs in its own processor, which
 * the preview graph wires alongside this one (see `src/lib/preview.ts`).
 *
 * Messages accepted on the port:
 *   { type: 'reset' }
 */

/** Mirrors the coefficient set `createKernel` builds for `webaudio`. */
const HIGHPASS_HZ = 85
const COMP = {
  threshold: -18,
  ratio: 3,
  knee: 8,
  attack: 0.004,
  release: 0.14,
  makeup: 1.18,
}
const LIMITER = { ceiling: 0.98, threshold: 0.8 }

class HushwingPreviewProcessor extends AudioWorkletProcessor {
  constructor() {
    super()

    this.port.onmessage = (event) => {
      const message = event.data || {}
      if (message.type === 'reset') this.reset()
    }

    this.mono = null
    this.reset()
  }

  reset() {
    const rate = sampleRate
    const w0 = (2 * Math.PI * Math.min(HIGHPASS_HZ, rate * 0.45)) / rate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * 0.7071)
    const a0 = 1 + alpha

    this.b0 = (1 + cos) / 2 / a0
    this.b1 = -(1 + cos) / a0
    this.b2 = (1 + cos) / 2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0

    this.x1 = 0
    this.x2 = 0
    this.y1 = 0
    this.y2 = 0

    this.compEnv = 0
    this.compAttack = Math.exp(-1 / Math.max(1e-5, COMP.attack * rate))
    this.compRelease = Math.exp(-1 / Math.max(1e-5, COMP.release * rate))
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true

    const frames = input[0].length
    if (!this.mono || this.mono.length !== frames) this.mono = new Float32Array(frames)
    const mono = this.mono
    const channels = input.length

    for (let i = 0; i < frames; i++) {
      let sum = 0
      for (let channel = 0; channel < channels; channel++) {
        const data = input[channel]
        sum += data ? data[i] : 0
      }
      mono[i] = sum / channels
    }

    for (let i = 0; i < frames; i++) {
      const dry = mono[i]

      // High-pass, transposed direct form II.
      const highpassed =
        this.b0 * dry + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1
      this.x1 = dry
      this.y2 = this.y1
      this.y1 = highpassed

      // Compressor with a quadratic soft knee.
      const magnitude = Math.abs(highpassed)
      this.compEnv =
        magnitude > this.compEnv
          ? magnitude * (1 - this.compAttack) + this.compEnv * this.compAttack
          : magnitude * (1 - this.compRelease) + this.compEnv * this.compRelease

      const db = 20 * Math.log10(Math.max(this.compEnv, 1e-6))
      const over = db - COMP.threshold
      let reduction = 0
      if (over > COMP.knee / 2) {
        reduction = over - over / COMP.ratio
      } else if (over > -COMP.knee / 2) {
        const t = over + COMP.knee / 2
        reduction = Math.max(0, (((1 / COMP.ratio - 1) * t * t) / (2 * COMP.knee)) * -1)
      }

      let sample = highpassed * Math.pow(10, -reduction / 20) * COMP.makeup

      // Soft limiter — mirrors SoftLimiter in src/lib/dsp.ts.
      const peak = Math.abs(sample)
      if (peak > LIMITER.threshold) {
        const excess = peak - LIMITER.threshold
        const range = LIMITER.ceiling - LIMITER.threshold
        const limited = LIMITER.threshold + excess / (1 + excess / range)
        sample = sample < 0 ? -limited : limited
      }

      mono[i] = sample
    }

    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(mono)
    }

    return true
  }
}

registerProcessor('hushwing-preview', HushwingPreviewProcessor)
