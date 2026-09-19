# Hushwing Audio — Build History

Chronological log of what has actually been done, newest session last.
Read this together with `todo.md` (what is left) and `AGENTS.md` (the contract).

---

## Session 1 — 2026-09-19

### Goal
Read `PRD-Hushwing.md` and build v1, prepped for hosting and for GitHub Pages.

### What was done

**1. Scaffold** — `bun create vite Hushwing-Audio --template react-ts` (React 19,
TypeScript 6, Vite 8), then installed:

| Package | Why |
| --- | --- |
| `tailwindcss`, `@tailwindcss/vite` | v4 styling through the Vite plugin |
| `zustand` | single app store for the queue/debug state |
| `framer-motion` | landing-page motion |
| `lucide-react` | icon set (installed, not yet used) |
| `jszip` | batch `.zip` export (installed, not yet used) |
| `@ffmpeg/ffmpeg` + `@ffmpeg/util` + `@ffmpeg/core@0.12.6` | local audio extract / mux |
| `coi-serviceworker` | cross-origin isolation for SharedArrayBuffer |
| `uuid` (+ `@types/uuid`) | job identifiers |

Removed the Vite starter assets (`src/assets`, `src/App.css`) and rewrote
`index.html`, `src/index.css` (Tailwind v4 `@theme` tokens, dark-first palette),
`src/main.tsx` and `vite.config.ts` (react + tailwind plugins, `server.hmr: false`).

**2. Core libraries written**

| File | What it does |
| --- | --- |
| `src/types/hushwing.ts` | `Job`, `JobStatus`, `ModelId`, `OutputFormat`, supported-format tables |
| `src/lib/logger.ts` | bounded rolling log (250 entries) + `.txt` export + download |
| `src/lib/opfs.ts` | OPFS get/write/read/exists/remove wrappers for streaming large media |
| `src/lib/models.ts` | model catalogue metadata (labels, tags, availability) |
| `src/lib/filekit.ts` | MIME/extension sniffing, output naming, blob URLs, WAV encoder |
| `src/lib/engine.ts` | Web Audio enhancement engine (high-pass → expander → compressor) |
| `src/lib/ffmpeg.ts` | ffmpeg.wasm loader, audio extraction, video muxing, OPFS staging |
| `src/lib/pipeline.ts` | job orchestration: stage → extract → enhance → write result |
| `src/lib/hushwing-api.ts` | `window.HushwingAPI` headless surface |
| `src/lib/cloud-import.ts` | Google Drive / OneDrive import stubs (throw by design) |
| `src/store/app.ts` | zustand store: queue CRUD, status transitions, log sink, URL params |

**3. UI written**

- `src/App.tsx` — dark landing page (hero, feature grid, CTAs) plus the dashboard
  (dropzone, model/output selectors, queue controls, model summary, status card,
  inline debug log, processing banner).
- `src/components/` — `Header`, `UploadZone`, `JobQueue`, `DropzoneHeader`,
  `AnimatedSection`, and `ui.tsx` primitives (`Button`, `Card`, `Badge`, `Progress`,
  `FileInput`).
- `src/workers/ffmpeg-worker.ts` — worker entry point skeleton.

### Where it stands

Working tree **does not compile**. `bun tsc -b --noEmit` reports ~38 errors, all
catalogued in `todo.md` §1. The main causes:

- a naming collision between `createLogger` and `logger.logger.*` call sites,
- `FFmpeg.loadFile()` used where the v0.12 API is `load()` / `writeFile()`,
- `file.name` accessed on a `File | Blob` union without a narrowing helper,
- `react-dropzone` and `react-router-dom` imported but never installed,
- CommonJS `require()` inside ESM modules in `hushwing-api.ts`,
- `DedicatedWorkerGlobalScope` not present in the tsconfig `lib` array,
- a stray placeholder accidentally written over `src/components/DebugLog.tsx`.

### Process notes / mistakes to avoid

- Several file writes in this session were repeated attempts at the same file after
  "content is the same" skips. Net effect is fine, but check the file exists with the
  intended content before moving on.
- One write left `DebugLog.tsx` as a comment-only stub while `App.tsx` still imports it.
  Verify imports resolve after deleting or stubbing a component.
- `todo.md`, `AGENTS.md` and this file were added after the fact, at the user's request.

### Not yet started

- GitHub Pages workflow, relative `base`, `.nojekyll`
- `mcp.json`, semantic DOM hook attributes
- AudioWorklet live A/B preview pipeline
- JSZip batch export
- Real Google Drive / OneDrive pickers
- RNNoise as an actual WASM denoiser (currently the Web Audio chain)

---

## Session 2 — 2026-09-19

### Goal
Finish v1: make it compile, make it run, prep it for hosting and GitHub Pages.

### Layout change
Moved the whole application from `Hushwing-Audio/` to the repository root (option A in the
previous session's open question). `PRD-Hushwing.md`, `README.md`, `LICENSE`, `AGENTS.md`,
`todo.md` and `history.md` stayed where they were, and the Vite starter `README.md`/
`icons.svg` were removed. Hosting and Pages now both see `dist/` at the root.

### What was done

**1. Compile pass — `bun tsc -b --noEmit` is clean.**

| File | Change |
| --- | --- |
| `lib/logger.ts` | Rewritten: rolling 250-entry buffer + `useSyncExternalStore` snapshot + subscription |
| `lib/engine.ts` | Rewritten around the sample-based `HushwingEngine` contract; `WorkerEngine` (Pipeline A) with a main-thread fallback |
| `lib/dsp.ts` | **New.** Pure-JS kernels: RBJ high-pass, adaptive noise-floor gate, soft-knee compressor, soft limiter, windowed-sinc resampler, peak helpers |
| `lib/pipeline.ts` | Rewritten: stage → extract → enhance → resample → stream to OPFS → optional mux, with progress/stage reporting |
| `lib/ffmpeg.ts` | Rewritten: single-threaded core, progress events parsed against the reported duration, `VITE_FFMPEG_CORE_BASE` override, virtual-FS cleanup in `finally` |
| `lib/filekit.ts` | Added `parseWav` (no `AudioContext` needed, so it works in a worker), `encodeWavChunks`, `formatBytes`, `formatDuration` |
| `lib/opfs.ts` | Added `openOPFSWriter` (streaming writes), `listOPFS`, `opfsUsage`, `opfsSupported`; fixed the capability check |
| `lib/preview.ts` | **New.** `PreviewSession` — Pipeline B, decodes peaks, loads the worklet, plays A/B |
| `lib/cloud-import.ts` | Rewritten with a real Google Picker (GIS token client) and OneDrive picker (SDK v7.2) path, gated on env keys |
| `lib/hushwing-api.ts` | Extended `getJobs()` with progress/stage/error |
| `store/app.ts` | `sourceName` / `sourceKind` captured at enqueue, `parseUrlParams`, honest `stage` text |
| `types/hushwing.ts` | `EngineResult` now carries samples, not a blob; jobs carry source name/kind/stage paths |
| `workers/enhance-worker.ts` | **New** (replaces the `ffmpeg-worker.ts` stub): typed worker scope without a `lib="webworker"` reference, transferable buffers, one kernel per model |

**2. UI built out.**

- `components/Landing.tsx` — hero with stat row, six feature cards, three-step pipeline,
  engine cards driven by `MODEL_SPECS`, cloud-vs-local comparison table, CTA band, glow backdrop.
- `App.tsx` — rewritten shell: `#studio` deep link, boot effects (URL params, API install,
  capability log), lazy ffmpeg preload, queue handlers that revoke URLs and purge OPFS.
- `components/AbPreview.tsx` — waveform canvas (click to seek), play/pause, A · Before / B · After
  toggle, live model switch, level meter, duration readout.
- `components/JobQueue.tsx` — filters, `.zip` export, per-job A/B and download actions,
  `data-job-id` / `data-status` / `data-job-name` for agents.
- `components/DebugLog.tsx` — reactive log with an everything/problems filter, capability badges,
  log download.
- `components/CloudImport.tsx` — URL import plus Drive/OneDrive buttons that explain exactly
  which key is missing.
- `components/Header.tsx`, `UploadZone.tsx`, `ui.tsx` — restyled and re-wired; `Button` accepts
  `data-*` attributes so the agent hooks live on real elements.

**3. Hosting and Pages.**

- `vite.config.ts`: `base: './'`, `server.host 0.0.0.0`, port from `PORT`, `worker.format 'es'`.
- `index.html`: relative/public asset refs, description + theme meta, `window.coi` config and the
  vendored `coi-serviceworker.js` loader (top-level windows only, `?coi=off` to disable).
- `public/`: `coi-serviceworker.js`, `mcp.json`, `.nojekyll`, new `favicon.svg`,
  `worklets/hushwing-preview.js`.
- `.github/workflows/deploy.yml`: install → typecheck → `vite build` → `deploy-pages`.
- Preview commands saved with `freebuff-preview set-install/set/set-build`; preview reaches ready.
- Verified `bunx vite build` emits `dist/` with relative asset paths in `index.html`.
- A small Vite plugin in `vite.config.ts` copies `@ffmpeg/core` into `dist/ffmpeg-core/`, and
  `lib/ffmpeg.ts` probes that path before falling back to unpkg — production builds now fetch
  from their own origin only, without committing 32 MB of WASM to git.

### Process notes / mistakes to avoid

- A chained `freebuff-preview set-install "a" && freebuff-preview set "b" 5173` saved the whole
  string as the install command. Run those commands one at a time.
- `erasableSyntaxOnly` in `tsconfig.app.json` rejects constructor parameter properties; the
  first `PreviewSession` draft used one and had to be expanded.
- A worker file must not include `/// <reference lib="webworker" />` while the app tsconfig
  already loads the DOM libs; type the worker scope locally instead.
- `getFloatTimeDomainData` in the DOM libs wants `Float32Array<ArrayBuffer>`; a plain
  `Float32Array` field fails to typecheck.
- One file write was accidentally submitted as a placeholder before the real content; always
  re-read a file after writing it if the write felt ambiguous.

### Not yet verified

- Cloud pickers (no OAuth keys available in this environment).
- A/B preview and large-file behaviour on a physical iOS device.
- Cross-origin isolation on a live Pages deployment.

### Not started (v2)

- Real RNNoise weights, DeepFilterNet 3, OPFS mounted into ffmpeg, queue persistence,
  per-job DSP parameters, PWA offline caching, code splitting.

---

## Session 2 — 2026-09-19

### Goal

Verify the A/B preview and a full audio + video processing run end to end in a real browser, and
fix whatever broke.

### End-to-end harness

No browser or `ffmpeg` CLI existed in the sandbox, so `e2e/hushwing.e2e.mjs` was written to drive
headless Chromium (Playwright) against the live preview. It generates a 4 s 16 kHz WAV with speech
buried in hiss, downloads a real H.264/AAC MP4, records a VP8/Opus WebM in-page with
`MediaRecorder`, then queues all three, waits for them to settle, downloads every result and
inspects the delivered bytes (RIFF/fmt header, Matroska magic `1a45dfa3`, MP4 `ftyp` brand). It
also exercises the worklet preview (level meter, playhead, A/B switch, teardown), the `.zip`
export, the URL parameters and `window.HushwingAPI`. `bun run test:e2e` runs it.

### Bugs it found and the fixes

| Bug | Cause | Fix |
| --- | --- | --- |
| ffmpeg core never loaded (all jobs failed) | `@ffmpeg/ffmpeg` always spawns a *module* worker, where `importScripts` throws and it falls back to `import(coreURL)`. The UMD core has no default export, so loading failed — and the worker posted the reason as a plain string that error handling discarded as "unknown error" | Ship/serve the **ESM** core and keep the string message from the worker instead of swallowing it |
| WebM/MKV inputs failed to mux | `muxVideo` always wrote an MP4, and ffmpeg rejects VP8/VP9 in MP4 | Container and audio encoder are now chosen from the input extension and the core's actual encoder list (`lib/ffmpeg.ts`), so WebM stays WebM |
| Failures were undiagnosable | Job errors carried no stack | The pipeline logs `error.stack` on failure; the suite dumps the app's own diagnostic log whenever a job errors |

### Verification results

`bun tsc -b --noEmit` clean, `bunx vite build` emits `dist/` (32 MB, including the self-hosted
`dist/ffmpeg-core/`), and the browser suite passes **21/21**:

```
WAV  → interview-enhanced.wav    384 044 B · RIFF · 48 000 Hz · mono · 16-bit
WebM → screen-capture-enhanced.webm  93 285 B · magic 1a45dfa3
MP4  → clip-enhanced.mp4       5 823 203 B · ftyp
zip  → hushwing-results-*.zip  6 300 916 B
A/B  → worklet ready · meter peaked 50% · playhead reached 2.87 s · A↔B switch and teardown clean
```

No console or page errors. `crossOriginIsolated` became `true` once the service worker took over.

### Process notes / mistakes to avoid

- **`innerText` reflects CSS `text-transform`.** The diagnostics heading is styled `uppercase`, so
  `innerText` reports `DIAGNOSTICS` while `textContent` reports `Diagnostics`. Assert on
  `textContent`, or on a `data-*` hook.
- **The preview host caches a plain module URL.** After editing a component, a `curl` of
  `/src/components/Foo.tsx` can return the *previous* transform while `…?t=1` returns the current
  one. Never conclude the app is broken (or fixed) from a plain-URL fetch; cache-bust it.
- Playwright's `bun add -d playwright` does not download browsers, so it costs nothing at build
  time; `bunx playwright install chromium` is the separate one-time step.
- Assert on the `data-status` hook for job state rather than scraping rendered copy — the
  text-based status trail printed `?` for every poll.

### Production (GitHub Pages)

- Pushed `bb9fed5` to `main`. The `Deploy to GitHub Pages` workflow built and deployed `dist/`
on the first try (build 14 s, deploy 9 s).
- **The live URL does not serve that artifact yet.** `https://spuds0588.github.io/Hushwing-Audio/`
returns an `index.html` that loads `/src/main.tsx`, and `/mcp.json`,
`/worklets/hushwing-preview.js` and `/ffmpeg-core/*` all 404. Pages is configured
`build_type: legacy` with `source: main:/`, so the legacy Jekyll pipeline rebuilds the repository
root on every push and wins over `actions/deploy-pages`.
- The setting cannot be changed with the repository-scoped credential
(`PUT /repos/Spuds0588/Hushwing-Audio/pages` → `403 Resource not accessible by integration`).
One click is required: **Settings → Pages → Source: GitHub Actions** — which is what the README's
"Deploying to GitHub Pages" section already tells a human to do.
- Since production was unreachable, the built bundle was verified directly instead: `dist/` served
from a static file server, then this same suite run **headed** against it — **21/21, no console
or page errors, `crossOriginIsolated === true`** (so the COI service-worker path does work in a
production build). `mcp.json`, the worklet and the 32 MB `ffmpeg-core.wasm` all served 200 from
the same origin, i.e. a deployed build really does fetch nothing but itself.

### Pages source switched (post-script)

The Pages source was switched to **GitHub Actions** (`build_type` is now `workflow`). The
repository-scoped credential cannot make that change (403), and `gh workflow run` is refused for
the same reason, so the deployment is triggered by pushing to `main`.

### Still not verified

- Cloud pickers (no OAuth keys in this environment).
- A/B preview on a physical iOS device.
- Cross-origin isolation on the *live* Pages deployment (the production build is verified locally;
the custom domain/CDN path is not).
