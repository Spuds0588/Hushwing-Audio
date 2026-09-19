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
├── .github/workflows/      deploy.yml → GitHub Pages
├── public/
│   ├── coi-serviceworker.js     COOP/COEP injection for SharedArrayBuffer
│   ├── worklets/
│   │   └── hushwing-preview.js  Pipeline B processor (plain JS, mirrors lib/dsp.ts)
│   ├── mcp.json                 WebMCP discovery document (served at /mcp.json)
│   └── .nojekyll
└── src/
    ├── App.tsx             the studio page, queue wiring, API install
    ├── components/         Header, UploadZone, JobQueue, DebugLog, AbPreview, ui primitives
    ├── lib/                dsp, engine, ffmpeg, filekit, opfs, logger, models, pipeline,
    │                       preview, batch, hushwing-api
    ├── store/app.ts        zustand queue + URL params
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
- **The product has exactly one decision in it: which engine.** Files are dropped in, the output
  follows the source (video → video with the enhanced track muxed back, audio → 48 kHz WAV), and the
  queue reports progress. Do not add output-format pickers, import-from-URL fields, cloud pickers,
  landing pages or dashboards — they were all removed on purpose.

## 3. Architecture invariants

1. **Stream large files.** Inputs are staged in OPFS and results are written through
   `openOPFSWriter` in chunks. Do not collect a whole rendered file into one blob unless it is
   already needed as a single buffer (ffmpeg's WASM filesystem, for example).
2. **One engine contract.** Everything that can clean audio implements
   `{ process(samples: Float32Array, sampleRate: number): Promise<EngineResult> }`, so it can
   be driven from a worker (render) or an `AudioWorklet` (live preview). See `src/lib/engine.ts`
   and `src/lib/dsp.ts`.
3. **DSP has one source of truth.** `src/lib/dsp.ts` is authoritative;
   `public/worklets/hushwing-preview.js` is a hand-mirrored plain-JS copy because an
   AudioWorklet module cannot import TypeScript. Change both together.
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
| `getJobs()` | `() => JobSummary[]` | `id`, `status`, `name`, `progress`, `stage`, `resultUrl`, `error`, `warning` |
| `downloadDebugLog()` | `() => void` | Downloads `hushwing-debug-<ts>.txt` |

## 5. Semantic DOM hooks

These exact selectors exist on the live page:

| Selector | Purpose |
| --- | --- |
| `input[data-mcp-action="upload"]` | Hidden file input. Agents set `.files` / dispatch `change` |
| `select[data-mcp-target="model-selector"]` | Model chooser. Values: `webaudio`, `rnnoise` |
| `button[data-mcp-action="process-queue"]` | Starts processing every queued job |
| `a[data-mcp-action="download-result"][data-job-id="<uuid>"]` | Result download link |
| `[data-mcp-target="diagnostics"]` | Diagnostics panel wrapper. Present only while the log is open |

Job rows expose state for polling, including the display name:

```html
<li data-job-id="<uuid>" data-status="queued|preparing|processing|completed|error"
    data-job-name="interview.wav">
```

## 6. URL parameters

| Parameter | Effect |
| --- | --- |
| `?model=rnnoise` | Pre-selects a model (validated against the shipped engines) |
| `?autostart=true` | Begins processing as soon as files are added or imported |
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
produces a blank page is not done. If you touched
`src/lib/dsp.ts`, update `public/worklets/hushwing-preview.js` to match.

For anything touching the pipeline, the engine, or the A/B preview, run the browser suite as well:

```bash
bunx playwright install chromium                # once
PREVIEW_URL=https://<preview-host> bun run test:e2e
```

`e2e/hushwing.e2e.mjs` drives real Chromium against the live preview: it queues a generated WAV, a
downloaded H.264/AAC MP4 and a WebM recorded in-page, checks every delivered result's container and
header bytes, then exercises the worklet preview, the zip export, the URL parameters and
`window.HushwingAPI`. It asserts on the app's own diagnostics when a job fails. Two flakes to know
about: the preview host may serve a cached module for a plain URL (cache-bust before trusting a
"missing" hook), and `innerText` reflects CSS `text-transform`, so assert on `textContent`.

Run the queue suite too for anything touching the queue, OPFS or ffmpeg:

```bash
PREVIEW_URL=https://<preview-host> bun run test:bulk
```

`e2e/hushwing.bulk.mjs` drops 20+ files in one go (plus a few more mid-run) and checks the invariants
above: concurrency stays at 1, progress never regresses, `uploads/` ends up empty while `outputs/`
holds one result per job, mid-run arrivals are not stranded, the zip matches the results, and heap
growth stays bounded. It also proves a mixed batch under one global output format degrades honestly
instead of failing.
