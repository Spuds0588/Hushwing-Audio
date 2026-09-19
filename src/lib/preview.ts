import { computePeaks } from './dsp'
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
}

const WORKLET_NAME = 'hushwing-preview'
const PEAK_BUCKETS = 320

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
 * The source `<audio>` element is routed through an `AudioWorkletNode` that runs
 * the same DSP profile as the batch render (see `public/worklets/hushwing-preview.js`).
 * Both sides of the comparison stay on one signal path, so flipping between A
 * and B never re-connects the graph — it only flips a flag inside the worklet.
 */
export class PreviewSession {
  private state: PreviewState = INITIAL_STATE
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  private context: AudioContext | null = null
  private node: AudioWorkletNode | null = null
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
    this.node?.port.postMessage({ type: 'bypass', value })
  }

  setModel(model: ModelId): void {
    this.patch({ model })
    this.node?.port.postMessage({ type: 'model', value: model })
  }

  async ensureGraph(): Promise<void> {
    if (this.node && this.context && this.audio) return

    const AudioContextCtor: typeof AudioContext | undefined =
      typeof window === 'undefined'
        ? undefined
        : window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!AudioContextCtor) throw new Error('This browser does not support the Web Audio API')

    const context = new AudioContextCtor()
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
    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024

    source.connect(node)
    node.connect(analyser)
    analyser.connect(context.destination)

    node.port.postMessage({ type: 'model', value: this.state.model })
    node.port.postMessage({ type: 'bypass', value: this.state.bypassed })

    this.context = context
    this.audio = audio
    this.node = node
    this.analyser = analyser
    this.levelBuffer = new Float32Array(analyser.fftSize)
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
      this.node?.disconnect()
      this.analyser?.disconnect()
      await this.context?.close()
    } catch {
      // Nothing useful to do if the context is already gone.
    }

    this.node = null
    this.analyser = null
    this.audio = null
    this.context = null
    URL.revokeObjectURL(this.url)
  }
}
