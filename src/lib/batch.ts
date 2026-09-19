import JSZip from 'jszip'
import type { Job } from '../types/hushwing'
import { logger } from './logger'

export function completedJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.status === 'completed' && job.resultUrl)
}

export function hasExportableResults(jobs: Job[]): boolean {
  return completedJobs(jobs).length > 0
}

/**
 * Bundle every finished result into a single `.zip` and trigger one download.
 * Everything happens in the browser; nothing is uploaded.
 */
export async function downloadResultsAsZip(jobs: Job[]): Promise<number> {
  const finished = completedJobs(jobs)
  if (finished.length === 0) {
    throw new Error('There are no finished jobs to export yet.')
  }

  const zip = new JSZip()
  const used = new Set<string>()

  for (const job of finished) {
    if (!job.resultUrl) continue

    // Old object URLs may have been revoked; skip anything that will not fetch.
    let data: Blob
    try {
      const response = await fetch(job.resultUrl)
      data = await response.blob()
    } catch {
      logger.warn(`zip: skipping ${job.id}, result URL is no longer readable`)
      continue
    }

    const base = job.outputName ?? `${job.id}.wav`
    let name = base
    let counter = 2
    while (used.has(name)) {
      const dot = base.lastIndexOf('.')
      name = dot > 0
        ? `${base.slice(0, dot)}-${counter}${base.slice(dot)}`
        : `${base}-${counter}`
      counter += 1
    }
    used.add(name)

    zip.file(name, data)
  }

  const archive = await zip.generateAsync({ type: 'blob' })
  const url = URL.createObjectURL(archive)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `hushwing-results-${Date.now()}.zip`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)

  logger.info(`zip: packaged ${used.size} result(s)`)
  return used.size
}
