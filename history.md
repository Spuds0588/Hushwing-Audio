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

### Pages source switched, and production verified (post-script)

The Pages source was switched to **GitHub Actions** (`build_type` is now `workflow`). The
repository-scoped credential cannot make that change (403), and `gh workflow run` is refused for
the same reason, so the deployment is triggered by pushing to `main`.

The next push published the real build — the live document now references `./assets/index-*.js`
and `./assets/index-*.css` instead of `/src/main.tsx` — and the legacy `pages-build-deployment`
pipeline stopped running.

Verified against **https://spuds0588.github.io/Hushwing-Audio/** with the same suite run headed:

- **21/21 checks passed**, no console or page errors, `crossOriginIsolated === true` — the COI
  service-worker path works on real Pages hosting, which is the PRD §2.1 requirement that static
  hosting was the risk.
- WAV `384 044 B · RIFF · 48 000 Hz · mono · 16-bit`; WebM remuxed to WebM (`1a45dfa3`);
  MP4 `5 823 203 B · ftyp`; `.zip` `6 300 903 B`; worklet A/B preview ready, meter peaked 53%,
  playhead reached 2.81 s.
- `/mcp.json`, `/worklets/hushwing-preview.js`, `/coi-serviceworker.js`, `/.nojekyll` and the
  32 129 114-byte `ffmpeg-core.wasm` all serve 200.
- Self-hosting confirmed, not assumed: a `processMedia()` run against production fetched
  `ffmpeg-core.js` and `ffmpeg-core.wasm` from `spuds0588.github.io` and made **zero third-party
  requests**, so the "no CDN, nothing leaves your machine" claim holds on the deployed site.

### Documentation pass

- `README.md` rewritten developer-first: the live link is the first thing on the page, followed by
  quick start, the script table, project layout, testing (including the headed Xvfb command),
  deployment (with the Pages-source trap), env vars, debugging, the agent surface, conventions and
  a "gotchas that will cost you an afternoon" list.
- `how-it-works.md` added: the job pipeline stage by stage with its progress map, the DSP kernels
  and both profiles with real parameters, why the resampler is asymmetric, the two pipelines and the
  click-free A/B design, the ffmpeg traps (module worker + ESM core, the `text/html` probe, container
  and encoder selection), OPFS/COI/logger, and the agent surface.
- Fixed a stale claim found while writing it: `models.ts` described the `webaudio` engine as built on
  `OfflineAudioContext` with `BiquadFilter`/`DynamicsCompressor` nodes, which has not been true since
  the kernels moved into `lib/dsp.ts`.

---

## Session 3 — 2026-09-19

### Goal

Check that bulk and queued workloads actually hold up — the first two sessions only ever queued
three files.

### The bulk suite

`e2e/hushwing.bulk.mjs` (`bun run test:bulk`) drops 20 audio files plus a real MP4 in a single
`setInputFiles` under `?autostart=true`, drops three more files *while the batch is draining*, and
then asserts the queue's invariants rather than the UI: concurrency never exceeds 1, per-job
progress never regresses, `uploads/` ends up empty while `outputs/` holds one result per job,
mid-run arrivals are not stranded, the `.zip` has one entry per result, "Clear finished" purges the
batch from OPFS, and heap growth stays bounded (it prints the peak, so a leak is visible).

### Bugs it found and the fixes

| Bug | Cause | Fix |
| --- | --- | --- |
| **Files dropped mid-run were stranded** — at `queued` forever, never processed | `runQueue()` iterated a snapshot of the queue taken at the start, and the autostart path had already returned because `processing` was true, so nothing was left to collect the arrivals | `runQueue()` re-reads the store after every job and keeps draining |
| **The renderer died on a 21-file batch** (`Target crashed`, no console error) | With one global `video` output format, every audio file ran a mux that *cannot* succeed — ffmpeg was told to map a video stream that does not exist — so a 21-file drop meant ~40 ffmpeg invocations instead of ~20. The same batch survives after the fix, and a 6-file batch survived even before it, which points at the doubled WASM work rather than a leak | `runJob` only calls `muxVideo` for `sourceKind === 'video'`; audio inputs in a `video` batch deliver the enhanced WAV and set `job.warning` saying why |
| Silent output-format mismatch | Nothing told the caller why a `video` request produced a `.wav` | Warning set on the job and surfaced through `HushwingAPI.getJobs()` |

### Verification

`bun tsc -b --noEmit` clean; `bun run lint` has 0 errors (7 pre-existing style warnings). Against
**https://spuds0588.github.io/Hushwing-Audio/**:

- bulk suite **17/17**, 21-file drop + 3 arrivals = **24/24 jobs completed, 0 stranded**, peak
  concurrency 1, 0 progress regressions, `uploads/` empty, `outputs/` exactly 24, zip 24 entries,
  9.5 MB of a ~1 GB OPFS quota, heap peak 95 MB with **+0.4 MB** growth across the batch;
- main suite **21/21** as a regression check after the pipeline change;
- repeated at `BULK_COUNT=50 BULK_VIDEO=0`: **16/16 checks, 53/53 jobs completed** (50 in the drop,
  3 mid-run arrivals), peak concurrency 1, `uploads/` empty, `outputs/` exactly 53, zip 53 entries,
  9.4 MB stored, heap peak 47 MB and **+0.6 MB** growth (`47.4 MB → 17.5 MB` on a later sample, so
  collection is keeping up rather than merely slow to leak);
- no console or page errors in any run.

### Process notes / mistakes to avoid

- `waitForSelector` defaults to `state: 'visible'`, and the upload input is deliberately hidden —
  wait for `attached` instead.
- A completed job row no longer renders a progress bar, so scraping `aria-valuenow` from every row
  made "progress went backwards" fire on completion. Skip rows without a reading.
- The queue is serial by design: wall-clock time is the sum of every job, and the browser's ~1 GB
  OPFS quota bounds a batch via result size, not file count.

---

## Session 4 — 2026-09-19

### Goal

The studio is the product. Make it the main (and only) experience and strip everything that is not
dragging files in, choosing an engine, and watching the queue.

### What changed

| Removed | Why |
| --- | --- |
| The landing page and the landing↔studio navigation | It was a screen to get past before the tool. `Landing.tsx` is deleted; `Header` is now brand + status + log toggle, and `App.tsx` renders one page |
| The output-format selector | A choice the user could only get wrong. The format is now derived at enqueue from the source kind — video keeps its picture with the enhanced track muxed back in, audio comes back as 48 kHz WAV |
| Cloud and URL import (`CloudImport.tsx`, `lib/cloud-import.ts`, three OAuth env vars) | Keys, OAuth setup and a first-run decision for a loop that only needed drag-in. The app now talks to nothing |
| The dashboard furniture (queue-status card, storage card, "Add media" wrapper, Home/Open studio buttons, Reset queue) | Nothing to configure, so nothing to lay out |

Added: one batch bar that only appears once there is work — "n of m files · size ready", an overall
progress bar and the active job's stage. The start control stayed with the dropzone and engine
picker, which is where the decision is made and where it is reachable *before* anything is queued.

`processMedia()`/`queueMedia()` dropped their `outputFormat` option, `getJobs()` gained `warning`,
and `mcp.json` now documents the derived output and the removed hooks.

### A regression the tests caught

Moving the process button into the conditional batch bar removed
`button[data-mcp-action="process-queue"]` from the page until files were queued — breaking the
documented agent hook and leaving a first-time visitor with nothing to press. The e2e run failed on
it (`{"queue":false}`), and the button moved back next to the dropzone. The suite now also asserts
that no output-format, URL-import or cloud control exists, and that the page renders styled with a
usable drop target and no horizontal overflow, so a blank page fails instead of passing quietly.

### Verification

`bun tsc -b --noEmit` clean; `bunx vite build` shrinks the bundle to 497 kB JS / 26.5 kB CSS (from
515 / 33) now that the landing page is gone. Against production:

- main suite **22/22** headed, with `crossOriginIsolated === true`, dropzone 976 × 344 px, 36 px
  heading, no horizontal overflow, no console errors;
- the same three jobs: WAV `384 044 B · 48 000 Hz · mono · 16-bit`, WebM → WebM, MP4 → MP4, zip
  `6 300 695 B`, worklet preview ready with the meter at 49%;
- bulk suite **16/16**, 24/24 jobs, "23 wav + 1 video" — i.e. in one mixed drop every file came back
  as its own kind without any format being chosen.

### Still not verified

- A/B preview on a physical iOS device.
- A batch of large media (the ~1 GB OPFS quota is the real bound, not file count).
- A genuinely huge batch (500+ files, or multi-GB video) — the suite's ceiling here was 24 small
  jobs, which is bounded by this sandbox rather than by the app.

---

## Session 5 — 2026-09-19

### Goal

The studio still rendered everything at once. Make it a wizard, then make the audio cleaning and the
format support actually good rather than nominal.

### The wizard

The single page became `add` → `engine` → `run`, with only the current step mounted:
`Stepper.tsx`, `AddStep.tsx`, `EngineStep.tsx`, `RunStep.tsx`, composed by `App.tsx`. The step is
store state, not component state, because the queue has to be able to move it:

| Event | Where it lands |
| --- | --- |
| A file is queued (drop, API, `?autostart`) | `engine`, or `run` if a batch is already draining |
| The batch starts | `run` |
| "Add more files" | `add` |
| "Start over" | `add`, after purging the queue and its OPFS results |

The engine choice also stopped being a snapshotted dropdown value: `setModel()` now re-models every
job still waiting, so picking an engine at step 2 applies to the whole queue instead of only to
whatever gets dropped next.

### Real RNNoise, in both pipelines

`rnnoise` was an adaptive gate/expander wearing the name — the one thing in the repo that was not
what it said it was. It is now Shiguredo's WebAssembly build via
`@sapphi-red/web-noise-suppressor`, driven two ways with **the same processor and the same wasm
binary**:

- **Batch:** `OfflineAudioContext(1, frames, 48000)` → RNNoise worklet → destination, rendered by
  `startRendering()`. The audio rendering thread is the cheapest correct place to run a 48 kHz framed
  recurrent network, and it does not block the UI.
- **Preview:** the identical node, live in the A/B graph.

`FrameGate` and the second `createKernel` profile are deleted. `createKernel('rnnoise')` now throws,
because reaching it means something asked the wrong layer to render the model.

Two things this forced:

1. **A per-model inference rate** (`MODEL_SPECS[].inferenceRate`). RNNoise refuses anything but
   48 kHz, while the Web Audio chain is deliberately 16 kHz — its band limit is part of the noise
   reduction. `prepareAudio()` decodes, resamples to that rate, and delivery stays 48 kHz.
2. **A new preview graph.** The worklet's `bypass` flag only worked because it held both profiles.
   With a second engine in the wet path, bypass became a routing decision:

   ```
                    ┌─ dry ─────────────────────┐
     <audio> ───────┤                            │
                   ├─ dsp worklet ─ dsp gain ───┼──► analyser ─► out
                   └─ rnnoise ─── rnnoise gain ┘
   ```

   A/B now ramps gains over 20 ms. Nothing is reconnected, so it is still click-free, and the dry
   branch is a true bypass rather than a flag inside the processor. The preview also asks for
   `AudioContext({ sampleRate: 48000 })`, because RNNoise needs it and the comparison happens against
   a 48 kHz delivery; a browser that refuses gets an amber note instead of a broken panel.

### Formats: decode without ffmpeg

`src/lib/decode.ts` decodes WAV, MP3 and FLAC in JavaScript (`mpg123-decoder`,
`@wasm-audio-decoders/flac`, both behind dynamic `import()`), so an audio job never downloads the
32 MB core and `App.tsx` only preloads it for work that needs it. Everything else — M4A/AAC,
Ogg/Vorbis, every video container — still goes through ffmpeg, and the pipeline falls back to ffmpeg
if a JavaScript decoder recognises a container but cannot read it. `job.decoder` records which path
ran, which is what makes the claim testable rather than aspirational.

Ogg/Opus was wired up and then removed again: `ogg-opus-decoder` pulls in a **4 MB** ML enhancement
model, it cannot read Ogg/Vorbis (which is what `.ogg` usually is), and ffmpeg already handles Opus.
A 4 MB dependency for a format nothing in the product needed was not worth defending.

### Verification

Against the production bundle, served exactly as Pages serves it:

- main suite **33/33**, zero console errors, `crossOriginIsolated === true`. Six jobs, all through
  RNNoise: `wav reader` / `mp3` / `flac` decoded natively, `ffmpeg` for Ogg/Vorbis and the videos;
  WAV `384 044 B · 48 000 Hz · mono`, MP3 `306 826 B`, FLAC (122 s) `11 716 276 B`, WebM → WebM,
  MP4 → MP4, zip `18.7 MB`; the live RNNoise audition ran with no caveat and the meter moved.
- bulk suite **17/17**, 24/24 jobs, heap +0.4 MB, "23 wav + 1 video".
- bulk suite with `BULK_MODEL=rnnoise` **17/17**: 24 jobs each allocating a worklet node and an
  `OfflineAudioContext`, heap +0.4 MB, no crashes — the leak test that mattered for a wasm engine.
- No `ffmpeg-core` request appears in the server log for an audio-only run.

### A test-side lesson, again

Two failures in this session were the harness, not the app: reading the step-1 file list while the
wizard had already advanced to step 2, and clicking a step-1 button from step 2. Both are the same
mistake — assuming a control exists because it exists somewhere in the flow. The suites now navigate
by `data-wizard-step` and assert that step one is the *only* step rendered, so a regression that puts
the whole UI back on one screen fails loudly.

---

## Session 6 — the preview had to go, and the reader got a real library

### The preview could not be trusted, so it was cut

The live `AudioWorklet` audition ran the `webaudio` chain at **48 kHz on the device context**, while
the batch render of the same engine runs at **16 kHz** — the band limit is part of what removes
wideband hiss. So the panel demonstrated a brighter, cleaner signal than the WAV it was describing,
and the worklet was a hand-maintained second copy of `src/lib/dsp.ts` that had to be kept in step by
hand. A preview that disagrees with the output is worse than no preview.

The first fix attempt was to render the real thing: an excerpt through `prepareAudio` → engine →
48 kHz delivery, encoded to the same 16-bit WAV the job writes, played A/B through two
sample-aligned `<audio>` elements crossfaded by a gain ramp. That path was built, and then removed
on the user's call — the product does not need a preview at all when processing a file is the test
and demo files can come later. So the panel, the session, the worklet module, the queue-row button
and `createRnnoisePreviewNode()` are gone, and `src/lib/preview.ts` with them. RNNoise and `webaudio`
each have exactly one implementation now, and the suite fails if the preview hooks or the worklet
chunk ever come back.

### `mediabunny` replaced the single-format decoders

The session-5 decoders were one WASM binary per format: `mpg123-decoder` for MP3 and
`@wasm-audio-decoders/flac` for FLAC, with M4A/AAC and Ogg/Vorbis still paying for the 32 MB core.
`mediabunny` demuxes MP4/MOV/MKV/WebM/WAV/MP3/Ogg/FLAC/ADTS/MPEG-TS and decodes through the
browser's own WebCodecs decoders, so one library covers more formats than the two binaries did —
including the two that previously required ffmpeg. Both old decoders were deleted rather than kept
alongside it, and `job.decoder` now reports `wav reader`, `mediabunny` or `ffmpeg` honestly.

Verification was the point, not the API: each format was processed in a **fresh browser context**
with a request log watching for `ffmpeg-core`. M4A/AAC, MP3 and Ogg/Vorbis all completed with
**0 core requests**; AVI (which mediabunny cannot open) fetched the core and still came back in an
AVI container; an MP4 had its audio read by mediabunny and then was muxed by ffmpeg.

The remaining research — replacing the muxer too — is written up in `todo.md` §3 rather than
half-built: `@mediabunny/aac-encoder` (libavcodec WASM, no dependencies) plus WebCodecs Opus would
cover the containers, but AVI/WMV/FLV would still need ffmpeg, and a second mux implementation would
only be exercised on whichever path the browser takes.

### Container coverage, and failures that read like sentences

Unmapped video inputs (`wmv`, `flv`, `ogv`, `ts`, `3gp`) used to be routed to MP4, which rejects
VC-1, FLV1, Theora, MPEG-2 and H.263 — so those files lost their picture and fell back to a WAV.
They now route to Matroska, the one common container that accepts all of them, with the video still
copied rather than re-encoded. The accept list and `SUPPORTED_SPECS` grew to match (AAC, OPUS, M4V,
OGA).

A video with **no audio track** used to fail with `ffmpeg exited with code 1`, which tells a user
nothing. `explainFailure()` now names that case ("This file has no audio track to clean up.") and
otherwise appends the last meaningful line of ffmpeg's own output.

### The product is called Hushwing

App copy, `index.html`, the diagnostic log header, the footer and every document now say
**Hushwing**. The package id, the MCP server id and the repository stay `hushwing-audio`; the header
mark is a placeholder for the branded wordmark that is coming.

### Verification

- main suite **30/30** against the built bundle (served with isolation headers, not the dev server),
  zero console errors: 8 jobs through RNNoise, decoder labels `wav reader` / `mediabunny` ×6 /
  `ffmpeg` ×1, WAV 384 044 B · 48 kHz mono, MP3 311 006 B, FLAC 11 721 026 B, M4A/AAC 11 725 192 B,
  Ogg 587 556 B, AVI `RIFF`+`AVI `, WebM → WebM, MP4 → MP4, zip 36.4 MB, and the fresh-context
  audit reporting **0 core requests** for an audio-only queue.
- bulk suite **17/17**: 28/28 jobs, "27 wav + 1 video·audio", concurrency 1, no stranding, heap
  +0.4 MB across the batch.
- One assertion of mine failed first: I checked the AVI's fourcc at offset 4 (where MP4's `ftyp`
  lives) instead of offset 8, where RIFF puts `AVI `. The file was correct; the test was not.

### Added to the backlog at the user's request

`todo.md` §3 now carries an installable-PWA plan with **Android share-sheet intake**: a manifest plus
`share_target` (`method: POST`, `multipart/form-data`) and a service worker that stashes the posted
file locally and hands the studio a queued job, plus `file_handlers`/`launchQueue` for "Open with".
Chrome on Android is the only browser that delivers files to a share target, it requires an
installed PWA, and iOS has no share target at all — so the plan says that instead of promising it
everywhere.
