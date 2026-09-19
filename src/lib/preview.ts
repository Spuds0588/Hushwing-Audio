import { computePeaks } from './dsp'
import { RNNOISE_RATE, createRnnoisePreviewNode } from './rnnoise'
import { logger } from './logger'
import type { ModelId } from '../types/hushwing'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface PreviewState {
  status: PreviewStatus
  playing: boolean
  currentTime: number
  duration: number
  /** True while listening to the untouched input track (the "A" side). */
  bypassed: boolean
  model: ModelId
  peaks: Float32Array | null
  /** Output level, 0–1, for the meter. */
  level: number
  error?: string
  /** Non-fatal caveat, e.g. RNNoise live preview unavailable at this rate. */
  note?: string
}

const WORKLET_NAME = 'hushwing-preview'
const PEAK_BUCKETS = 320
/** Short enough to feel instant, long enough not to click when A/B is switched. */
const CROSSFADE = 0.02

const INITIAL_STATE: PreviewState = {
  status: 'idle',
  playing: false,
  currentTime: 0,
  duration: 0,
  bypassed: false,
  model: 'webaudio',
  peaks: null,
  level: 0,
}

/**
 * Pipeline B — real-time A/B preview.
 *
 * The graph is built once and never rewired:
 *
 * ```
 *                 ┌─ dry ─────────────────────┐
 *   source ───────┤                            │
 *                 ├─ dsp worklet ─ dsp gain ───┼──→ analyser → speakers
 *                 └─ rnnoise ─── rnnoise gain ┘
 * ```
 *
 * Switching A/B only moves gains, so the comparison never stops the audio, and
 * the "wet" branch is whichever engine is selected. The dry branch is a true
 * bypass, which is the honest thing to compare against.
 */
export class PreviewSession {
  private state: PreviewState = INITIAL_STATE
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  private context: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private dspNode: AudioWorkletNode | null = null
  private rnnoiseNode: AudioWorkletNode | null = null
  private dryGain: GainNode | null = null
  private dspGain: GainNode | null = null
  private rnnoiseGain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Float32Array<ArrayBuffer> | null = null
  private url: string
  private frame = 0
  private disposed = false
  private readonly file: Blob

  constructor(file: Blob, model: ModelId = 'webaudio') {
    this.file = file
    this.url = URL.createObjectURL(file)
    this.state = { ...INITIAL_STATE, model }
  }

  getState = (): PreviewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Decode peaks + duration up front; no audio context is created yet. */
  async load(): Promise<void> {
    if (this.disposed) return
    this.patch({ status: 'loading' })

    try {
      const bytes = await this.file.arrayBuffer()
      const decoder = new OfflineAudioContext(1, 1, 48_000)
      const buffer = await decoder.decodeAudioData(bytes)
      const peaks = computePeaks(buffer.getChannelData(0), PEAK_BUCKETS)

      this.patch({
        status: 'ready',
        duration: buffer.duration,
        peaks,
      })
      logger.info(`preview ready: ${buffer.duration.toFixed(1)}s, ${buffer.sampleRate}Hz`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not decode this file'
      logger.warn(`preview unavailable: ${message}`)
      this.patch({ status: 'error', error: message })
    }
  }

  async play(): Promise<void> {
    if (this.disposed) return

    try {
      await this.ensureGraph()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Audio preview is unavailable'
      logger.error(`preview failed: ${message}`)
      this.patch({ status: 'error', error: message })
      return
    }

    await this.context?.resume()
    await this.audio?.play()
    this.patch({ playing: true })
    this.startMeter()
  }

  pause(): void {
    this.audio?.pause()
    this.stopMeter()
    this.patch({ playing: false, level: 0 })
  }

  /** Seek to a 0–1 position of the whole file. */
  seek(ratio: number): void {
    if (!this.audio || !Number.isFinite(this.audio.duration)) return
    const position = Math.max(0, Math.min(1, ratio)) * this.audio.duration
    this.audio.currentTime = position
    this.patch({ currentTime: position })
  }

  setBypassed(value: boolean): void {
    this.patch({ bypassed: value })
    this.route()
  }

  /**
   * Switch the live engine. The graph is reused: either the Web Audio worklet
   * or an RNNoise node is the wet branch, and the other one is silenced.
   */
  async setModel(model: ModelId): Promise<void> {
    // Re-selecting the current engine is a no-op unless the last attempt left a
    // caveat behind, in which case it is worth trying again.
    const unchanged = this.state.model === model
    if (unchanged && this.state.note === undefined) return
    this.patch({ model })

    if (!this.context) return

    if (model === 'rnnoise' && !this.rnnoiseNode) {
      try {
        const node = await createRnnoisePreviewNode(this.context)
        if (node) {
          this.source?.connect(node)
          if (this.rnnoiseGain) node.connect(this.rnnoiseGain)
          this.rnnoiseNode = node
          this.patch({ note: undefined })
        } else {
          this.patch({
            note: 'RNNoise needs a 48 kHz audio device; the live preview is showing the Web Audio chain instead. Batch processing still uses RNNoise.',
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'RNNoise could not load'
        logger.warn(`rnnoise preview unavailable: ${message}`)
        this.patch({ note: `RNNoise live preview unavailable (${message}). Batch processing still uses it.` })
      }
    }

    this.route()
  }

  async ensureGraph(): Promise<void> {
    if (this.dspNode && this.context && this.audio) return

    const AudioContextCtor: typeof AudioContext | undefined =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API')

    // Ask for 48 kHz rather than accepting the device rate: the preview is
    // compared against the 48 kHz delivery, and RNNoise only runs at 48 kHz.
    // A browser that ignores the hint still gets a working Web Audio preview.
    const context = new AudioContextCtor({ sampleRate: RNNOISE_RATE })
    if (!context.audioWorklet) {
      throw new Error('This browser does not support AudioWorklet, so live preview is unavailable')
    }

    const workletUrl = `${import.meta.env.BASE_URL}worklets/hushwing-preview.js`
    await context.audioWorklet.addModule(workletUrl)

    const audio = new Audio(this.url)
    audio.preload = 'auto'
    audio.crossOrigin = 'anonymous'
    audio.addEventListener('ended', () => {
      this.stopMeter()
      this.patch({ playing: false, level: 0, currentTime: 0 })
    })
    audio.addEventListener('pause', () => {
      this.stopMeter()
      this.patch({ playing: false, level: 0 })
    })

    const source = context.createMediaElementSource(audio)
    const dspNode = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const dryGain = context.createGain()
    const dspGain = context.createGain()
    const rnnoiseGain = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024

    dryGain.gain.value = 0
    dspGain.gain.value = 0
    rnnoiseGain.gain.value = 0

    source.connect(dryGain)
    source.connect(dspNode)
    dspNode.connect(dspGain)
    dryGain.connect(analyser)
    dspGain.connect(analyser)
    rnnoiseGain.connect(analyser)
    analyser.connect(context.destination)

    this.context = context
    this.source = source
    this.audio = audio
    this.dspNode = dspNode
    this.dryGain = dryGain
    this.dspGain = dspGain
    this.rnnoiseGain = rnnoiseGain
    this.analyser = analyser
    this.levelBuffer = new Float32Array(analyser.fftSize)

    await this.setModel(this.state.model)
    this.route()
  }

  /** Point the output at the dry branch or at the selected engine. */
  private route(): void {
    const context = this.context
    if (!context) return

    const bypassed = this.state.bypassed
    const useRnnoise = this.state.model === 'rnnoise' && this.rnnoiseNode !== null

    this.rampTo(this.dryGain, bypassed ? 1 : 0)
    this.rampTo(this.dspGain, !bypassed && !useRnnoise ? 1 : 0)
    this.rampTo(this.rnnoiseGain, !bypassed && useRnnoise ? 1 : 0)
  }

  private rampTo(gain: GainNode | null, value: number): void {
    if (!gain || !this.context) return
    // Cancel first: repeated switches must not stack ramps on top of each other.
    gain.gain.cancelScheduledValues(this.context.currentTime)
    gain.gain.setValueAtTime(gain.gain.value, this.context.currentTime)
    gain.gain.linearRampToValueAtTime(value, this.context.currentTime + CROSSFADE)
  }

  private startMeter() {
    if (this.frame) return

    const tick = () => {
      if (this.disposed) return
      this.frame = requestAnimationFrame(tick)

      const audio = this.audio
      if (!audio) return

      let level = this.state.level
      if (this.analyser && this.levelBuffer) {
        this.analyser.getFloatTimeDomainData(this.levelBuffer)
        let sum = 0
        for (let i = 0; i < this.levelBuffer.length; i++) {
          sum += this.levelBuffer[i] * this.levelBuffer[i]
        }
        const rms = Math.sqrt(sum / this.levelBuffer.length)
        level = Math.min(1, rms * 3.2)
      }

      this.patch({ currentTime: audio.currentTime, level })
    }

    this.frame = requestAnimationFrame(tick)
  }

  private stopMeter() {
    if (!this.frame) return
    cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private patch(patch: Partial<PreviewState>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    this.stopMeter()
    this.listeners.clear()
    this.audio?.pause()

    try {
      this.dspNode?.disconnect()
      this.source?.disconnect()
      this.dryGain?.disconnect()
      this.dspGain?.disconnect()
      this.rnnoiseGain?.disconnect()
      this.rnnoiseNode?.disconnect()
      this.analyser?.disconnect()
      await this.context?.close()
    } catch {
      // Nothing useful to do if the context is already gone.
    }

    this.dspNode = null
    this.rnnoiseNode = null
    this.source = null
    this.dryGain = null
    this.dspGain = null
    this.rnnoiseGain = null
    this.analyser = null
    this.audio = null
    this.context = null
    URL.revokeObjectURL(this.url)
  }
}
