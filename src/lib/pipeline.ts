import { useAppStore } from '../store/app'
import { logger } from './logger'
import { extractAudioToWav, muxVideo, stageFileInOPFS } from './ffmpeg'
import { createEngine } from './engine'
import { encodeWavChunks, fileNameOf, isVideo, parseWav, suggestedOutputFilename } from './filekit'
import { openOPFSWriter, readDataFromOPFS, removeFromOPFS } from './opfs'
import { resample } from './dsp'
import type { Job, ModelId } from '../types/hushwing'

/** Models run at 16 kHz; results are lifted back to 48 kHz for delivery. */
export const INFERENCE_RATE = 16_000
export const DELIVERY_RATE = 48_000

/** Add a file to the queue without starting work. The output format follows the source. */
export function enqueueFile(file: File | Blob, model: ModelId): Job {
  return useAppStore.getState().enqueue(file, model)
}

/** True while a job still needs to be picked up by the queue runner. */
export function isPending(job: Job): boolean {
  return job.status === 'queued' || job.status === 'preparing'
}

export function isActive(job: Job): boolean {
  return isPending(job) || job.status === 'processing'
}

/**
 * Run one queued job end to end:
 *
 * stage → extract 16 kHz mono → enhance with the selected engine → resample to
 * 48 kHz → stream the result into OPFS → hand the UI a download URL
 * (optionally muxing the audio back into the source video first).
 */
export async function runJob(jobId: string): Promise<Job> {
  const store = useAppStore.getState()
  const job = store.jobs.find((candidate) => candidate.id === jobId)

  if (!job) throw new Error(`Job ${jobId} is not in the queue`)
  if (!job.original) throw new Error(`Job ${jobId} has no source file`)
  if (job.status === 'completed') return job

  const { original, model, outputFormat, sourceKind } = job
  const startedAt = Date.now()
  let stagePath: string | undefined
  let resultPath: string | undefined

  const report = (patch: Partial<Job>) => useAppStore.getState().updateJob(jobId, patch)

  try {
    store.setJobStatus(jobId, 'preparing')
    report({ progress: 4, stage: 'Copying into OPFS' })

    const staged = await stageFileInOPFS(original)
    stagePath = staged.path
    report({ stagePath, progress: 8, stage: 'Staged in OPFS' })

    const sourceBlob = await readDataFromOPFS(staged.path, { asBlob: true })
    if (!(sourceBlob instanceof Blob)) {
      throw new Error('Could not read the staged file back out of OPFS')
    }

    store.setJobStatus(jobId, 'processing')
    report({ startedAt, stage: 'Extracting audio', progress: 12 })

    const extracted = await extractAudioToWav(sourceBlob, staged.name, (fraction) => {
      report({ progress: 12 + Math.round(fraction * 26), stage: 'Extracting audio' })
    })

    report({ progress: 40, stage: 'Decoding PCM' })
    const pcm = await parseWav(extracted)
    report({ duration: pcm.samples.length / pcm.sampleRate })

    logger.info(
      `${model}: enhancing ${pcm.samples.length} samples @ ${pcm.sampleRate}Hz (${sourceKind})`
    )

    report({ progress: 45, stage: 'Enhancing with ' + model })
    const engine = createEngine(model, INFERENCE_RATE)
    let enhanced: Float32Array
    try {
      const result = await engine.process(pcm.samples, INFERENCE_RATE)
      enhanced = result.samples
    } finally {
      engine.dispose()
    }

    report({ progress: 72, stage: 'Resampling to 48 kHz' })
    const delivered = resample(enhanced, INFERENCE_RATE, DELIVERY_RATE)

    // Stream the result to disk instead of assembling one giant blob in RAM.
    const wavPath = `outputs/${jobId}.wav`
    await streamWavToOPFS(wavPath, delivered, DELIVERY_RATE)

    let finalPath = wavPath
    let finalExtension = '.wav'
    let warning: string | undefined

    // `outputFormat` is derived at enqueue from the source kind, so this is only
    // ever true for a real video. Muxing an audio file into a video container fails
    // every time, and in a bulk batch that cost one wasted ffmpeg run per file.
    if (outputFormat === 'video') {
      report({ progress: 80, stage: 'Muxing video' })
      const wavBlob = await readDataFromOPFS(wavPath, { asBlob: true })
      if (!(wavBlob instanceof Blob)) throw new Error('The enhanced WAV could not be read back')

      try {
        const muxed = await muxVideo(sourceBlob, staged.name, wavBlob, (fraction) => {
          report({ progress: 80 + Math.round(fraction * 14), stage: 'Muxing video' })
        })

        finalPath = `outputs/${jobId}${muxed.extension}`
        finalExtension = muxed.extension
        await writeBlobToOPFS(finalPath, muxed.blob)
        await removeFromOPFS(wavPath)
      } catch (error) {
        // Never lose the enhanced audio just because the container was unhappy.
        warning = `${
          error instanceof Error ? error.message : 'Muxing failed'
        } — exported the enhanced WAV instead.`
        logger.warn(`job ${jobId}: ${warning}`)
        finalPath = wavPath
        finalExtension = '.wav'
      }
    }

    const outputName = suggestedOutputFilename(job.sourceName, finalExtension)

    report({ progress: 96, stage: 'Finishing up' })
    const finalBlob = await readDataFromOPFS(finalPath, { asBlob: true })
    if (!(finalBlob instanceof Blob)) throw new Error('The finished file could not be read back')

    resultPath = finalPath
    const url = URL.createObjectURL(finalBlob)
    const durationMs = Date.now() - startedAt

    store.markJobResult(jobId, url)
    store.setJobStatus(jobId, 'completed')
    report({
      completedAt: Date.now(),
      durationMs,
      outputName,
      outputSize: finalBlob.size,
      resultPath,
      progress: 100,
      stage: 'Done',
      warning,
    })

    logger.info(`job ${jobId} completed in ${durationMs}ms → ${outputName}`)
    return {
      ...job,
      status: 'completed',
      resultUrl: url,
      outputName,
      resultPath,
      progress: 100,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown processing error'
    // Keep the stack: a one-line message is rarely enough to diagnose a pipeline failure.
    if (error instanceof Error && error.stack) logger.debug(error.stack)
    logger.error(`job ${jobId} failed: ${message}`)
    store.setJobStatus(jobId, 'error', message)
    report({ completedAt: Date.now(), stage: 'Failed' })
    throw error
  } finally {
    // The staged copy is never needed again; the result stays in OPFS.
    if (stagePath) await removeFromOPFS(stagePath).catch(() => false)
  }
}

/** Convenience: queue a file and immediately process it (used by the headless API). */
export async function processFile(file: File | Blob, model: ModelId): Promise<Job> {
  const job = enqueueFile(file, model)
  return runJob(job.id)
}

export interface QueueResult {
  completed: number
  failed: number
}

/**
 * Process every queued job, one at a time.
 *
 * The PRD locks concurrency to a single worker so a browser tab on a phone
 * cannot be asked to hold several multi-hundred-megabyte buffers at once.
 */
export async function runQueue(): Promise<QueueResult> {
  const store = useAppStore.getState()
  if (store.processing) {
    logger.warn('The queue is already running')
    return { completed: 0, failed: 0 }
  }

  const first = useAppStore
    .getState()
    .jobs.filter((job) => isPending(job) && job.status !== 'preparing')
    .map((job) => job.id)

  if (first.length === 0) return { completed: 0, failed: 0 }

  store.setProcessing(true)
  logger.info(`Queue started with ${first.length} job(s)`)

  let completed = 0
  let failed = 0

  try {
    // Re-read the queue after every job instead of iterating a snapshot taken up
    // front. Someone dropping a folder and then dropping three more files must not
    // leave those three sitting at "queued" forever: the autostart path already
    // returned (processing is true), so nothing else would ever pick them up.
    for (;;) {
      const next = useAppStore
        .getState()
        .jobs.find((job) => isPending(job) && job.status !== 'preparing')
      if (!next) break

      await waitUntilVisible()
      try {
        await runJob(next.id)
        completed += 1
      } catch {
        failed += 1
      }
    }
  } finally {
    useAppStore.getState().setProcessing(false)
    logger.info(`Queue finished: ${completed} completed, ${failed} failed`)
  }

  return { completed, failed }
}

/** iOS can silently kill a backgrounded tab, so wait for visibility between jobs. */
function waitUntilVisible(): Promise<void> {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible)
        resolve()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
  })
}

async function streamWavToOPFS(
  path: string,
  samples: Float32Array,
  sampleRate: number
): Promise<void> {
  const writer = await openOPFSWriter(path)
  try {
    for (const chunk of encodeWavChunks(samples, sampleRate)) {
      await writer.write(chunk)
    }
  } finally {
    await writer.close()
  }
}

async function writeBlobToOPFS(path: string, blob: Blob): Promise<void> {
  const writer = await openOPFSWriter(path)
  try {
    const view = new Uint8Array(await blob.arrayBuffer())
    const chunkSize = 1 << 20
    for (let offset = 0; offset < view.length; offset += chunkSize) {
      await writer.write(view.subarray(offset, Math.min(offset + chunkSize, view.length)))
    }
  } finally {
    await writer.close()
  }
}

/** Delete every OPFS artifact belonging to a job (staging, results). */
export async function purgeJobFiles(job: Job): Promise<void> {
  const paths = [job.stagePath, job.resultPath].filter((path): path is string => Boolean(path))
  await Promise.all(paths.map((path) => removeFromOPFS(path).catch(() => false)))
}

export { isVideo, fileNameOf }
