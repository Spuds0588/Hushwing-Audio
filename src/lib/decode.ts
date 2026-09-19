import { parseWav, type PcmAudio } from './filekit'
import { logger } from './logger'

/**
 * Audio decoding without ffmpeg.
 *
 * The 32 MB ffmpeg core is worth loading to demux a video, but it is a silly
 * price for an MP3. MP3 and FLAC have small WebAssembly decoders that run in
 * plain JavaScript (and WAV needs no decoder at all), so those jobs start
 * immediately instead of waiting on the ffmpeg core.
 *
 * The decoders are imported lazily, so a queue of videos never downloads them
 * and a queue of MP3s never downloads ffmpeg.
 *
 * Anything not covered here — M4A/AAC, Ogg/Vorbis, Ogg/Opus, every video
 * container — goes through ffmpeg, which is exactly what `src/lib/pipeline.ts`
 * falls back to when this returns `null`.
 */

export type NativeAudioKind = 'wav' | 'mp3' | 'flac'

export interface DecodedAudio extends PcmAudio {
  /** Which decoder produced it, for the job log. */
  decoder: string
}

const KIND_BY_EXTENSION: Record<string, NativeAudioKind> = {
  wav: 'wav',
  wave: 'wav',
  mp3: 'mp3',
  mp2: 'mp3',
  mpa: 'mp3',
  flac: 'flac',
}

/** The decoder that can read this filename, or null if ffmpeg has to do it. */
export function nativeKindFor(name: string | undefined): NativeAudioKind | null {
  if (!name) return null
  const extension = name.split('.').pop()?.toLowerCase()
  return extension ? (KIND_BY_EXTENSION[extension] ?? null) : null
}

/**
 * Decode a file with a JavaScript decoder.
 *
 * - `null` means "not my format, use ffmpeg" (Ogg-Vorbis, an unknown extension).
 * - A thrown error means "I tried and failed" — the caller still falls back to
 *   ffmpeg, but the log says why.
 */
export async function decodeAudioNatively(
  blob: Blob,
  name: string | undefined
): Promise<DecodedAudio | null> {
  const kind = nativeKindFor(name)
  if (!kind) return null

  if (kind === 'wav') {
    // Already a container we can read directly, so nothing is downloaded at all.
    return { ...(await parseWav(blob)), decoder: 'wav reader' }
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  logger.debug(`decoding ${name} with the ${kind} decoder`)

  switch (kind) {
    case 'mp3':
      return decodeMpeg(bytes)
    case 'flac':
      return decodeFlac(bytes)
    default:
      return null
  }
}

async function decodeMpeg(bytes: Uint8Array): Promise<DecodedAudio> {
  const { MPEGDecoder } = await import('mpg123-decoder')
  const decoder = new MPEGDecoder()
  try {
    await decoder.ready
    const decoded = await decoder.decode(bytes)
    return finish('mp3', decoded.channelData, decoded.sampleRate, decoded.samplesDecoded)
  } finally {
    decoder.free()
  }
}

async function decodeFlac(bytes: Uint8Array): Promise<DecodedAudio> {
  const { FLACDecoder } = await import('@wasm-audio-decoders/flac')
  const decoder = new FLACDecoder()
  try {
    await decoder.ready
    const decoded = await decoder.decode(bytes)
    return finish('flac', decoded.channelData, decoded.sampleRate, decoded.samplesDecoded)
  } finally {
    decoder.free()
  }
}

function finish(
  decoder: string,
  channelData: Float32Array[],
  sampleRate: number,
  samplesDecoded: number
): DecodedAudio {
  if (samplesDecoded <= 0 || channelData.length === 0) {
    throw new Error(`The ${decoder} decoder produced no audio`)
  }

  return { samples: downmix(channelData), sampleRate, channels: channelData.length, decoder }
}

/** Average every channel into one. The pipeline is mono end to end. */
export function downmix(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 1) return channelData[0]

  const frames = Math.min(...channelData.map((channel) => channel.length))
  const mono = new Float32Array(frames)

  for (let channel = 0; channel < channelData.length; channel++) {
    const data = channelData[channel]
    for (let i = 0; i < frames; i++) mono[i] += data[i] / channelData.length
  }

  return mono
}

