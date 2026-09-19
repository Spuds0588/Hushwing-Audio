import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'
import { logger } from './logger'
import { writeDataToOPFS } from './opfs'
import { fileNameOf } from './filekit'

/**
 * Single-threaded core: no SharedArrayBuffer and therefore no cross-origin
 * isolation requirement. The binary is fetched once and cached by the browser.
 *
 * It must be the **ESM** core build. `@ffmpeg/ffmpeg` always spawns a module
 * worker, where `importScripts()` does not exist and the loader falls back to
 * `import(coreURL)` — importing the UMD build yields no default export and the
 * load fails with "failed to import ffmpeg-core.js".
 *
 * Set `VITE_FFMPEG_CORE_BASE` to a same-origin path (for example
 * `/ffmpeg-core`) if you would rather vendor `ffmpeg-core.js` +
 * `ffmpeg-core.wasm` than pull them from a CDN.
 *
 * Known v1 limitation: `@ffmpeg/ffmpeg` 0.12 exposes no way to mount OPFS, so
 * the input bytes are staged in the WASM filesystem (RAM) during the ffmpeg
 * step. Everything before and after it streams through OPFS.
 */
const CORE_VERSION = '0.12.6'
const DEFAULT_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`

let resolvedCoreBase: string | null = null

/**
 * Prefer a same-origin copy of the core (emitted into `dist/ffmpeg-core` by
 * `vite.config.ts`) so a deployed build requests nothing but its own origin.
 * Falls back to the CDN in dev, where those files do not exist yet.
 */
async function coreBase(): Promise<string> {
  if (resolvedCoreBase) return resolvedCoreBase

  const override = import.meta.env.VITE_FFMPEG_CORE_BASE as string | undefined
  if (override && override.length > 0) {
    resolvedCoreBase = override.replace(/\/$/, '')
    return resolvedCoreBase
  }

  const local = `${import.meta.env.BASE_URL}ffmpeg-core`
  try {
    const probe = await fetch(`${local}/ffmpeg-core.wasm`, { method: 'HEAD' })
    const type = probe.headers.get('content-type') ?? ''
    if (probe.ok && !type.includes('text/html')) {
      resolvedCoreBase = local.replace(/\/$/, '')
      return resolvedCoreBase
    }
  } catch {
    // Network/offline: the CDN attempt below will surface a useful error.
  }

  resolvedCoreBase = DEFAULT_CORE_BASE
  return resolvedCoreBase
}

export type ProgressCallback = (fraction: number, note: string) => void

let ffmpeg: FFmpeg | null = null
let loading: Promise<FFmpeg> | null = null

export function isFFmpegReady(): boolean {
  return ffmpeg !== null
}

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg) return ffmpeg
  if (loading) return loading

  loading = (async () => {
    const instance = new FFmpeg()
    const base = await coreBase()

    logger.info(`Loading ffmpeg.wasm core ${CORE_VERSION} from ${base}`)
    await instance.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    })

    ffmpeg = instance
    logger.info('ffmpeg.wasm core ready')
    return instance
  })()

  try {
    return await loading
  } catch (error) {
    loading = null
    const message = describeError(error)
    logger.error(`ffmpeg.wasm failed to load: ${message}`)
    throw new Error(
      `Could not load the ffmpeg.wasm core (${message}). Check the network connection or set VITE_FFMPEG_CORE_BASE.`
    )
  }
}

/**
 * The ffmpeg worker reports failures as plain strings (`e.toString()`), so a
 * naive `error instanceof Error` check throws away the only useful detail.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return 'unserialisable error'
    }
  }
  return String(error)
}

/** Warm the core up in the background so the first job is not slowed by it. */
export function preloadFFmpeg(): void {
  getFFmpeg().catch(() => undefined)
}

interface FfmpegRun {
  /** Named inputs, written into the ffmpeg virtual filesystem before the run. */
  inputs: { name: string; data: Blob }[]
  /** File to read back out of the virtual filesystem afterwards. */
  outputName: string
  /** Builds argv from the concrete input names. */
  args: (names: string[]) => string[]
  label: string
  onProgress?: ProgressCallback
}

function parseDurationSeconds(line: string): number | null {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line)
  if (!match) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

async function run({
  inputs,
  outputName,
  args,
  label,
  onProgress,
}: FfmpegRun): Promise<Blob> {
  const core = await getFFmpeg()

  let duration = 0
  const onLog = ({ message }: { message: string }) => {
    logger.debug(`[ffmpeg] ${message}`)
    const parsed = parseDurationSeconds(message)
    if (parsed) duration = parsed
  }
  const onTick = ({ progress, time }: { progress: number; time: number }) => {
    if (!onProgress) return
    const fraction =
      duration > 0
        ? Math.min(1, Math.max(0, time / 1_000_000 / duration))
        : Math.min(1, Math.max(0, progress))
    onProgress(fraction, label)
  }

  core.on('log', onLog)
  core.on('progress', onTick)

  try {
    for (const { name, data } of inputs) {
      logger.debug(`[ffmpeg] writing ${name} (${data.size} bytes)`)
      await core.writeFile(name, new Uint8Array(await data.arrayBuffer()))
    }

    const argv = args(inputs.map((input) => input.name))
    logger.debug(`[ffmpeg] exec ${argv.join(' ')}`)
    onProgress?.(0, label)

    const code = await core.exec(argv)
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code} while trying to ${label}`)
    }

    const output = await core.readFile(outputName)
    if (!output) throw new Error(`ffmpeg did not produce ${outputName}`)

    const bytes = typeof output === 'string' ? new TextEncoder().encode(output) : output
    onProgress?.(1, label)
    return new Blob([bytes as unknown as BlobPart])
  } finally {
    core.off('log', onLog)
    core.off('progress', onTick)

    // Release the virtual filesystem entries for this job.
    await core.deleteFile(outputName).catch(() => undefined)
    await Promise.all(
      inputs.map((input) => core.deleteFile(input.name).catch(() => undefined))
    )
  }
}

/** Extract a mono 16 kHz PCM WAV track from any supported audio or video file. */
export async function extractAudioToWav(
  input: Blob,
  inputName: string,
  onProgress?: ProgressCallback
): Promise<Blob> {
  const dot = inputName.lastIndexOf('.')
  const extension = dot > 0 ? inputName.slice(dot) : ''
  const inName = `input${extension || '.bin'}`
  const outName = 'extracted.wav'

  logger.info(`Extracting audio track → 16 kHz mono WAV (${inputName})`)

  return run({
    label: 'extracting the audio track',
    onProgress,
    inputs: [{ name: inName, data: input }],
    outputName: outName,
    args: ([source]) => [
      '-hide_banner',
      '-i',
      source,
      '-vn',
      '-acodec',
      'pcm_s16le',
      '-ac',
      '1',
      '-ar',
      '16000',
      outName,
    ],
  })
}

let encoderList: Set<string> | null = null

/** Ask the core which encoders it actually ships instead of guessing. */
async function listEncoders(core: FFmpeg): Promise<Set<string>> {
  if (encoderList) return encoderList

  const lines: string[] = []
  const onLog = ({ message }: { message: string }) => lines.push(message)
  core.on('log', onLog)

  try {
    await core.exec(['-hide_banner', '-encoders'])
  } finally {
    core.off('log', onLog)
  }

  const found = new Set<string>()
  for (const line of lines) {
    // " A....D aac   AAC (Advanced Audio Coding)"
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
    if (match) found.add(match[1])
  }

  encoderList = found
  logger.debug(`[ffmpeg] ${found.size} encoders available`)
  return found
}

/**
 * Container + audio codec for a muxed result, derived from the input.
 *
 * The video stream is always copied, so the output container has to be one
 * that accepts the source codec: VP8/VP9 cannot be stored in MP4, and WebM
 * only accepts Vorbis/Opus audio. Matching the input container sidesteps both.
 */
interface MuxTarget {
  container: 'mp4' | 'webm' | 'mkv' | 'avi'
  extension: string
  audioEncoders: string[]
}

function muxTargetFor(videoName: string): MuxTarget {
  const dot = videoName.lastIndexOf('.')
  const extension = (dot > 0 ? videoName.slice(dot) : '.mp4').toLowerCase()

  switch (extension) {
    case '.webm':
      return { container: 'webm', extension: '.webm', audioEncoders: ['libopus', 'libvorbis'] }
    case '.mkv':
      return {
        container: 'mkv',
        extension: '.mkv',
        audioEncoders: ['aac', 'libopus', 'libvorbis', 'libmp3lame'],
      }
    case '.avi':
      return { container: 'avi', extension: '.avi', audioEncoders: ['libmp3lame', 'aac'] }
    case '.mov':
    case '.m4v':
      return { container: 'mp4', extension: '.mov', audioEncoders: ['aac', 'libmp3lame'] }
    default:
      return { container: 'mp4', extension: '.mp4', audioEncoders: ['aac', 'libmp3lame'] }
  }
}

export interface MuxResult {
  blob: Blob
  /** Extension the result should be saved with, matched to the input container. */
  extension: string
  container: string
}

/** Replace a video's audio track with the enhanced one, without re-encoding video. */
export async function muxVideo(
  video: Blob,
  videoName: string,
  audio: Blob,
  onProgress?: ProgressCallback
): Promise<MuxResult> {
  const target = muxTargetFor(videoName)
  const videoInput = `source${target.extension}`
  const audioInput = 'enhanced.wav'
  const outName = `muxed${target.extension}`

  const core = await getFFmpeg()
  const encoders = await listEncoders(core)
  const audioEncoder = target.audioEncoders.find((name) => encoders.has(name))

  if (!audioEncoder) {
    throw new Error(
      `This ffmpeg core has none of ${target.audioEncoders.join(', ')}, so a ${target.container} file cannot be written`
    )
  }

  logger.info(
    `Muxing the enhanced audio back into the source video (${target.container}, ${audioEncoder})`
  )

  const blob = await run({
    label: 'muxing the video',
    onProgress,
    inputs: [
      { name: videoInput, data: video },
      { name: audioInput, data: audio },
    ],
    outputName: outName,
    args: ([videoFile, audioFile]) => [
      '-hide_banner',
      '-i',
      videoFile,
      '-i',
      audioFile,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c:v',
      'copy',
      '-c:a',
      audioEncoder,
      '-b:a',
      '192k',
      '-shortest',
      ...(target.container === 'mp4' ? ['-movflags', '+faststart'] : []),
      outName,
    ],
  })

  return { blob, extension: target.extension, container: target.container }
}

/**
 * Copy a dropped file into OPFS and return its virtual path.
 *
 * The queue then works with a path rather than holding megabytes of
 * `ArrayBuffer` in memory between stages.
 */
export async function stageFileInOPFS(
  file: File | Blob
): Promise<{ path: string; name: string; mime: string }> {
  const originalName = fileNameOf(file)
  const dot = originalName?.lastIndexOf('.') ?? -1
  const extension = dot > 0 ? originalName!.slice(dot) : ''
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`
  const path = `uploads/${name}`

  await writeDataToOPFS(path, file)
  logger.debug(`Staged ${file.size} bytes → opfs://${path}`)

  return { path, name, mime: file.type || 'application/octet-stream' }
}
