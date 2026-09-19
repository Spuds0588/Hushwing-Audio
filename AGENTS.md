# Hushwing Audio — Agent & Contributor Guide

This file is the contract for two audiences:

1. **Autonomous agents** (Computer Use, WebMCP clients, browser extensions) that drive the
   live app through a headless interface.
2. **Contributors** (human or AI) editing this repository.

See [`PRD-Hushwing.md`](./PRD-Hushwing.md) for the product requirements,
[`how-it-works.md`](./how-it-works.md) for a guided tour of the internals,
[`history.md`](./history.md) for the build log and [`todo.md`](./todo.md) for what is left.

---

## 1. Repository layout

The application lives at the **repository root** so a single `vite build` produces `dist/`
for both the Freebuff hosting panel and GitHub Pages.

```
/
├── index.html              app shell (COI service worker loader, meta)
├── vite.config.ts          base './', server.hmr false
├── package.json            bun scripts: dev / build / typecheck / lint / preview / test:e2e
├── README.md               pitch, quick start, deploy, gotchas
├── how-it-works.md         guided tour of the pipeline, DSP and both preview paths
├── e2e/hushwing.e2e.mjs    browser suite (see §8)
├── e2e/hushwing.bulk.mjs   queue / bulk suite (see §8)
├── .github/workflows/      deploy.yml → GitHub Pages
├── public/
│   ├── coi-serviceworker.js     COOP/COEP injection for SharedArrayBuffer
│   ├── worklets/
│   │   └── hushwing-preview.js  Pipeline B processor (plain JS, mirrors the `webaudio`
│   │                            chain in lib/dsp.ts)
│   ├── mcp.json                 WebMCP discovery document (served at /mcp.json)
│   └── .nojekyll
└── src/
    ├── App.tsx             the studio shell: step routing, queue wiring, API install
    ├── components/         Header, Stepper, AddStep, EngineStep, RunStep, JobQueue,
    │                       AbPreview, DebugLog, ui primitives
    ├── lib/                dsp, engine, rnnoise, decode, ffmpeg, filekit, opfs, logger,
    │                       models, pipeline, preview, batch, hushwing-api
    ├── store/app.ts        zustand queue, wizard step + URL params
    ├── types/hushwing.ts   domain types
    └── workers/            enhance-worker.ts (Pipeline A)
```

## 2. Stack and conventions

- **Vite + React 19 + TypeScript**, built with `bun`.
- **Tailwind CSS v4** via `@tailwindcss/vite`. Theme tokens are declared in `src/index.css`
  under `@theme` (`--color-surface-*`, `--color-ink-*`, `--color-accent`, `--color-border`).
  Use the tokens; do not hardcode hex values.
- **No component library.** `src/components/ui.tsx` holds the shared primitives
  (`Button`, `Card`, `Badge`, `Progress`, `cx`).
- **State** lives in a single zustand store (`src/store/app.ts`). The queue is the source of
  truth; components read from it rather than duplicating state.
- **All processing is client-side.** There is no backend, no upload and no telemetry. If a
  change would send user media anywhere, it is wrong.
- Server state does not exist, so do not add a data-fetching layer.
- **The studio is a three-step wizard** (`add` → `engine` → `run`), and only the current step is on
  screen. The step lives in the store so the queue can move it: queueing a file ends step one,
  starting the batch jumps to step three, and a file added while a batch is running lands back on
  the running batch rather than on a step that cannot act on it.
- **The product has exactly one decision in it: which engine.** Files are dropped in, the output
  follows the source (video → video with the enhanced track muxed back, audio → 48 kHz WAV), and the
  queue reports progress. Do not add output-format pickers, import-from-URL fields, cloud pickers,
  landing pages or dashboards — they were all removed on purpose.

## 3. Architecture invariants

1. **Stream large files.** Inputs are staged in OPFS and results are written through
   `openOPFSWriter` in chunks. Do not collect a whole rendered file into one blob unless it is
   already needed as a single buffer (ffmpeg's WASM filesystem, for example).
2. **One engine contract.** Everything that can clean audio implements
   `{ process(samples: Float32Array, sampleRate: number): Promise<EngineResult> }`:
   - `webaudio` — pure JS, rendered in the worker (`WorkerEngine`), main thread if workers are
     blocked, and mirrored in the preview worklet. Its inference rate is 16 kHz: the chain is a
     voice-band chain, and the band limit is part of what removes wideband hiss.
   - `rnnoise` — real WebAssembly (`@sapphi-red/web-noise-suppressor`), rendered through an
     `OfflineAudioContext` in `src/lib/rnnoise.ts`. It is 48 kHz only, and it ignores the worker:
     the browser's audio rendering thread is the cheapest correct place to run it. Expect ~11 ms of
     fixed latency from its frame scheduler.

   Each model declares the rate it wants in `MODEL_SPECS[].inferenceRate`; `prepareAudio()` in
   `src/lib/pipeline.ts` decodes, resamples to it, and the result is lifted to 48 kHz for delivery.
3. **`webaudio` DSP has one source of truth.** `src/lib/dsp.ts` is authoritative;
   `public/worklets/hushwing-preview.js` is a hand-mirrored plain-JS copy because an
   AudioWorklet module cannot import TypeScript. Change both together. There is no second copy of
   RNNoise anywhere: both pipelines load the same wasm binary, so the preview cannot drift from the
   render.
4. **The logger is synchronous and bounded.** `src/lib/logger.ts` keeps a rolling 250-entry
   buffer, exposes a `useSyncExternalStore` snapshot, and can export a `.txt` diagnostic.
   Never add unbounded arrays.
5. **Queue concurrency stays at 1, and the queue drains.** `runQueue()` in `src/lib/pipeline.ts`
   re-reads the store after every job rather than iterating a snapshot, so files added while a
   batch is draining are picked up instead of sitting at `queued` forever (the autostart path has
   already returned by then, so nothing else would ever collect them).
6. **OPFS lifecycle per job.** The staged input in `uploads/` is deleted in the job's `finally`;
   the finished result in `outputs/` stays until the user removes the job or clears finished ones.
   Bulk runs are therefore bounded by result size against the browser's ~1 GB quota, not by file
   count.
7. **Free what WASM gives you.** Release pointers in `finally` blocks; delete ffmpeg virtual
   files after every run.
8. **Only mux a video source.** `muxVideo` writes a video container, so `runJob` calls it only for
   `sourceKind === 'video'`. Muxing an audio file into a video container fails every time, which in
   a mixed bulk batch meant one guaranteed-to-fail ffmpeg run per audio file — that is what took
   the renderer down at ~20 files before it was fixed. Audio inputs in a `video` batch deliver the
   enhanced WAV and set `job.warning` to say why.
9. **Audio never loads ffmpeg.** `src/lib/decode.ts` decodes WAV, MP3 and FLAC in JavaScript, so an
   audio job starts immediately and never fetches the 32 MB core; everything else (M4A/AAC,
   Ogg/Vorbis, any video container) falls through to ffmpeg, and the job records which one ran in
   `job.decoder`. `App.tsx` only preloads the core when a queued file actually needs it. Keep the
   decoders behind dynamic `import()` so a queue of videos never downloads them.

## 4. `window.HushwingAPI` (headless control)

Installed on boot. Agents can drive processing without touching the DOM.

```js
const models = await window.HushwingAPI.getModels()   // ['webaudio', 'rnnoise']
const blob = await window.HushwingAPI.processMedia({ file, model: 'webaudio' })
const jobId = await window.HushwingAPI.queueMedia({ file })
const jobs = window.HushwingAPI.getJobs()
window.HushwingAPI.downloadDebugLog()
```

| Method | Signature | Notes |
| --- | --- | --- |
| `getModels()` | `() => Promise<ModelId[]>` | Only models that are actually implemented |
| `processMedia(opts)` | `({ file, model? }) => Promise<Blob>` | Resolves with the enhanced media; rejects on failure. No format option — the container follows the source |
| `queueMedia(opts)` | `({ file, model? }) => Promise<string>` | Returns the job id |
| `getJobs()` | `() => JobSummary[]` | `id`, `status`, `name`, `progress`, `stage`, `resultUrl`, `error`, `warning`, `decoder` |
| `downloadDebugLog()` | `() => void` | Downloads `hushwing-debug-<ts>.txt` |

## 5. Semantic DOM hooks

These exact selectors exist on the live page:

| Selector | Purpose |
| --- | --- |
| `main[data-wizard-step="add\|engine\|run"]` | Which step is on screen. Only that step is rendered |
| `[data-mcp-target="wizard-step"][data-step="<id>"]` | Step tab. `data-state` is `current`, `done` or `later`; disabled when unreachable |
| `input[data-mcp-action="upload"]` | Hidden file input, step 1. Agents set `.files` / dispatch `change` |
| `[data-mcp-target="added-files"] li[data-job-id]` | The queued-file list on step 1 |
| `button[data-mcp-action="wizard-next"]` | Step 1 → 2 |
| `[data-mcp-target="model-selector"][data-model-id="webaudio\|rnnoise\|deepfilternet"]` | Engine card, step 2. A `<button role="radio">`; `data-selected="true"` marks the choice. Disabled when the engine is not implemented |
| `[data-mcp-target="ab-preview"]` | Live A/B audition. `data-preview-model` says which engine is being auditioned |
| `button[data-mcp-action="process-queue"]` | Starts processing every queued job (step 2) |
| `button[data-mcp-action="wizard-back"]` | Step 3 → 1 ("Add more files"), or step 2 → 1 |
| `button[data-mcp-action="start-over"]` | Purges the queue and its OPFS results, back to step 1 |
| `[data-mcp-target="batch-progress"]` | Batch progress card, step 3 |
| `a[data-mcp-action="download-result"][data-job-id="<uuid>"]` | Result download link |
| `button[data-mcp-action="open-ab-preview"][data-job-id="<uuid>"]` | Opens the A/B panel for a queued job |
| `button[data-mcp-action="export-zip"]` | Downloads every finished result as a zip |
| `[data-mcp-target="diagnostics"]` | Diagnostics panel wrapper. Present only while the log is open |

Job rows expose state for polling, including the display name:

```html
<li data-job-id="<uuid>" data-status="queued|preparing|processing|completed|error"
    data-job-name="interview.wav" data-job-model="rnnoise" data-job-decoder="mp3">
```

`data-job-decoder` is the honest answer to "what actually read this file": `wav reader`, `mp3`,
`flac`, or `ffmpeg` when the container needed it.

## 6. URL parameters

| Parameter | Effect |
| --- | --- |
| `?model=rnnoise` | Pre-selects a model (validated against the shipped engines) |
| `?autostart=true` | Begins processing as soon as files are added — which is how the bulk suite drives a whole batch without a click |
| `?debug=true` | Opens the on-screen diagnostics log |
| `?coi=off` | Skips the cross-origin isolation service worker |

There is no separate dashboard: the studio is the only page, so the `#studio` hash that older
links use is redundant but harmless. Do **not** reintroduce a landing page or a format control —
the product is drag in files, pick an engine, watch the queue.

## 7. `mcp.json`

`public/mcp.json` is both the repository's discovery document and the file the deployed site
serves at `/mcp.json`, so WebMCP clients can auto-discover the tool surface at page load.

## 8. Definition of done for a change

```bash
bun tsc -b --noEmit      # must be clean
bunx vite build          # must emit dist/ and exit
```

Then confirm the preview reaches ready and that the studio renders. A change that compiles but
produces a blank page is not done. If you touched `src/lib/dsp.ts`, update
`public/worklets/hushwing-preview.js` to match; if you touched the wizard, both suites navigate it
by step.

For anything touching the pipeline, the engine, or the A/B preview, run the browser suite as well:

```bash
bunx playwright install chromium                # once
PREVIEW_URL=https://<preview-host> bun run test:e2e
```

`e2e/hushwing.e2e.mjs` drives real Chromium against the live preview down the real flow: it checks
that step one is the *only* step on screen, drops a generated WAV and follows the wizard to the
engine step, auditions RNNoise live, then queues a downloaded MP4, an MP3, a FLAC, an Ogg/Vorbis
file and a WebM recorded in-page. It asserts, per job, which decoder ran and what container, rate
and channel count came back, then exercises the zip export, the A/B panel from the queue row, the
URL parameters, `window.HushwingAPI` and cross-origin isolation. It asserts on the app's own
diagnostics when a job fails. Two flakes to know about: the preview host may serve a cached module
for a plain URL (cache-bust before trusting a "missing" hook), and `innerText` reflects CSS
`text-transform`, so assert on `textContent`.

Run the queue suite too for anything touching the queue, OPFS or ffmpeg:

```bash
PREVIEW_URL=https://<preview-host> bun run test:bulk
PREVIEW_URL=https://<preview-host> BULK_MODEL=rnnoise bun run test:bulk   # WebAssembly engine
```

`e2e/hushwing.bulk.mjs` drops 20+ files in one go (plus a few more mid-run, through the wizard's
"Add more files") and checks the invariants above: concurrency stays at 1, progress never regresses,
`uploads/` ends up empty while `outputs/` holds one result per job, mid-run arrivals are not
stranded, the zip matches the results, and heap growth stays bounded. It also proves a mixed batch
keeps every result in its own kind of container. `BULK_MODEL=rnnoise` is the run that matters after
changing the WebAssembly engine: it allocates a worklet node and an `OfflineAudioContext` per job,
so a long queue is exactly where a leak would show up.
