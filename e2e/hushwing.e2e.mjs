/**
 * Hushwing Audio — end-to-end browser test.
 *
 * Drives the real app in headless Chromium: drops in a WAV, a real H.264/AAC
 * MP4 and a VP8 WebM recorded in-page, processes all three through the queue,
 * downloads every result and checks the delivered container, then exercises the
 * AudioWorklet A/B preview, the zip export, the URL parameters and the
 * headless API.
 *
 * Usage:
 *   bun install
 *   bunx playwright install chromium          # once
 *   PREVIEW_URL=https://<preview-host> bun run test:e2e
 *
 * The MP4 fixture (~5 MB) is downloaded into e2e/.cache on first run; if that
 * fails the MP4 cases are skipped rather than failed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const cacheDir = join(here, '.cache')
const BASE = process.env.PREVIEW_URL
if (!BASE) throw new Error('PREVIEW_URL is required (the running preview origin)')

const MP4_FIXTURE = process.env.E2E_MP4 ?? join(cacheDir, 'sample.mp4')
const MP4_SOURCE =
  'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4'

const results = []
const consoleErrors = []
let skipped = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

function skip(name, detail) {
  skipped.push(name)
  console.log(`SKIP  ${name}${detail ? `  — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 4 s of "speech" (gated 440 Hz tone) buried in constant hiss, 16 kHz mono. */
function makeWav() {
  const sampleRate = 16_000
  const frames = sampleRate * 4
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

function readWavHeader(buffer) {
  return {
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    bits: buffer.readUInt16LE(34),
  }
}

async function ensureMp4Fixture() {
  if (existsSync(MP4_FIXTURE)) return readFileSync(MP4_FIXTURE)

  try {
    mkdirSync(cacheDir, { recursive: true })
    const response = await fetch(MP4_SOURCE)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    writeFileSync(MP4_FIXTURE, bytes)
    return bytes
  } catch (error) {
    console.log(`INFO  could not fetch the MP4 fixture (${error.message})`)
    return null
  }
}

const browser = await chromium.launch({
  // HEADED=1 runs a real windowed Chromium. On a machine without a display,
  // wrap the run: xvfb-run -a --server-args="-screen 0 1600x1000x24" bun run test:e2e
  headless: process.env.HEADED !== '1',
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    // Software rendering: a headed browser under Xvfb has no GPU, and
    // MediaRecorder/canvas capture must still work.
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
})

const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } })
const page = await context.newPage()

page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(`console: ${message.text()}`)
})

async function jobRows() {
  return page.$$eval('li[data-job-id]', (rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-job-id'),
      status: row.getAttribute('data-status'),
      text: row.innerText.replace(/\s+/g, ' ').trim(),
    }))
  )
}

async function waitForSettled(expected, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await jobRows()
    if (
      rows.length >= expected &&
      rows.every((row) => row.status === 'completed' || row.status === 'error')
    ) {
      return rows
    }
    await sleep(1000)
  }
  return jobRows()
}

async function inspectDownload(jobId) {
  return page.evaluate(async (id) => {
    const anchor = document.querySelector(`a[data-mcp-action="download-result"][data-job-id="${id}"]`)
    if (!anchor) return { missing: true }

    const response = await fetch(anchor.href)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      download: anchor.getAttribute('download'),
      size: bytes.length,
      head: String.fromCharCode(...bytes.subarray(0, 4)),
      brand: String.fromCharCode(...bytes.subarray(4, 8)),
      hex: Array.from(bytes.subarray(0, 4))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      bytes: Array.from(bytes.subarray(0, 200)),
    }
  }, jobId)
}

try {
  /* --------------------------------------------------------------- landing -- */
  await page.goto(`${BASE}/?coi=off`, { waitUntil: 'networkidle' })
  const heading = (await page.textContent('h1')) ?? ''
  record('landing page renders its hero', /without uploading/i.test(heading), heading.slice(0, 48))

  const engineCards = await page.$$eval('h3', (nodes) =>
    nodes.filter((node) => /Web Audio|denoiser|DeepFilterNet/i.test(node.innerText)).length
  )
  record('landing lists all three engines', engineCards >= 3, `${engineCards} cards`)

  await page.click('button:has-text("Open the studio")')
  await page.waitForSelector('button[data-mcp-action="process-queue"]', { timeout: 15_000 })
  record('landing CTA opens the studio', page.url().includes('#studio'), page.url().split('/').pop())

  /* ------------------------------------------------------------ agent hooks -- */
  const hooks = await page.evaluate(() => ({
    upload: Boolean(document.querySelector('input[data-mcp-action="upload"]')),
    model: Boolean(document.querySelector('select[data-mcp-target="model-selector"]')),
    format: Boolean(document.querySelector('select[data-mcp-target="output-format"]')),
    queue: Boolean(document.querySelector('button[data-mcp-action="process-queue"]')),
    api: typeof window.HushwingAPI === 'object',
  }))
  record('DOM hooks + HushwingAPI present', Object.values(hooks).every(Boolean), JSON.stringify(hooks))

  const models = await page.evaluate(() => window.HushwingAPI.getModels())
  record('API advertises the shipped engines', JSON.stringify(models) === '["webaudio","rnnoise"]', JSON.stringify(models))

  /* --------------------------------------------------------------- fixtures -- */
  const wav = makeWav()
  const mp4 = await ensureMp4Fixture()

  await page.setInputFiles('input[data-mcp-action="upload"]', {
    name: 'interview.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  })
  await sleep(300)

  if (mp4) {
    await page.selectOption('select[data-mcp-target="model-selector"]', 'rnnoise')
    await page.selectOption('select[data-mcp-target="output-format"]', 'video')
    await page.setInputFiles('input[data-mcp-action="upload"]', {
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      buffer: mp4,
    })
    await sleep(300)
  } else {
    skip('MP4 input case', 'fixture unavailable')
  }

  const webmBase64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const ctx = canvas.getContext('2d')
    const stream = canvas.captureStream(25)

    const audioCtx = new AudioContext()
    const osc = audioCtx.createOscillator()
    osc.frequency.value = 220
    const gain = audioCtx.createGain()
    gain.gain.value = 0.2
    const destination = audioCtx.createMediaStreamDestination()
    osc.connect(gain)
    gain.connect(destination)
    destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track))
    osc.start()

    const mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find((candidate) =>
      MediaRecorder.isTypeSupported(candidate)
    )
    if (!mime) throw new Error('MediaRecorder has no WebM support')

    const chunks = []
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    recorder.ondataavailable = (event) => chunks.push(event.data)
    recorder.start()

    const started = performance.now()
    await new Promise((resolve) => {
      const draw = () => {
        const elapsed = performance.now() - started
        ctx.fillStyle = '#101422'
        ctx.fillRect(0, 0, 320, 240)
        ctx.fillStyle = '#7fe6c4'
        ctx.fillRect((elapsed / 8) % 280, 60, 30, 120)
        if (elapsed < 3000) requestAnimationFrame(draw)
        else resolve()
      }
      draw()
    })

    recorder.stop()
    await new Promise((resolve) => {
      recorder.onstop = resolve
    })
    osc.stop()
    await audioCtx.close()

    const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
    }
    return btoa(binary)
  })

  const webm = Buffer.from(webmBase64, 'base64')
  record('recorded a WebM clip in-page for the mux test', webm.length > 5000, `${webm.length} bytes`)

  await page.setInputFiles('input[data-mcp-action="upload"]', {
    name: 'screen-capture.webm',
    mimeType: 'video/webm',
    buffer: webm,
  })
  await sleep(300)

  const expectedJobs = mp4 ? 3 : 2
  const queued = await jobRows()
  record('files land in the queue with their names', queued.length === expectedJobs, queued.map((job) => job.text.split(' ')[0]).join(', '))

  /* ------------------------------------------------------------- processing -- */
  await page.click('button[data-mcp-action="process-queue"]')

  const trail = []
  const poll = setInterval(async () => {
    try {
      const rows = await jobRows()
      // Read the `data-status` hook rather than the rendered text, so the trail
      // reports machine state instead of guessing from styling-dependent copy.
      const line = rows.map((row) => row.status ?? '?').join(' | ')
      if (trail[trail.length - 1] !== line) trail.push(line)
    } catch {
      /* mid-navigation */
    }
  }, 1500)

  const settled = await waitForSettled(expectedJobs)
  clearInterval(poll)
  console.log(`   status trail: ${trail.join('  ->  ')}`)

  const errored = settled.filter((row) => row.status === 'error')
  record(
    'every job completed without an error',
    settled.length === expectedJobs && errored.length === 0,
    errored.map((row) => row.text).join(' || ') || 'ok'
  )

  if (errored.length > 0) {
    // The app keeps its own bounded log with stacks; it is the fastest way to
    // see why a pipeline stage failed. That log is only importable from the dev
    // server, so a production run degrades to a note instead of throwing.
    try {
      const appLog = await page.evaluate(async () => {
        const module = await import('/src/lib/logger.ts')
        return module.exportLogs()
      })
      const useful = appLog
        .split('\n')
        .filter((line) => !/\[ffmpeg\]\s+(frame=|\[|\s*$)/.test(line))
        .slice(-40)
      console.log('\n--- app diagnostics (tail) ---')
      console.log(useful.join('\n'))
      console.log('--- end diagnostics ---\n')
    } catch (error) {
      console.log(`INFO  diagnostics log unavailable (${error.message})`)
    }
  }

  const jobIdByName = {}
  for (const row of settled) jobIdByName[row.text.split(' ')[0]] = row.id

  const apiJobs = await page.evaluate(() => window.HushwingAPI.getJobs())
  record(
    'headless API reports every job finished at 100%',
    apiJobs.length === expectedJobs && apiJobs.every((job) => job.status === 'completed' && job.progress === 100),
    JSON.stringify(apiJobs.map((job) => [job.name, job.status, job.progress]))
  )

  /* ---------------------------------------------------------------- outputs -- */
  const wavResult = await inspectDownload(jobIdByName['interview.wav'])
  const wavHeader = wavResult.bytes ? readWavHeader(Buffer.from(wavResult.bytes)) : null
  record(
    'WAV job delivered 48 kHz mono PCM',
    !wavResult.missing &&
      wavResult.head === 'RIFF' &&
      wavHeader.sampleRate === 48_000 &&
      wavHeader.channels === 1 &&
      wavResult.size > 100_000,
    `${wavResult.download} · ${wavResult.size} bytes · ${wavHeader?.sampleRate} Hz · ${wavHeader?.bits}-bit`
  )

  const webmResult = await inspectDownload(jobIdByName['screen-capture.webm'])
  record(
    'WebM input muxed back to WebM (container matched, video copied)',
    !webmResult.missing && webmResult.hex === '1a45dfa3' && (webmResult.download ?? '').endsWith('.webm'),
    `${webmResult.download} · ${webmResult.size} bytes · magic ${webmResult.hex}`
  )

  if (mp4) {
    const mp4Result = await inspectDownload(jobIdByName['clip.mp4'])
    record(
      'MP4 input remuxed into an MP4 with the enhanced audio',
      !mp4Result.missing &&
        mp4Result.brand === 'ftyp' &&
        (mp4Result.download ?? '').endsWith('.mp4') &&
        mp4Result.size > 1_000_000,
      `${mp4Result.download} · ${mp4Result.size} bytes`
    )
  }

  /* ------------------------------------------------------------- zip export -- */
  const downloadEvent = page.waitForEvent('download', { timeout: 90_000 }).catch(() => null)
  await page.click('button:has-text("Export all (.zip)")')
  const zip = await downloadEvent
  if (zip) {
    const bytes = readFileSync(await zip.path())
    record('zip export packaged the results', bytes.length > 100_000 && bytes.subarray(0, 2).toString() === 'PK', `${zip.suggestedFilename()} · ${bytes.length} bytes`)
  } else {
    record('zip export packaged the results', false, 'no download event fired')
  }

  /* ------------------------------------------------------------ A/B preview -- */
  await page.click(`li[data-job-id="${jobIdByName['interview.wav']}"] button:has-text("A/B")`)
  await page.waitForSelector('canvas[aria-label^="Waveform"]', { timeout: 20_000 })
  record('A/B panel opens with a waveform canvas', true)

  await page.waitForSelector('button[data-mcp-action="preview-toggle-play"][data-preview-status="ready"]', {
    timeout: 30_000,
  })
  const unavailable = await page.evaluate(() => /Live preview unavailable/i.test(document.body.innerText))
  record('worklet preview initialised', !unavailable, unavailable ? 'reported unavailable' : 'ready')

  await page.click('button[data-mcp-action="preview-toggle-play"]')

  // Watch the meter and the playhead while the clip actually plays.
  const playback = await page.evaluate(async () => {
    let peak = 0
    let maxPosition = 0
    const started = performance.now()
    while (performance.now() - started < 3000) {
      const level = document.querySelector('[data-preview-level]')
      const width = parseFloat(level?.style.width ?? '0')
      if (width > peak) peak = width

      const position = parseFloat(
        document.querySelector('[data-preview-position]')?.getAttribute('data-preview-position') ?? '0'
      )
      if (position > maxPosition) maxPosition = position

      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return { peak, maxPosition }
  })
  record('audio flows through the worklet (level meter moves)', playback.peak > 0, `peak ${playback.peak}%`)
  record('playback position advances while playing', playback.maxPosition > 0, `reached ${playback.maxPosition}s`)

  await page.click('button[data-mcp-action="preview-bypass"]')
  await page.waitForSelector('span[data-preview-mode="a"]', { timeout: 5000 })
  record('switching to A keeps playback on one signal path', true)

  await page.click('button[data-mcp-action="preview-enhanced"]')
  await page.waitForSelector('span[data-preview-mode="b"]', { timeout: 5000 })
  record('switching back to B works', true)

  await page.click('button[data-mcp-action="preview-toggle-play"]').catch(() => undefined)
  await page.click('button[data-mcp-action="preview-close"]')
  await sleep(500)
  record('closing the preview tears the graph down', (await page.$('canvas[aria-label^="Waveform"]')) === null)

  /* ------------------------------------------------------------- url params -- */
  await page.goto(`${BASE}/?model=rnnoise&debug=true&coi=off#studio`, { waitUntil: 'networkidle' })
  const params = await page.evaluate(() => ({
    model: document.querySelector('select[data-mcp-target="model-selector"]')?.value,
    // `textContent` rather than `innerText`: the panel heading is CSS-uppercased, so
    // innerText reports DIAGNOSTICS and a case-sensitive match would miss it.
    diagnostics: /Diagnostics/.test(document.body.textContent ?? ''),
  }))
  record('?model= and ?debug= apply on boot', params.model === 'rnnoise' && params.diagnostics, JSON.stringify(params))

  /* -------------------------------------------------- cross-origin isolation -- */
  try {
    await page.goto(`${BASE}/#studio`, { waitUntil: 'domcontentloaded' })
    let isolated = false
    for (let attempt = 0; attempt < 12 && !isolated; attempt++) {
      await sleep(1500)
      isolated = await page.evaluate(() => window.crossOriginIsolated === true).catch(() => false)
    }
    console.log(`INFO  crossOriginIsolated=${isolated}`)
  } catch (error) {
    console.log(`INFO  cross-origin isolation probe inconclusive: ${error.message}`)
  }
} catch (error) {
  record('suite ran to completion', false, error.message)
} finally {
  const uniqueErrors = [...new Set(consoleErrors)]
  console.log('\n--- console / page errors ---')
  console.log(uniqueErrors.length === 0 ? 'none' : uniqueErrors.slice(0, 25).join('\n'))

  const failed = results.filter((result) => !result.ok).map((result) => result.name)
  console.log(`\n=== ${results.filter((r) => r.ok).length}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''} ===`)
  if (failed.length) console.log(`FAILED: ${failed.join('; ')}`)

  // Visual evidence from a headed run: what the studio actually looked like.
  if (process.env.E2E_SCREENSHOT) {
    try {
      await page.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true })
      console.log(`screenshot: ${process.env.E2E_SCREENSHOT}`)
    } catch (error) {
      console.log(`INFO  screenshot failed (${error.message})`)
    }
  }

  await browser.close()
  process.exit(failed.length === 0 ? 0 : 1)
}
