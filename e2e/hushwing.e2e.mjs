/**
 * Hushwing Audio — end-to-end browser test.
 *
 * Drives the real app in headless Chromium through the real flow: add files,
 * pick an engine, watch the queue. It queues a generated WAV, a real H.264/AAC
 * MP4, a VP8/Opus WebM recorded in-page, an MP3, a FLAC and an Ogg/Vorbis file,
 * then inspects the delivered bytes of every result — container, rate, and which
 * decoder produced the PCM.
 *
 * Usage:
 *   bun install
 *   bunx playwright install chromium          # once
 *   PREVIEW_URL=https://<preview-host> bun run test:e2e
 *
 * The MP3/FLAC/OGG/MP4 fixtures are downloaded into e2e/.cache on first run; if
 * a download fails those cases are skipped rather than failed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const cacheDir = join(here, '.cache')
const BASE = process.env.PREVIEW_URL
if (!BASE) throw new Error('PREVIEW_URL is required (the running preview origin)')

const FIXTURES = {
  mp4: {
    file: process.env.E2E_MP4 ?? join(cacheDir, 'sample.mp4'),
    url: 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4',
    name: 'clip.mp4',
    mimeType: 'video/mp4',
  },
  mp3: {
    file: process.env.E2E_MP3 ?? join(cacheDir, 'sample.mp3'),
    url: 'https://download.samplelib.com/mp3/sample-3s.mp3',
    name: 'voiceover.mp3',
    mimeType: 'audio/mpeg',
  },
  flac: {
    file: process.env.E2E_FLAC ?? join(cacheDir, 'sample.flac'),
    url: 'https://filesamples.com/samples/audio/flac/sample1.flac',
    name: 'master.flac',
    mimeType: 'audio/flac',
  },
  ogg: {
    file: process.env.E2E_OGG ?? join(cacheDir, 'sample.ogg'),
    url: 'https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg',
    name: 'legacy.ogg',
    mimeType: 'audio/ogg',
  },
  m4a: {
    file: process.env.E2E_M4A ?? join(cacheDir, 'sample1.m4a'),
    url: 'https://filesamples.com/samples/audio/m4a/sample1.m4a',
    name: 'call-recording.m4a',
    mimeType: 'audio/x-m4a',
  },
  avi: {
    file: process.env.E2E_AVI ?? join(cacheDir, 'with-audio.avi'),
    url: 'https://filesamples.com/samples/video/avi/sample_960x400_ocean_with_audio.avi',
    name: 'ocean.avi',
    mimeType: 'video/x-msvideo',
  },
  silentAvi: {
    file: process.env.E2E_AVI_SILENT ?? join(cacheDir, 'clip.avi'),
    url: 'https://filesamples.com/samples/video/avi/sample_640x360.avi',
    name: 'silent.avi',
    mimeType: 'video/x-msvideo',
  },
}

const results = []
const consoleErrors = []
const skipped = []

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

/** Download a fixture once into e2e/.cache; null when it cannot be fetched. */
async function ensureFixture(spec) {
  if (existsSync(spec.file)) return readFileSync(spec.file)

  try {
    mkdirSync(cacheDir, { recursive: true })
    const response = await fetch(spec.url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    writeFileSync(spec.file, bytes)
    return bytes
  } catch (error) {
    console.log(`INFO  could not fetch ${spec.name} (${error.message})`)
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

const stepOf = () => page.getAttribute('main', 'data-wizard-step')

async function jobRows() {
  return page.$$eval('li[data-job-id]', (rows) =>
    rows.map((row) => ({
      id: row.getAttribute('data-job-id'),
      status: row.getAttribute('data-status'),
      name: row.getAttribute('data-job-name'),
      model: row.getAttribute('data-job-model'),
      decoder: row.getAttribute('data-job-decoder'),
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }))
  )
}

/** The queue lives on step 3, so make sure we are looking at it before reading. */
async function goToStep(target) {
  if ((await stepOf()) === target) return
  await page.click(`[data-mcp-target="wizard-step"][data-step="${target}"]`)
  await page.waitForFunction(
    (value) => document.querySelector('main')?.dataset.wizardStep === value,
    target,
    { timeout: 10_000 }
  )
}

async function waitForSettled(expected, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await goToStep('run')
    const rows = await jobRows()
    if (
      rows.length >= expected &&
      rows.every((row) => row.status === 'completed' || row.status === 'error')
    ) {
      return rows
    }
    if (Date.now() > deadline) return jobRows()
    await sleep(1000)
  }
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
      // For RIFF containers the fourcc sits at offset 8 (`RIFF` size `AVI `/`WAVE`).
      container: String.fromCharCode(...bytes.subarray(8, 12)),
      hex: Array.from(bytes.subarray(0, 4))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      wavHeader: bytes.length > 44 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
        ? {
            sampleRate:
              bytes[24] | (bytes[25] << 8) | (bytes[26] << 16) | (bytes[27] << 24),
            channels: bytes[22] | (bytes[23] << 8),
            bits: bytes[34] | (bytes[35] << 8),
          }
        : null,
    }
  }, jobId)
}

try {
  /* --------------------------------------------------- step 1: add files -- */
  await page.goto(`${BASE}/?coi=off#studio`, { waitUntil: 'networkidle' })

  const heading = (await page.textContent('h1')) ?? ''
  record('the studio is the page', /without uploading/i.test(heading), heading.slice(0, 48))

  // The whole point of the wizard: one step at a time. Everything the old single
  // page showed at once must be absent until its step is reached.
  const firstStep = await page.evaluate(() => ({
    step: document.querySelector('main')?.getAttribute('data-wizard-step'),
    steps: document.querySelectorAll('[data-mcp-target="wizard-step"]').length,
    engineCards: document.querySelectorAll('[data-mcp-target="model-selector"]').length,
    abPreview: Boolean(document.querySelector('[data-mcp-target="ab-preview"]')),
    jobRows: document.querySelectorAll('li[data-job-id]').length,
    jobQueueHeading: /Job queue/i.test(document.body.textContent ?? ''),
    batchProgress: Boolean(document.querySelector('[data-mcp-target="batch-progress"]')),
  }))
  record(
    'only step one is on screen (no engine cards, queue or progress yet)',
    firstStep.step === 'add' &&
      firstStep.steps === 3 &&
      firstStep.engineCards === 0 &&
      !firstStep.abPreview &&
      firstStep.jobRows === 0 &&
      !firstStep.jobQueueHeading &&
      !firstStep.batchProgress,
    JSON.stringify(firstStep)
  )

  // Automated stand-in for "does it look right": a blank or unstyled page fails here.
  const layout = await page.evaluate(() => {
    const dropzone = document.querySelector('[aria-label="Add audio or video files to the queue"]')
    const box = dropzone?.getBoundingClientRect()
    const heading = document.querySelector('h1')
    const headingSize = heading ? parseFloat(getComputedStyle(heading).fontSize) : 0
    return {
      dropzoneWidth: Math.round(box?.width ?? 0),
      dropzoneHeight: Math.round(box?.height ?? 0),
      headingSize,
      horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
      styled: getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)',
    }
  })
  record(
    'the page renders styled, with a usable drop target and no horizontal overflow',
    layout.dropzoneWidth > 300 &&
      layout.dropzoneHeight > 150 &&
      layout.headingSize >= 22 &&
      layout.horizontalOverflow <= 1 &&
      layout.styled,
    JSON.stringify(layout)
  )

  /* ------------------------------------------------------------ agent hooks -- */
  const hooks = await page.evaluate(() => ({
    upload: Boolean(document.querySelector('input[data-mcp-action="upload"]')),
    steps: Boolean(document.querySelector('[data-mcp-target="wizard-step"][data-step="engine"]')),
    api: typeof window.HushwingAPI === 'object',
  }))
  record('DOM hooks + HushwingAPI present on step one', Object.values(hooks).every(Boolean), JSON.stringify(hooks))

  const models = await page.evaluate(() => window.HushwingAPI.getModels())
  record(
    'API advertises the shipped engines',
    JSON.stringify(models) === '["webaudio","rnnoise"]',
    JSON.stringify(models)
  )

  /* --------------------------------------------------------- step 1 → 2 -- */
  const wav = makeWav()
  await page.setInputFiles('input[data-mcp-action="upload"]', {
    name: 'interview.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  })
  await page.waitForFunction(() => document.querySelector('main')?.dataset.wizardStep === 'engine', null, {
    timeout: 10_000,
  })
  record('adding a file advances to the engine step', (await stepOf()) === 'engine', await stepOf())

  /* ------------------------------------------------------ step 2: engine -- */
  const cards = await page.$$eval('[data-mcp-target="model-selector"]', (nodes) =>
    nodes.map((node) => ({
      id: node.dataset.modelId,
      disabled: node.disabled,
      selected: node.dataset.selected === 'true',
    }))
  )
  record(
    'the engine step lists every engine and disables the unimplemented one',
    cards.length === 3 && cards.some((card) => card.id === 'deepfilternet' && card.disabled),
    cards.map((card) => `${card.id}${card.disabled ? ' (disabled)' : ''}`).join(', ')
  )

  await page.click('[data-mcp-target="model-selector"][data-model-id="rnnoise"]')
  const selected = await page.$eval('[data-mcp-target="model-selector"][data-model-id="rnnoise"]', (node) => node.dataset.selected)
  record('choosing an engine marks it selected', selected === 'true', `data-selected=${selected}`)

  /* ------------------------------- no preview UI, and no worklet (on purpose) -- */
  // The live AudioWorklet audition was removed: it could not match the delivered
  // file, and a preview that disagrees with the output is worse than none. This
  // guards against either one quietly coming back.
  const previewGone = await page.evaluate(() => ({
    panel: Boolean(document.querySelector('[data-mcp-target="ab-preview"]')),
    openFromRow: Boolean(document.querySelector('[data-mcp-action="open-ab-preview"]')),
    play: Boolean(document.querySelector('[data-mcp-action="preview-toggle-play"]')),
    workletChunk: performance
      .getEntriesByType('resource')
      .some((entry) => entry.name.includes('worklets/') || entry.name.includes('hushwing-preview')),
  }))
  record(
    'the removed A/B preview and its worklet stay removed',
    Object.values(previewGone).every((value) => value === false),
    JSON.stringify(previewGone)
  )

  /* -------------------------------------------------- step 1 again: rest -- */
  await page.click('button[data-mcp-action="wizard-back"]')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.wizardStep === 'add', null, {
    timeout: 10_000,
  })

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

  const fixtureBytes = {}
  for (const [key, spec] of Object.entries(FIXTURES)) fixtureBytes[key] = await ensureFixture(spec)

  const uploads = [
    { name: 'screen-capture.webm', mimeType: 'video/webm', buffer: webm },
    fixtureBytes.mp4 && { ...FIXTURES.mp4, buffer: fixtureBytes.mp4 },
    fixtureBytes.mp3 && { ...FIXTURES.mp3, buffer: fixtureBytes.mp3 },
    fixtureBytes.flac && { ...FIXTURES.flac, buffer: fixtureBytes.flac },
    fixtureBytes.ogg && { ...FIXTURES.ogg, buffer: fixtureBytes.ogg },
    fixtureBytes.m4a && { ...FIXTURES.m4a, buffer: fixtureBytes.m4a },
    fixtureBytes.avi && { ...FIXTURES.avi, buffer: fixtureBytes.avi },
  ].filter(Boolean)

  for (const upload of uploads) {
    // Adding a file ends step 1, so walk back to it before each drop.
    await goToStep('add')
    await page.setInputFiles('input[data-mcp-action="upload"]', upload)
    await sleep(250)
  }

  const expectedJobs = uploads.length + 1
  // The added-files list is step 1, and every drop moved us to step 2.
  await goToStep('add')
  const added = await page.$$eval('[data-mcp-target="added-files"] li', (nodes) =>
    nodes.map((node) => node.getAttribute('data-job-id'))
  )
  record(
    'every fixture lands in the added-files list',
    added.length === expectedJobs,
    `${added.length}/${expectedJobs} listed`
  )

  // No engine card is a step-2 thing, but the engine choice still has to be live
  // when we get back there, so walk the wizard forward again.
  await page.click('button[data-mcp-action="wizard-next"]')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.wizardStep === 'engine', null, {
    timeout: 10_000,
  })

  /* ------------------------------------------------------------- processing -- */
  await page.click('button[data-mcp-action="process-queue"]')
  await page.waitForFunction(() => document.querySelector('main')?.dataset.wizardStep === 'run', null, {
    timeout: 10_000,
  })
  record('starting the batch moves to the processing step', (await stepOf()) === 'run', await stepOf())

  await page.waitForSelector('[data-mcp-target="batch-progress"]', { timeout: 10_000 })
  record('the processing step shows batch progress', true)

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

  const byName = {}
  for (const row of settled) byName[row.name] = row

  const apiJobs = await page.evaluate(() => window.HushwingAPI.getJobs())
  record(
    'headless API reports every job finished at 100%',
    apiJobs.length === expectedJobs &&
      apiJobs.every((job) => job.status === 'completed' && job.progress === 100),
    JSON.stringify(apiJobs.map((job) => [job.name, job.status, job.progress]))
  )

  /* ------------------------------------------------------- which decoder -- */
  // The claim under test: audio is decoded in JavaScript, video (and containers
  // no JS decoder handles) go through ffmpeg.
  const decoders = Object.fromEntries(settled.map((row) => [row.name, row.decoder]))
  record(
    'WAV is parsed in JS and MP3/FLAC/Ogg/M4A-AAC all decode natively',
    decoders['interview.wav'] === 'wav reader' &&
      decoders['voiceover.mp3'] === 'mediabunny' &&
      decoders['master.flac'] === 'mediabunny' &&
      decoders['legacy.ogg'] === 'mediabunny' &&
      decoders['call-recording.m4a'] === 'mediabunny',
    JSON.stringify(decoders)
  )
  record(
    'video audio is read natively, and AVI falls back to ffmpeg',
    decoders['clip.mp4'] === 'mediabunny' &&
      decoders['screen-capture.webm'] === 'mediabunny' &&
      decoders['ocean.avi'] === 'ffmpeg',
    JSON.stringify(decoders)
  )
  record(
    'every job ran the selected engine',
    settled.every((row) => row.model === 'rnnoise'),
    settled.map((row) => `${row.name}:${row.model}`).join(', ')
  )

  /* ---------------------------------------------------------------- outputs -- */
  const wavResult = await inspectDownload(byName['interview.wav'].id)
  record(
    'WAV job delivered 48 kHz mono PCM',
    !wavResult.missing &&
      wavResult.head === 'RIFF' &&
      wavResult.wavHeader?.sampleRate === 48_000 &&
      wavResult.wavHeader.channels === 1 &&
      wavResult.size > 100_000,
    `${wavResult.download} · ${wavResult.size} bytes · ${wavResult.wavHeader?.sampleRate} Hz · ${wavResult.wavHeader?.bits}-bit`
  )

  if (byName['voiceover.mp3']) {
    const mp3Result = await inspectDownload(byName['voiceover.mp3'].id)
    record(
      'MP3 decoded natively and delivered as a 48 kHz WAV',
      !mp3Result.missing &&
        mp3Result.head === 'RIFF' &&
        mp3Result.wavHeader?.sampleRate === 48_000 &&
        mp3Result.size > 100_000,
      `${mp3Result.download} · ${mp3Result.size} bytes · ${mp3Result.wavHeader?.sampleRate} Hz`
    )
  } else {
    skip('MP3 decode case', 'fixture unavailable')
  }

  if (byName['master.flac']) {
    const flacResult = await inspectDownload(byName['master.flac'].id)
    record(
      'FLAC decoded natively and delivered as a 48 kHz WAV',
      !flacResult.missing &&
        flacResult.head === 'RIFF' &&
        flacResult.wavHeader?.sampleRate === 48_000 &&
        flacResult.wavHeader.channels === 1 &&
        flacResult.size > 1_000_000,
      `${flacResult.download} · ${flacResult.size} bytes · ${flacResult.wavHeader?.sampleRate} Hz`
    )
  } else {
    skip('FLAC decode case', 'fixture unavailable')
  }

  if (byName['legacy.ogg']) {
    const oggResult = await inspectDownload(byName['legacy.ogg'].id)
    record(
      'Ogg/Vorbis decoded natively and delivered as a 48 kHz WAV',
      !oggResult.missing && oggResult.head === 'RIFF' && oggResult.wavHeader?.sampleRate === 48_000,
      `${oggResult.download} · ${oggResult.size} bytes · ${oggResult.wavHeader?.sampleRate} Hz`
    )
  } else {
    skip('Ogg case', 'fixture unavailable')
  }

  if (byName['call-recording.m4a']) {
    const m4aResult = await inspectDownload(byName['call-recording.m4a'].id)
    record(
      'M4A/AAC decoded natively and delivered as a 48 kHz WAV',
      !m4aResult.missing &&
        m4aResult.head === 'RIFF' &&
        m4aResult.wavHeader?.sampleRate === 48_000 &&
        m4aResult.wavHeader.channels === 1 &&
        m4aResult.size > 1_000_000,
      `${m4aResult.download} · ${m4aResult.size} bytes · ${m4aResult.wavHeader?.sampleRate} Hz`
    )
  } else {
    skip('M4A decode case', 'fixture unavailable')
  }

  if (byName['ocean.avi']) {
    const aviResult = await inspectDownload(byName['ocean.avi'].id)
    record(
      'AVI (ffmpeg path) comes back in an AVI container with the enhanced audio',
      !aviResult.missing &&
        aviResult.head === 'RIFF' &&
        aviResult.container === 'AVI ' &&
        (aviResult.download ?? '').endsWith('.avi'),
      `${aviResult.download} · ${aviResult.size} bytes · ${aviResult.head}/${aviResult.container}`
    )
  } else {
    skip('AVI mux case', 'fixture unavailable')
  }

  const webmResult = await inspectDownload(byName['screen-capture.webm'].id)
  record(
    'WebM input muxed back to WebM (container matched, video copied)',
    !webmResult.missing && webmResult.hex === '1a45dfa3' && (webmResult.download ?? '').endsWith('.webm'),
    `${webmResult.download} · ${webmResult.size} bytes · magic ${webmResult.hex}`
  )

  if (byName['clip.mp4']) {
    const mp4Result = await inspectDownload(byName['clip.mp4'].id)
    record(
      'MP4 input remuxed into an MP4 with the enhanced audio',
      !mp4Result.missing &&
        mp4Result.brand === 'ftyp' &&
        (mp4Result.download ?? '').endsWith('.mp4') &&
        mp4Result.size > 1_000_000,
      `${mp4Result.download} · ${mp4Result.size} bytes`
    )
  } else {
    skip('MP4 mux case', 'fixture unavailable')
  }

  /* ------------------------------------------------------------- zip export -- */
  const downloadEvent = page.waitForEvent('download', { timeout: 120_000 }).catch(() => null)
  await page.click('button[data-mcp-action="export-zip"]')
  const zip = await downloadEvent
  if (zip) {
    const bytes = readFileSync(await zip.path())
    record(
      'zip export packaged the results',
      bytes.length > 100_000 && bytes.subarray(0, 2).toString() === 'PK',
      `${zip.suggestedFilename()} · ${bytes.length} bytes`
    )
  } else {
    record('zip export packaged the results', false, 'no download event fired')
  }

  /* ------------------------------- native decode never fetches the core -- */
  // The claim: an audio queue is decoded without the 32 MB ffmpeg core. The job's
  // `decoder` already proves which path ran, so this audit checks the other half
  // — that nothing preloaded the core behind the job's back. It needs a fresh
  // context, because the video jobs above have already pulled it in.
  if (fixtureBytes.mp3 && fixtureBytes.ogg && fixtureBytes.m4a) {
    const auditContext = await browser.newContext({ acceptDownloads: true })
    const auditPage = await auditContext.newPage()
    const coreRequests = []
    auditPage.on('request', (request) => {
      if (request.url().includes('ffmpeg-core')) coreRequests.push(request.url())
    })

    try {
      await auditPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
      await auditPage.waitForSelector('main[data-wizard-step]', { timeout: 20_000 })

      const audit = []
      for (const spec of [FIXTURES.mp3, FIXTURES.ogg, FIXTURES.m4a]) {
        const key = spec.name.endsWith('.mp3') ? 'mp3' : spec.name.endsWith('.ogg') ? 'ogg' : 'm4a'
        const outcome = await auditPage.evaluate(
          async ({ name, type, b64 }) => {
            const binary = atob(b64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
            const blob = await window.HushwingAPI.processMedia({
              file: new File([bytes], name, { type }),
              model: 'webaudio',
            })
            const jobs = window.HushwingAPI.getJobs()
            const job = jobs[jobs.length - 1] ?? {}
            return { decoder: job.decoder, status: job.status, size: blob.size }
          },
          { name: spec.name, type: spec.mimeType, b64: fixtureBytes[key].toString('base64') }
        )
        audit.push(`${spec.name}:${outcome.decoder}/${outcome.status}`)
      }

      record(
        'an audio-only queue decodes natively and never fetches the ffmpeg core',
        coreRequests.length === 0 && audit.every((line) => line.includes('mediabunny/completed')),
        `${audit.join(', ')} · core requests: ${coreRequests.length}`
      )
    } catch (error) {
      record('an audio-only queue never fetches the ffmpeg core', false, error.message)
    } finally {
      await auditContext.close()
    }
  } else {
    skip('native decode audit', 'fixtures unavailable')
  }

  /* ------------------------------------------ silent video: a clear failure -- */
  // A video with no audio track cannot be cleaned. The job must say so instead of
  // surfacing an ffmpeg exit code, because that is what a user can act on.
  if (fixtureBytes.silentAvi) {
    const silent = await page.evaluate(
      async ({ name, type, b64 }) => {
        const binary = atob(b64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        try {
          await window.HushwingAPI.processMedia({
            file: new File([bytes], name, { type }),
            model: 'webaudio',
          })
          return { ok: true }
        } catch (error) {
          const jobs = window.HushwingAPI.getJobs()
          const job = jobs[jobs.length - 1] ?? {}
          return { ok: false, message: String(error && error.message), jobError: job.error }
        }
      },
      {
        name: FIXTURES.silentAvi.name,
        type: FIXTURES.silentAvi.mimeType,
        b64: fixtureBytes.silentAvi.toString('base64'),
      }
    )
    record(
      'a video with no audio track fails with a clear message',
      !silent.ok && /no audio track/i.test(silent.message ?? ''),
      silent.message ?? 'resolved unexpectedly'
    )
  } else {
    skip('silent-video case', 'fixture unavailable')
  }

  /* ------------------------------------------------------------- url params -- */
  await page.goto(`${BASE}/?model=rnnoise&debug=true&coi=off#studio`, { waitUntil: 'networkidle' })
  const diagnostics = await page.evaluate(() =>
    // `textContent` rather than `innerText`: the panel heading is CSS-uppercased, so
    // innerText reports DIAGNOSTICS and a case-sensitive match would miss it.
    /Diagnostics/.test(document.body.textContent ?? '')
  )
  await page.setInputFiles('input[data-mcp-action="upload"]', {
    name: 'param-check.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  })
  await page.waitForFunction(() => document.querySelector('main')?.dataset.wizardStep === 'engine', null, {
    timeout: 10_000,
  })
  const paramModel = await page.$eval(
    '[data-mcp-target="model-selector"][data-model-id="rnnoise"]',
    (node) => node.dataset.selected
  )
  record(
    '?model= and ?debug= apply on boot',
    diagnostics && paramModel === 'true',
    JSON.stringify({ diagnostics, paramModel })
  )

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
  console.log(
    `\n=== ${results.filter((r) => r.ok).length}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''} ===`
  )
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
