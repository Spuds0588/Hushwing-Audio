/**
 * Hushwing Audio — bulk / queued workload test.
 *
 * The main suite (`hushwing.e2e.mjs`) proves one audio job, two video jobs and the
 * preview work. This proves the *queue*, which is the part that has to hold up when
 * someone drops a folder of recordings on it:
 *
 *   1. a single multi-file drop with `?autostart=true` queues and drains every file;
 *   2. concurrency never exceeds 1, and per-job progress never goes backwards;
 *   3. every job reaches 100% with a working download, and mixed media + one global
 *      output format degrades gracefully instead of failing;
 *   4. OPFS hygiene: `uploads/` (the staging copies) is empty afterwards, while
 *      `outputs/` holds exactly one result per job — and both clean up on "clear";
 *   5. files dropped *while the queue is running* are not stranded;
 *   6. a `.zip` of the whole batch contains exactly one entry per result;
 *   7. heap growth across the batch stays bounded.
 *
 * Usage:
 *   PREVIEW_URL=https://<host> bun run test:bulk
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import JSZip from 'jszip'

const here = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.PREVIEW_URL
if (!BASE) throw new Error('PREVIEW_URL is required (the running preview origin)')

/** How many audio files the first drop contains. */
const BATCH = Number(process.env.BULK_COUNT || 20)
/** How many files are dropped mid-run to test arrivals during a drain. */
const ARRIVALS = 3

const results = []
const consoleErrors = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const trail = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

/** N seconds of "speech" (a gated tone) under constant hiss, 16 kHz mono. */
function makeWav(seconds = 2) {
  const sampleRate = 16_000
  const frames = sampleRate * seconds
  const buffer = Buffer.alloc(44 + frames * 2)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(frames * 2, 40)

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate
    const speaking = i % sampleRate < sampleRate * 0.55
    const voice = Math.sin(2 * Math.PI * 440 * t) * 0.35 * (speaking ? 1 : 0.15)
    const hiss = (Math.random() * 2 - 1) * 0.05
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, voice + hiss)) * 32767), 44 + i * 2)
  }

  return buffer
}

const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--enable-precise-memory-info',
    '--no-sandbox',
  ],
})
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } })
const page = await context.newPage()

page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
})

// A bulk batch is the one scenario that can take the renderer down (WASM heap or
// a leak), so treat a crash as a first-class result rather than a mystery timeout.
let crashedAt = null
const heapTrail = []
page.on('crash', () => {
  crashedAt = trail.length
  console.log('\n*** the page CRASHED (renderer process gone) ***')
})

const rows = () =>
  page.$$eval('li[data-job-id]', (nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute('data-job-id'),
      status: node.getAttribute('data-status'),
      name: node.getAttribute('data-job-name'),
      progress: Number(node.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? -1),
    }))
  )

/** OPFS directory listing, straight from the page — no app imports, so it works in production. */
const opfsListing = () =>
  page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const list = async (name) => {
      try {
        const dir = await root.getDirectoryHandle(name)
        const entries = []
        for await (const [entry] of dir) entries.push(entry)
        return entries
      } catch {
        return []
      }
    }
    const estimate = (await navigator.storage.estimate?.()) ?? {}
    return {
      uploads: await list('uploads'),
      outputs: await list('outputs'),
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
    }
  })

const heap = () =>
  page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null))

const toMB = (bytes) => (bytes === null ? 'n/a' : `${(bytes / 1024 / 1024).toFixed(1)} MB`)

try {
  await page.goto(`${BASE}/?autostart=true&coi=off#studio`, { waitUntil: 'networkidle' })
  // The file input is intentionally hidden, so wait for it to be attached, not visible.
  await page.waitForSelector('input[data-mcp-action="upload"]', { state: 'attached', timeout: 20_000 })

  /* ------------------------------------------------------ 1. the bulk drop -- */
  const drop = []
  for (let i = 0; i < BATCH; i++) {
    drop.push({
      name: `recording-${String(i + 1).padStart(2, '0')}.wav`,
      mimeType: 'audio/wav',
      buffer: makeWav(2),
    })
  }

  // One mixed drop through a single `setInputFiles`: the folder-drag case. There is
  // no format control any more, so each file has to come back as its own kind.
  const mp4Path = process.env.E2E_MP4 ?? join(here, '.cache', 'sample.mp4')
  let videos = 0
  if (process.env.BULK_VIDEO === '0') {
    console.log('INFO  BULK_VIDEO=0: audio-only batch')
  } else {
    try {
      drop.push({ name: 'bulk-clip.mp4', mimeType: 'video/mp4', buffer: readFileSync(mp4Path) })
      videos += 1
    } catch {
      console.log('INFO  no cached MP4 fixture; bulk drop is audio-only')
    }
  }

  await page.setInputFiles('input[data-mcp-action="upload"]', drop)
  await sleep(500)

  const queued = await rows()
  record(
    `one drop queued all ${drop.length} files`,
    queued.length === drop.length,
    `${queued.length} rows, ${queued.filter((r) => r.status === 'queued').length} queued`
  )
  record('autostart kicked the queue off without a click', queued.some((r) => r.status !== 'queued'), `statuses: ${[...new Set(queued.map((r) => r.status))].join(', ')}`)

  /* ------------------------------------- 2. concurrency + progress polling -- */
  const seen = new Map()
  let maxConcurrent = 0
  let regressions = 0
  let sawProcessing = false

  const poll = setInterval(async () => {
    try {
      const snapshot = await rows()
      const processing = snapshot.filter((r) => r.status === 'processing' || r.status === 'preparing').length
      if (processing > maxConcurrent) maxConcurrent = processing
      if (processing > 0) sawProcessing = true

      const now = await heap()
      heapTrail.push(now)
      // Print the trajectory as it happens: if the renderer dies, the log still
      // shows how memory was trending when it went.
      const previous = heapTrail[heapTrail.length - 2]
      if (now !== null && previous != null && Math.abs(now - previous) > 8 * 1024 * 1024) {
        console.log(`   heap ${toMB(previous)} → ${toMB(now)}`)
      }

      for (const row of snapshot) {
        // A completed job no longer renders a progress bar, so a missing value is
        // not a regression — only compare real readings.
        if (row.progress < 0) continue
        const previous = seen.get(row.id)
        if (previous !== undefined && row.progress < previous) regressions += 1
        seen.set(row.id, row.progress)
      }
    } catch {
      /* mid-navigation */
    }
  }, 300)

  // Drop more files *while* the batch is draining.
  while (!sawProcessing) {
    const snapshot = await rows()
    if (!snapshot.some((r) => r.status === 'processing')) {
      if (snapshot.every((r) => r.status === 'completed' || r.status === 'error')) break
    }
    await sleep(400)
  }

  const arrivals = []
  for (let i = 0; i < ARRIVALS; i++) {
    arrivals.push({
      name: `late-arrival-${i + 1}.wav`,
      mimeType: 'audio/wav',
      buffer: makeWav(1),
    })
  }
  await page.setInputFiles('input[data-mcp-action="upload"]', arrivals)
  const afterArrival = await rows()
  record(
    'files dropped mid-run are accepted into the queue',
    afterArrival.length === drop.length + ARRIVALS,
    `${afterArrival.length} rows`
  )

  const expected = drop.length + ARRIVALS
  const deadline = Date.now() + 240_000
  let settled = []
  while (Date.now() < deadline) {
    settled = await rows()
    const busy = settled.some((r) => r.status === 'processing' || r.status === 'preparing')
    const done = settled.filter((r) => r.status === 'completed' || r.status === 'error').length
    if (!busy && done >= expected) break
    if (!busy && done < expected) {
      // Nothing is running but work is still pending: wait a beat, then decide.
      await sleep(3000)
      const recheck = await rows()
      if (!recheck.some((r) => r.status === 'processing' || r.status === 'preparing')) {
        settled = recheck
        break
      }
    }
    await sleep(500)
  }
  clearInterval(poll)

  const errored = settled.filter((r) => r.status === 'error')
  const stranded = settled.filter((r) => r.status === 'queued')
  const completed = settled.filter((r) => r.status === 'completed')

  record(
    'the whole batch (plus arrivals) finished',
    completed.length === expected && errored.length === 0,
    `${completed.length}/${expected} completed · ${errored.length} failed · ${stranded.length} stranded`
  )
  record('queue concurrency never exceeded 1', maxConcurrent <= 1, `peak ${maxConcurrent}`)
  record('per-job progress never went backwards', regressions === 0, `${regressions} regressions`)
  record(
    'late arrivals were not stranded when the first batch drained',
    stranded.length === 0,
    stranded.length ? `${stranded.length} left queued: ${stranded.map((r) => r.name).join(', ')}` : 'none'
  )

  if (errored.length) {
    console.log(`   failed: ${errored.map((r) => `${r.name} (${r.status})`).join(', ')}`)
  }

  /* ------------------------------------------------- 3. outputs + hygiene -- */
  const apiJobs = await page.evaluate(() => window.HushwingAPI.getJobs())
  record(
    'headless API agrees every job completed at 100%',
    apiJobs.length === expected && apiJobs.every((job) => job.status === 'completed' && job.progress === 100),
    JSON.stringify(apiJobs.map((job) => job.progress).reduce((a, b) => Math.min(a, b), 100))
  )

  const listings = await opfsListing()
  record(
    'staging copies are cleaned up after every job',
    listings.uploads.length === 0,
    `uploads/ holds ${listings.uploads.length} file(s)`
  )
  record(
    'exactly one result per job is kept in OPFS',
    listings.outputs.length === expected,
    `outputs/ holds ${listings.outputs.length} of ${expected}`
  )

  // No format control exists, so every result has to follow its own source: the
  // audio files stay WAV, the video stays a video, in one mixed batch.
  const resultNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[data-mcp-action="download-result"]')).map((anchor) =>
      anchor.getAttribute('download')
    )
  )
  const wavResults = resultNames.filter((name) => name?.endsWith('.wav')).length
  const videoResults = resultNames.filter((name) => name && !name.endsWith('.wav')).length
  record(
    "every result follows its own source (video stays video, audio becomes WAV)",
    wavResults === expected - videos && videoResults === videos,
    `${wavResults} wav + ${videoResults} video·audio, of ${expected} results`
  )

  /* --------------------------------------------------------- 4. downloads -- */
  const spotCheck = async (name) => {
    const row = settled.find((r) => r.name === name)
    if (!row) return null
    return page.evaluate(async (id) => {
      const anchor = document.querySelector(`a[data-mcp-action="download-result"][data-job-id="${id}"]`)
      if (!anchor) return { missing: true }
      const bytes = new Uint8Array(await (await fetch(anchor.href)).arrayBuffer())
      return {
        download: anchor.getAttribute('download'),
        size: bytes.length,
        head: String.fromCharCode(...bytes.subarray(0, 4)),
        sampleRate: bytes.length > 28 ? new DataView(bytes.buffer).getUint32(24, true) : 0,
      }
    }, row.id)
  }

  const first = await spotCheck('recording-01.wav')
  const last = await spotCheck(`recording-${String(BATCH).padStart(2, '0')}.wav`)
  record(
    'first and last results in the batch download as valid 48 kHz WAV',
    Boolean(
      first?.head === 'RIFF' &&
        last?.head === 'RIFF' &&
        first.sampleRate === 48_000 &&
        last.sampleRate === 48_000 &&
        first.size > 50_000
    ),
    `first ${first?.download} ${first?.size}B ${first?.sampleRate}Hz · last ${last?.download} ${last?.size}B ${last?.sampleRate}Hz`
  )

  /* -------------------------------------------------------------- 5. zip -- */
  const downloadEvent = page.waitForEvent('download', { timeout: 120_000 }).catch(() => null)
  await page.click('button:has-text("Export all (.zip)")')
  const zipEvent = await downloadEvent
  if (zipEvent) {
    const bytes = readFileSync(await zipEvent.path())
    const archive = await JSZip.loadAsync(bytes)
    const entries = Object.keys(archive.files).filter((name) => !archive.files[name].dir)
    record(
      'zip export contains one entry per result',
      entries.length === expected,
      `${zipEvent.suggestedFilename()} · ${entries.length} entries · ${(bytes.length / 1024 / 1024).toFixed(1)} MB`
    )
  } else {
    record('zip export contains one entry per result', false, 'no download event fired')
  }

  /* ------------------------------------------------- 6. bulk clear + heap -- */
  const beforeHeap = await heap()
  await page.click('button:has-text("Clear finished")')
  await sleep(2500)
  const afterClear = await opfsListing()
  const clearedRows = await rows()

  record(
    '"clear finished" purges a whole batch from OPFS',
    afterClear.outputs.length === 0,
    `${afterClear.outputs.length} result(s) left, ${afterClear.uploads.length} staged file(s)`
  )
  record('the job list empties out', clearedRows.length === 0, `${clearedRows.length} rows`)

  const afterHeap = await heap()
  const samples = heapTrail.filter((value) => value !== null)
  if (samples.length > 1) {
    console.log(
      `   heap trail: first ${toMB(samples[0])} · peak ${toMB(Math.max(...samples))} · last ${toMB(samples[samples.length - 1])} (${samples.length} samples)`
    )
  }
  if (crashedAt !== null) {
    record('the renderer survived the batch', false, `crashed after ${crashedAt} poll(s)`)
  }
  if (beforeHeap !== null && afterHeap !== null) {
    const growth = afterHeap - beforeHeap
    record(
      'heap growth across the batch is bounded',
      growth < 200 * 1024 * 1024,
      `warm ${toMB(beforeHeap)} → ${toMB(afterHeap)} (${growth >= 0 ? '+' : ''}${toMB(Math.abs(growth))})`
    )
  } else {
    console.log('INFO  performance.memory unavailable; heap growth not measured')
  }

  console.log(
    `\n   storage after ${expected} jobs: used ${toMB(listings.usage)} of quota ${toMB(listings.quota)}`
  )
} catch (error) {
  record('bulk suite ran to completion', false, error.message)
} finally {
  const uniqueErrors = [...new Set(consoleErrors)]
  console.log('\n--- console / page errors ---')
  console.log(uniqueErrors.length === 0 ? 'none' : uniqueErrors.slice(0, 20).join('\n'))

  const failed = results.filter((result) => !result.ok).map((result) => result.name)
  console.log(`\n=== ${results.filter((r) => r.ok).length}/${results.length} bulk checks passed ===`)
  if (failed.length) console.log(`FAILED: ${failed.join('; ')}`)

  await browser.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
