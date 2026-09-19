# Hushwing Audio — TODO / Work Log

Last updated: 2026-09-19 (session 5)
Status: **v1 is complete, live, and studio-only.** The studio is a three-step wizard (add files →
pick an engine → watch the queue), RNNoise is real WebAssembly, audio formats are decoded without
ffmpeg, and the static build is deployed to GitHub Pages.

---

## 0. Where things stand

- App moved from `Hushwing-Audio/` to the repository root so `vite build` emits `dist/` where
  the Freebuff hosting panel and the Pages workflow can find it.
- `bun tsc -b --noEmit` is clean; `bunx vite build` emits `dist/` (index.html, assets,
  `mcp.json`, `worklets/`, `coi-serviceworker.js`) with relative paths.
- Preview commands saved: install `bun install`, dev `bun run dev` (5173), build `bunx vite build`.
- Freebuff preview reaches ready; every module in the graph transforms without error.
- **Verified end to end in a real browser (session 5):** `bun run test:e2e` walks the wizard in
  Chromium and passes 33/33 — WAV, MP3, FLAC, Ogg/Vorbis, MP4 and WebM jobs all complete through the
  RNNoise engine, every delivered result's bytes are inspected, each job reports which decoder read
  it, the live A/B audition plays and switches, the `.zip` export works, and the URL params /
  `window.HushwingAPI` behave. Run headed (`HEADED=1` under `xvfb-run`) it also produces a screenshot.
- **Live in production:** <https://spuds0588.github.io/Hushwing-Audio/> serves the built bundle and
  passes the same suite 21/21, with `crossOriginIsolated === true`, the ffmpeg core loaded from its
  own origin and no third-party requests.

## 1. Done in v1

- [x] One page, and it is the studio, themed with the mint-on-charcoal `@theme` tokens: dropzone
      → engine picker → batch progress → job list. The landing page, its nav and the dashboard split
      were removed in session 4 so there is nothing to get past.
- [x] Drag & drop queue with per-job progress, stage labels, retry, remove, clear-finished.
- [x] `ffmpeg.wasm` (single-threaded core, self-hosted in production with a CDN fallback and a
      `VITE_FFMPEG_CORE_BASE` override) extraction to mono PCM at the engine's rate and video remux
      with `-c:v copy`.
- [x] Pure-JS DSP kernels (`lib/dsp.ts`): high-pass, soft-knee compressor, soft limiter,
      windowed-sinc resampler.
- [x] Pipeline A: `workers/enhance-worker.ts` renders batches off the main thread with
      transferable buffers; `createEngine` falls back to the main thread if workers are blocked.
- [x] Pipeline B: `public/worklets/hushwing-preview.js` + `lib/preview.ts` drive a real-time A/B
      player with a waveform canvas, level meter and live model switching.
- [x] OPFS staging, streamed WAV output via `openOPFSWriter`, stage cleanup after each job.
- [x] JSZip `.zip` export of every finished result.
- [x] `window.HushwingAPI`, semantic `data-mcp-*` hooks, `?model=` / `?autostart=` / `?debug=`,
      `#studio` deep link, `public/mcp.json`.
- [x] Output follows the source with no control to get it wrong: a video keeps its picture with
      the enhanced track muxed back in, audio comes back as a 48 kHz WAV. Drive/OneDrive pickers and
      import-from-URL were implemented and then **removed in session 4** — they added keys, OAuth
      setup and a first-run decision to a loop that only needed drag-in, so the app now talks to
      nothing at all.
- [x] `coi-serviceworker` vendored into `public/` with a credentialless COEP config, guarded to
      top-level windows and disableable with `?coi=off`.
- [x] GitHub Pages: `base: './'`, relative asset URLs, `public/.nojekyll`,
      `.github/workflows/deploy.yml`, `permissions: pages: write`.
- [x] Browser end-to-end suite (`e2e/hushwing.e2e.mjs`, `bun run test:e2e`) covering audio and
      video processing, the A/B preview, the zip export and the agent surface. It found and
      fixed three real bugs: a UMD/ESM ffmpeg-core mismatch that blocked every job, a mux that
      forced VP8/VP9 into MP4, and job errors that carried no stack.

## 1a. Studio-first restructure (session 4)

- [x] The landing page, the landing↔studio navigation and the dashboard split are gone: the studio
      is the page. `Landing.tsx` deleted; `Header` is brand + status + log toggle.
- [x] Output selection removed. The format is derived at enqueue from the source kind, so a video
      cannot come back as audio-only and vice versa; `processMedia()`/`queueMedia()` lost their
      `outputFormat` option and `mcp.json` documents the derived behaviour.
- [x] Cloud/URL import removed (`CloudImport.tsx`, `lib/cloud-import.ts`, the OAuth env vars).
- [x] Chrome reduced to a batch bar: "n of m files", overall progress, active stage. The start
      control lives with the dropzone and engine picker, so it exists before anything is queued.
- [x] Guarded by tests: the e2e suite fails if an output-format, URL-import or cloud control ever
      reappears, and checks the page renders styled with a usable drop target and no horizontal
      overflow (a blank or unstyled page fails the run).

## 1a-2. Wizard, real RNNoise, more formats (session 5)

- [x] **The studio is a wizard.** `add` → `engine` → `run`, one step on screen at a time
      (`Stepper.tsx`, `AddStep.tsx`, `EngineStep.tsx`, `RunStep.tsx`). The step lives in the store,
      so queueing a file ends step one, starting a batch jumps to step three, and a file added while
      a batch is draining lands back on the running batch instead of on a step that cannot act on it.
- [x] **`rnnoise` is real RNNoise** (`@sapphi-red/web-noise-suppressor` → Shiguredo WASM, 48 kHz),
      in the batch render (offline audio graph) *and* the live A/B audition (the same processor and
      the same wasm binary). The old gate/expander stand-in is deleted, not kept alongside it.
- [x] **Audio formats are decoded in JavaScript** (`lib/decode.ts`: WAV reader, `mpg123-decoder`,
      `@wasm-audio-decoders/flac`, all lazy), so a queue of audio makes zero `ffmpeg-core` requests.
      M4A/AAC, Ogg/Vorbis and every video container still go through ffmpeg, and `job.decoder` says
      which path ran.
- [x] **Per-model inference rate** (`MODEL_SPECS[].inferenceRate`): 16 kHz for the Web Audio chain
      (the band limit is part of the noise reduction), RNNoise's native 48 kHz; delivery is 48 kHz.
- [x] **A/B switching is a gain ramp**, not a reconnection: one graph with a dry branch and a wet
      branch, crossfaded over 20 ms, and the preview requests a 48 kHz `AudioContext` so RNNoise can
      join it.
- [x] Verified: main suite **33/33** and bulk **17/17** on the production build, plus a bulk run with
      `BULK_MODEL=rnnoise` (24/24 jobs, heap +0.4 MB) to prove the per-job worklet
      node + `OfflineAudioContext` do not leak.

## 1b. Bulk / queue workload — checked in session 3

- [x] Bulk suite (`bun run test:bulk`, `e2e/hushwing.bulk.mjs`): 20-file drop + 1 video + 3 mid-run
      arrivals, verifying concurrency stays 1, progress never regresses, OPFS hygiene, no stranding,
      zip parity and bounded heap. 17/17 against production.
- [x] Fixed: files added while a batch drained were stranded at `queued` forever.
- [x] Fixed: a global `video` output format made every audio file run a mux that cannot succeed —
      ~40 ffmpeg invocations instead of ~20 for a 21-file drop, which crashed the renderer.
- [x] Larger batch verified: `BULK_COUNT=50` → 53/53 jobs (50 dropped + 3 mid-run), heap peak
      47 MB with +0.6 MB growth across the batch, 9.4 MB of a ~1 GB quota.
- [ ] **Still untested: a batch of large media.** Everything above used 1–2 s clips. The real
      constraint is result size against the ~1 GB OPFS quota (results stay until downloaded or
      cleared), so a folder of long videos — not 500 small files — is the case that needs a
      machine with more memory and disk than this sandbox.

## 2. Open — needs a key, a click, or a browser check

- [x] **Flip the Pages source to GitHub Actions** (done by hand; the repository-scoped
      credential cannot change repository settings — `PUT /repos/.../pages` returns 403). The repo
      had been `build_type: legacy` (`main:/`), so the Jekyll pipeline republished the raw
      repository root after every push and overrode the workflow's artifact. Now `build_type:
      workflow`. Note that `gh workflow run` is *also* 403 for this credential, so a deploy is
      triggered by pushing to `main` rather than by dispatching the workflow.

- [ ] **A/B preview on a real device**: headless Chromium is green (worklet ready, meter
      moving, playhead advancing, click-free A/B switch), but iOS Safari's `AudioWorklet`
      behaves differently under interruption and still needs a physical device.
- [ ] **Large-file run**: process a >1 GB video and watch memory. The ffmpeg step is the known
      high-water mark (see limitations).
- [x] **Cross-origin isolation on the real Pages deployment**: `window.crossOriginIsolated`
      reaches `true` once the service worker takes control (verified repeatedly; one run reported
      `false` before the worker had reloaded the page, so give it a moment before concluding).

## 3. v2 backlog

- [ ] **Decode more formats natively.** Ogg/Vorbis and M4A/AAC still need the 32 MB core. There is
      no maintained Vorbis decoder in the `@wasm-audio-decoders` family (there is no
      `ogg-vorbis-decoder` on npm), and `ogg-opus-decoder` drags in a 4 MB ML enhancement model for a
      format we can already handle with ffmpeg — so both were rejected on purpose rather than by
      omission.
- [ ] **Trim the RNNoise frame latency.** Its delay line costs a fixed ~11 ms; compensating would
      mean dropping ~512 samples from the head and padding the tail, which needs a measurement
      rather than an argument.
- [ ] **A 48 kHz `webaudio` profile.** The JS chain runs at 16 kHz (band-limited, cheap) while the
      preview runs at 48 kHz, so the audition is slightly brighter than the delivered WAV.
- [ ] **Verify the self-hosted core path on a deployed build**: `vite.config.ts` emits
      `dist/ffmpeg-core/*` (32 MB) and `lib/ffmpeg.ts` probes for it before falling back to
      unpkg. Confirmed for the asset paths in session 3; worth re-checking after any bundler change.
- [ ] **DeepFilterNet 3**: implement `ModelId: 'deepfilternet'` and enable the option.
- [ ] **OPFS → ffmpeg**: mount `WORKERFS`/`PROXYFS` (or move to the multithreaded core with
      `SharedArrayBuffer`, now available thanks to COI) so the input never touches RAM.
- [ ] **Persist the queue** across reloads (OPFS metadata + re-hydration).
- [ ] **Per-job parameter overrides** (gate threshold, compressor ratio) instead of fixed
      profiles, wired into both `lib/dsp.ts` and the worklet.
- [ ] **PWA**: manifest + service worker caching of the ffmpeg core for genuine offline use.
- [ ] **Code-split** the 512 kB main bundle (framer-motion is most of it).
- [ ] **Unit tests**: the browser suite covers integration, but `lib/dsp.ts` (gate behaviour,
      resample frame counts) and `lib/filekit.ts` (`parseWav` round trip) are pure and deserve
      fast unit coverage of their own.

## 4. Decisions already made (do not relitigate without reason)

1. **Subdirectory → root.** Option A from the previous list. Both hosting panels and Pages are
   simpler with `dist/` at the root.
2. **Never commit the ffmpeg core, but do self-host it.** Committing ~32 MB of WASM to git was
   rejected; the build copies it out of `node_modules` into `dist/ffmpeg-core` instead, and the
   runtime probes that path before falling back to unpkg.
3. **COI shipped, but inert when embedded.** The PRD wants `coi-serviceworker`; making it
   top-level-only avoids reload loops in sandboxed previews.
4. **Honest model naming.** The engine called `rnnoise` is RNNoise, and when it was not, the UI said
   so. Promising a neural model we do not ship would be worse than a slower roadmap.
5. **One step at a time.** The wizard exists because a wall of controls is not a flow. If a new
   feature needs a decision, it needs a place in a step — not another panel on the same screen.
6. **Engine contract returns samples, not blobs.** Blob creation moved into the pipeline so
   results can stream to OPFS instead of being assembled in memory.
7. **JavaScript decoders before ffmpeg.** The 32 MB core is a tool, not a requirement — WAV, MP3 and
   FLAC are decoded in-process and lazily, and everything else falls through to ffmpeg.
