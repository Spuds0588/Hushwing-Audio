export type ModelId = 'rnnoise' | 'webaudio' | 'deepfilternet'

export type JobStatus = 'queued' | 'preparing' | 'processing' | 'completed' | 'error'

export type OutputFormat = 'wav' | 'video'

export interface MediaSpec {
  name: string
  mime?: string
  ext?: string
}

export const SUPPORTED_AUDIO: MediaSpec[] = [
  { name: 'WAV', mime: 'audio/wav', ext: '.wav' },
  { name: 'MP3', mime: 'audio/mpeg', ext: '.mp3' },
  { name: 'M4A', mime: 'audio/mp4', ext: '.m4a' },
  { name: 'FLAC', mime: 'audio/flac', ext: '.flac' },
  { name: 'OGG', mime: 'audio/ogg', ext: '.ogg' },
]

export const SUPPORTED_VIDEO: MediaSpec[] = [
  { name: 'MP4', mime: 'video/mp4', ext: '.mp4' },
  { name: 'MOV', mime: 'video/quicktime', ext: '.mov' },
  { name: 'MKV', mime: 'video/x-matroska', ext: '.mkv' },
  { name: 'WEBM', mime: 'video/webm', ext: '.webm' },
  { name: 'AVI', mime: 'video/x-msvideo', ext: '.avi' },
]

export const SUPPORTED_MEDIA: MediaSpec[] = [...SUPPORTED_AUDIO, ...SUPPORTED_VIDEO]

export interface Job {
  id: string
  /** The dropped file, kept so the queue can be re-run. */
  original: File | Blob | null
  /** Display name, captured at enqueue time so the UI never reads `File.name`. */
  sourceName: string
  sourceKind: 'audio' | 'video'
  status: JobStatus
  model: ModelId
  outputFormat: OutputFormat
  /** 0–100, coarse stage progress for the queue UI. */
  progress: number
  /** Human-readable description of the current stage. */
  stage?: string
  error?: string
  /** Non-fatal note, e.g. muxing failed and the enhanced audio was exported instead. */
  warning?: string
  /**
   * Which decoder produced the PCM: `wav reader`, `mp3`, `flac`, `opus`, or
   * `ffmpeg` when the container needed the 32 MB core.
   */
  decoder?: string
  /** Object URL of the finished result, ready for a download link. */
  resultUrl?: string
  /** Virtual path of the staged input inside OPFS. */
  stagePath?: string
  /** Virtual path of the finished result inside OPFS. */
  resultPath?: string
  /** Suggested download filename for the result. */
  outputName?: string
  /** Size of the result in bytes. */
  outputSize?: number
  /** Duration of the source in seconds, when known. */
  duration?: number
  createdAt: number
  startedAt?: number
  completedAt?: number
  durationMs?: number
}

export interface LogEntry {
  time: number
  tag: 'info' | 'warn' | 'error' | 'debug'
  message: string
}

/** What an engine hands back: enhanced PCM, not an encoded file. */
export interface EngineResult {
  samples: Float32Array
  sampleRate: number
  channelCount: number
}

export interface AppUrlParams {
  model?: ModelId
  autostart?: boolean
  debug?: boolean
}
