import type { MediaSpec } from '../types/hushwing'

/**
 * `File` has a `name`; `Blob` does not. Everywhere we accept `File | Blob`
 * we go through this helper instead of touching `.name` directly.
 */
export function fileNameOf(file: File | Blob): string | undefined {
  return 'name' in file && typeof file.name === 'string' ? file.name : undefined
}

export function fileSizeOf(file: File | Blob): number {
  return typeof file.size === 'number' ? file.size : 0
}

/**
 * Formats we recognise by name. This drives `isVideo()` and the file picker,
 * not the decode decision: `src/lib/decode.ts` tries mediabunny on anything
 * that is not a WAV and drops to ffmpeg when that fails, so a format missing
 * from this list still processes.
 */
export const SUPPORTED_SPECS: MediaSpec[] = [
  { name: 'WAV', mime: 'audio/wav', ext: '.wav' },
  { name: 'MP3', mime: 'audio/mpeg', ext: '.mp3' },
  { name: 'M4A', mime: 'audio/mp4', ext: '.m4a' },
  { name: 'AAC', mime: 'audio/aac', ext: '.aac' },
  { name: 'FLAC', mime: 'audio/flac', ext: '.flac' },
  { name: 'OGG', mime: 'audio/ogg', ext: '.ogg' },
  { name: 'OPUS', mime: 'audio/opus', ext: '.opus' },
  { name: 'MP4', mime: 'video/mp4', ext: '.mp4' },
  { name: 'M4V', mime: 'video/x-m4v', ext: '.m4v' },
  { name: 'MOV', mime: 'video/quicktime', ext: '.mov' },
  { name: 'MKV', mime: 'video/x-matroska', ext: '.mkv' },
  { name: 'WEBM', mime: 'video/webm', ext: '.webm' },
  { name: 'AVI', mime: 'video/x-msvideo', ext: '.avi' },
]

export const ACCEPT_ATTRIBUTE =
  '.wav,.mp3,.m4a,.aac,.flac,.ogg,.oga,.opus,.mp4,.m4v,.mov,.mkv,.webm,.avi,.wmv,.flv,.ogv,.ts,.3gp' +
  ',audio/*,video/*'

export function isVideo(file: File | Blob): boolean {
  if (file.type.startsWith('video/')) return true
  const spec = inferMediaSpec(file)
  return spec?.mime?.startsWith('video/') ?? false
}

export function inferMediaSpec(file: File | Blob): MediaSpec | null {
  const type = (file.type || '').toLowerCase()
  const name = (fileNameOf(file) || '').toLowerCase()

  for (const spec of SUPPORTED_SPECS) {
    if (spec.mime === type) return spec
    if (spec.ext && name.endsWith(spec.ext)) return spec
  }

  return null
}

export function extensionForSpec(spec: MediaSpec): string {
  return spec.ext ?? guessExtensionByType(spec.mime ?? '')
}

function guessExtensionByType(mime: string): string {
  const match = SUPPORTED_SPECS.find((spec) => spec.mime === mime.toLowerCase())
  return match?.ext ?? '.dat'
}

/** `<name>-enhanced.<ext>` — the extension is decided by the delivered container. */
export function suggestedOutputFilename(
  originalName: string | undefined,
  extension: string
): string {
  const base = (originalName ?? 'hushwing-output').replace(/\.[^.]+$/, '')
  return `${base}-enhanced${extension.startsWith('.') ? extension : `.${extension}`}`
}

const blobUrls = new Set<string>()

export function createMediaUrl(blob: Blob): string {
  const url = URL.createObjectURL(blob)
  blobUrls.add(url)
  return url
}

export function revokeMediaUrl(url: string): void {
  if (blobUrls.delete(url)) {
    URL.revokeObjectURL(url)
  }
}

export function disposeMediaUrls(): void {
  blobUrls.forEach((url) => URL.revokeObjectURL(url))
  blobUrls.clear()
}

/** Encode mono float samples as a 16-bit PCM WAV blob. */
export function buildWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const parts = [...encodeWavChunks(samples, sampleRate)] as unknown as BlobPart[]
  return new Blob(parts, { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) {
    view.setUint8(offset + i, value.charCodeAt(i))
  }
}

/**
 * Encode float samples as 16-bit PCM WAV chunks: a 44-byte header followed by
 * `framesPerChunk`-sized data blocks. Feeding these straight into an OPFS
 * writer keeps peak memory flat for long recordings.
 */
export function* encodeWavChunks(
  samples: Float32Array,
  sampleRate: number,
  framesPerChunk = 65_536
): Generator<Uint8Array> {
  const dataSize = samples.length * 2
  const header = new Uint8Array(44)
  const view = new DataView(header.buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  yield header

  for (let start = 0; start < samples.length; start += framesPerChunk) {
    const end = Math.min(start + framesPerChunk, samples.length)
    const block = new Uint8Array((end - start) * 2)
    const blockView = new DataView(block.buffer)

    for (let i = start; i < end; i++) {
      const sample = samples[i]
      const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample
      blockView.setInt16((i - start) * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    }

    yield block
  }
}

export interface PcmAudio {
  samples: Float32Array
  sampleRate: number
  channels: number
}

/**
 * Minimal WAV reader (PCM 8/16/24/32-bit and IEEE float). Decoding the 16 kHz
 * mono WAV ourselves avoids an `AudioContext` round trip and works inside a
 * worker, where Web Audio does not exist.
 */
export async function parseWav(blob: Blob): Promise<PcmAudio> {
  const buffer = await blob.arrayBuffer()
  const view = new DataView(buffer)

  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new Error('Unsupported audio container: expected a RIFF/WAVE file')
  }

  let offset = 12
  let format = 1
  let channels = 1
  let sampleRate = 16_000
  let bits = 16
  let dataOffset = -1
  let dataLength = 0

  while (offset + 8 <= view.byteLength) {
    const id = readTag(view, offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8

    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true) || 1
      sampleRate = view.getUint32(body + 4, true) || 16_000
      bits = view.getUint16(body + 14, true) || 16
    } else if (id === 'data') {
      dataOffset = body
      dataLength = Math.min(size, view.byteLength - body)
      break
    }

    offset = body + size + (size % 2)
  }

  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error('WAV file has no readable data chunk')
  }

  const bytesPerSample = Math.max(1, bits / 8)
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels))
  const samples = new Float32Array(Math.max(0, frameCount))
  const isFloat = format === 3

  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const index = dataOffset + (frame * channels + channel) * bytesPerSample
      sum += readSample(view, index, bits, isFloat)
    }
    samples[frame] = sum / channels
  }

  return { samples, sampleRate, channels }
}

function readSample(view: DataView, offset: number, bits: number, isFloat: boolean): number {
  if (isFloat && bits === 32) return view.getFloat32(offset, true)

  switch (bits) {
    case 8:
      return (view.getUint8(offset) - 128) / 128
    case 16:
      return view.getInt16(offset, true) / 32_768
    case 24: {
      const low = view.getUint8(offset)
      const mid = view.getUint8(offset + 1)
      const high = view.getInt8(offset + 2)
      return ((high << 16) | (mid << 8) | low) / 8_388_608
    }
    case 32:
      return view.getInt32(offset, true) / 2_147_483_648
    default:
      return 0
  }
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}
