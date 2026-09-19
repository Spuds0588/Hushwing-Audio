import { parseWav, type PcmAudio } from './filekit'
import { logger } from './logger'

/**
 * Audio extraction without ffmpeg — the fast path.
 *
 * Three tiers, cheapest first:
 *
 * 1. **WAV** is parsed here, in plain JavaScript. No dependency, no codec
 *    support needed, and it works everywhere.
 * 2. **Everything else** goes through `mediabunny`, which demuxes the container
 *    (MP4, MOV, MKV, WebM, WAV, MP3, Ogg, FLAC, ADTS, MPEG-TS) and decodes the
 *    track with the browser's own WebCodecs decoders. That covers MP3, FLAC,
 *    AAC/M4A, Vorbis and Opus — the formats a recorder actually produces — and
 *    it can also read the audio track out of a video without the 32 MB core.
 * 3. **Anything mediabunny cannot open or this browser cannot decode** — AVI,
 *    WMV, FLV, exotic codecs — returns `null` and `src/lib/pipeline.ts` falls
 *    back to ffmpeg, which reads everything.
 *
 * Both decoders are imported lazily, so a queue of WAVs downloads neither and a
 * queue of videos still never loads the mediabunny bundle.
 */

export interface DecodeOptions {
  /** 0–1, called as audio is decoded. Only meaningful for long inputs. */
  onProgress?: (fraction: number) => void
}

export interface DecodedAudio extends PcmAudio {
  /** Which decoder produced it, for the job log. */
  decoder: string
}

/** Extensions ffmpeg has to handle — the preload heuristic in `App.tsx` uses this. */
const FFMPEG_ONLY_EXTENSIONS = new Set([
  'avi',
  'wmv',
  'wma',
  'flv',
  'f4v',
  'mpg',
  'mpeg',
  'm2v',
  'ts',
  'm2ts',
  'mts',
  '3gp',
  '3g2',
  'ogv',
  'asf',
  'rm',
  'rmvb',
  'vob',
  'amr',
  'aiff',
  'aif',
  'caf',
  'ape',
  'wv',
])

function extensionOf(name: string | undefined): string | null {
  if (!name) return null
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : null
}

/**
 * Whether this file is likely to need the ffmpeg core.
 *
 * Video always does (the enhanced track has to be muxed back into a container),
 * and so does any container mediabunny cannot open. Everything else — the
 * formats a recorder produces — is decoded natively.
 */
export function mayNeedFfmpeg(name: string | undefined, sourceKind: 'audio' | 'video'): boolean {
  if (sourceKind === 'video') return true
  const extension = extensionOf(name)
  if (!extension) return true
  return FFMPEG_ONLY_EXTENSIONS.has(extension)
}

export function isFfmpegOnlyExtension(name: string | undefined): boolean {
  const extension = extensionOf(name)
  return extension === null || FFMPEG_ONLY_EXTENSIONS.has(extension)
}

/** True when this file is a WAV we can read with no decoder at all. */
function isWav(blob: Blob, name: string | undefined): boolean {
  if (extensionOf(name) === 'wav' || extensionOf(name) === 'wave') return true
  return blob.type === 'audio/wav' || blob.type === 'audio/x-wav' || blob.type === 'audio/wave'
}

/**
 * Decode a file to mono float samples.
 *
 * - `null` means "not my format, use ffmpeg".
 * - A thrown error means "I tried and failed" — the caller still falls back to
 *   ffmpeg, but the log says why.
 */
export async function decodeAudio(
  source: Blob,
  name: string | undefined,
  options: DecodeOptions = {}
): Promise<DecodedAudio | null> {
  const { onProgress } = options

  if (isWav(source, name)) {
    // Already a container we can read directly, so nothing is downloaded at all.
    const wav = await parseWav(source)
    onProgress?.(1)
    return { ...wav, decoder: 'wav reader' }
  }

  return decodeWithMediabunny(source, { onProgress })
}

/**
 * Demux with mediabunny and decode with the browser's WebCodecs decoders.
 *
 * `AudioBufferSink` hands back `AudioBuffer`s, which is what we want: the SDK
 * deals with sample formats and hands us float channel data directly.
 */
async function decodeWithMediabunny(
  source: Blob,
  { onProgress }: DecodeOptions
): Promise<DecodedAudio | null> {
  const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = await import('mediabunny')

  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS })

  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return null

    // `canDecode()` asks the browser's own codec support, so an unsupported
    // codec is a clean fall-through to ffmpeg instead of a mid-stream error.
    if (!(await track.canDecode())) {
      logger.debug(`mediabunny cannot decode this track in this browser; using ffmpeg`)
      return null
    }

    const sampleRate = await track.getSampleRate()
    const channels = await track.getNumberOfChannels()
    const duration = await input.getDurationFromMetadata().catch(() => null)

    const sink = new AudioBufferSink(track)
    const parts: Float32Array[] = []
    let frames = 0

    for await (const { buffer } of sink.buffers()) {
      const channelData: Float32Array[] = []
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        channelData.push(buffer.getChannelData(channel))
      }

      const part = downmix(channelData)
      parts.push(part)
      frames += part.length

      if (duration && duration > 0) {
        onProgress?.(Math.min(1, frames / sampleRate / duration))
      }
    }

    if (frames === 0) throw new Error('mediabunny decoded no audio from this file')

    const mono = join(parts, frames)
    logger.debug(`mediabunny decoded ${frames} frames @ ${sampleRate}Hz (${channels}ch)`)
    return { samples: mono, sampleRate, channels, decoder: 'mediabunny' }
  } finally {
    input.dispose()
  }
}

/** Concatenate decoded blocks into one buffer. */
function join(parts: Float32Array[], frames: number): Float32Array {
  if (parts.length === 1) return parts[0]

  const joined = new Float32Array(frames)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.length
  }
  return joined
}

/** Average every channel into one. The pipeline is mono end to end. */
export function downmix(channelData: Float32Array[]): Float32Array {
  if (channelData.length === 0) return new Float32Array(0)
  if (channelData.length === 1) return channelData[0]

  const frames = Math.min(...channelData.map((channel) => channel.length))
  const mono = new Float32Array(frames)

  for (let channel = 0; channel < channelData.length; channel++) {
    const data = channelData[channel]
    for (let i = 0; i < frames; i++) mono[i] += data[i] / channelData.length
  }

  return mono
}
