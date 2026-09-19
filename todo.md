# Hushwing — TODO / Work Log

Last updated: 2026-09-19 (session 6)
Status: **v1 is complete, live, and studio-only.** The product is **Hushwing** (the repository is
still `Hushwing-Audio`). The studio is a three-step wizard (add files → pick an engine → watch the
queue), RNNoise is real WebAssembly, every common audio container is decoded natively, video keeps
its video, and the static build is deployed to GitHub Pages.

---

## 0. Where things stand

- App moved from `Hushwing-Audio/` to the repository root so `vite build` emits `dist/` where
  the Freebuff hosting panel and the Pages workflow can find it.
- `bun tsc -b --noEmit` is clean; `bunx vite build` emits `dist/` (index.html, assets,
  `mcp.json`, `worklets/`, `coi-serviceworker.js`) with relative paths.
- Preview commands saved: install `bun install`, dev `bun run dev` (5173), build `bunx vite build`.
- Freebuff preview reaches ready; every module in the graph transforms without error.
- **Verified end to end in a real browser (session 6):** `bun run test:e2e` walks the wizard in
  Chromium and passes 30/30 — WAV, MP3, FLAC, Ogg/Vorbis, M4A/AAC, AVI, MP4 and WebM jobs all
  complete through the RNNoise engine, every delivered result's bytes are inspected, each job reports
  which reader produced its PCM, an audio-only queue is audited in a fresh context for fetching the
  ffmpeg core (zero requests), the `.zip` export works, and the URL params / `window.HushwingAPI`
  behave. Run headed (`HEADED=1` under `xvfb-run`) it also produces a screenshot.
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
      which path ran. *(Superseded in session 6: one `mediabunny` reader replaced the two
      single-format WASM decoders — see 1a-3.)*
- [x] **Per-model inference rate** (`MODEL_SPECS[].inferenceRate`): 16 kHz for the Web Audio chain
      (the band limit is part of the noise reduction), RNNoise's native 48 kHz; delivery is 48 kHz.
- [x] **A/B switching is a gain ramp**, not a reconnection: one graph with a dry branch and a wet
      branch, crossfaded over 20 ms, and the preview requests a 48 kHz `AudioContext` so RNNoise can
      join it. *(Removed in session 6: it could not match the delivered file — see 1a-3.)*
- [x] Verified: main suite **33/33** and bulk **17/17** on the production build, plus a bulk run with
      `BULK_MODEL=rnnoise` (24/24 jobs, heap +0.4 MB) to prove the per-job worklet
      node + `OfflineAudioContext` do not leak.

## 1a-3. Honest preview, native formats, product rename (session 6)

- [x] **The A/B preview is gone, not patched.** The live `AudioWorklet` audition ran at 48 kHz while
      the batch chain ran the Web Audio engine at 16 kHz, so the audition was audibly not the file.
      The panel, the session, the worklet (`public/worklets/hushwing-preview.js`) and the queue-row
      button were deleted, along with `createRnnoisePreviewNode` — RNNoise now has exactly one code
      path. The suite asserts the preview hooks and the worklet chunk stay gone.
- [x] **`mediabunny` is the reader.** `lib/decode.ts` parses WAV itself and hands everything else to
      `mediabunny` (MP4/MOV/MKV/WebM/WAV/MP3/Ogg/FLAC/ADTS/MPEG-TS demux plus WebCodecs decode),
      which covers MP3, FLAC, **M4A/AAC**, **Ogg/Vorbis** and **Opus**, and reads the audio track out
      of a video. AVI/WMV/FLV and anything the browser cannot decode still fall through to ffmpeg.
      `mpg123-decoder` and `@wasm-audio-decoders/flac` were removed rather than kept alongside it.
- [x] **Container coverage widened.** Unmapped video inputs (`.wmv`, `.flv`, `.ogv`, `.ts`, `.3gp`)
      are routed to Matroska instead of an MP4 that would reject their codec, so the picture is kept
      where it used to fall back to audio-only. The accept list and `SUPPORTED_SPECS` were extended
      (AAC, OPUS, M4V, OGA).
- [x] **Failures read like sentences.** A video with no audio track now reports "This file has no
      audio track to clean up." instead of an ffmpeg exit code; other ffmpeg failures carry the
      last meaningful line of ffmpeg's own output.
- [x] **The product is called Hushwing.** App copy, `index.html`, the diagnostic log header, the
      footer and the docs. The package id, the MCP server id and the repository stay
      `hushwing-audio`. The wordmark in the header is a placeholder until the branded logo lands.
- [x] Verified: main suite **30/30** and bulk **17/17** against the built bundle, then the same two
      suites against production (headed Chromium, zero console errors, `crossOriginIsolated === true`,
      24/24 jobs in the bulk run, heap +0.4 MB). Committed as `e764364`, deployed in 34 s.

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

- [ ] **Physical-device run**: everything is verified in Chromium (headless and headed under
      Xvfb). A real Android/iOS pass over a long recording is still worth doing, mainly to watch
      memory and the OPFS quota rather than correctness.
- [ ] **Large-file run**: process a >1 GB video and watch memory. The ffmpeg step is the known
      high-water mark (see limitations).
- [x] **Cross-origin isolation on the real Pages deployment**: `window.crossOriginIsolated`
      reaches `true` once the service worker takes control (verified repeatedly; one run reported
      `false` before the worker had reloaded the page, so give it a moment before concluding).

## 3. v2 backlog

- [ ] **Install Hushwing as an app (PWA).** A web app manifest plus a service worker so the studio
      installs to the home screen and opens offline. Two parts, and the second is the one that
      matters:
  - **Manifest + install**: `name`/`short_name` (Hushwing), the themed icons, `display:
    standalone`, `background_color`/`theme_color` from the `@theme` tokens, and `start_url` pointing
    at the studio. The service worker should precache the shell *and* the 32 MB `ffmpeg-core` on
    first idle so a video job works with no network — the core is the only reason the app is not
    already offline-capable, and `coi-serviceworker` is a second worker that has to coexist with it.
  - **Android share sheet (Web Share Target).** `share_target` in the manifest with `method: POST`,
    `enctype: multipart/form-data`, `action: /share` and named file fields. Chrome on Android is the
    only browser that delivers files this way (Level 2); desktop Chrome still sends text/URLs only,
    and iOS Safari has no share target at all. It requires an installed PWA. The service worker's
    `fetch` handler has to stash the posted file (OPFS or `Cache`), then redirect to the studio with
    the job pre-queued — the file never goes to a server, which is the whole point.
  - **"Open with" file handling** is the sibling route: `file_handlers` in the manifest plus
    `launchQueue.setConsumer()` in the app, so an audio or video file opened from a file manager
    (or another app's "Open with") lands in the queue. It also only fires for an installed PWA.
- [ ] **Drop ffmpeg for muxing too (researched, session 6).** Reading is already handled by
      `mediabunny`; writing is the remaining 32 MB. The pieces exist: `@mediabunny/aac-encoder`
      (libavcodec WASM, no dependencies, ~4.7 MB unpacked) encodes AAC for MP4/MOV/M4A, and Opus for
      WebM/MKV can come from the browser's own `AudioEncoder`. It would need a hand-built `Output`
      (copy the video packets through, feed our enhanced PCM into an `AudioSampleSource`) rather than
      the high-level `Conversion` API, which would re-encode the *original* audio instead of ours.
      Two things hold it back: AVI (and WMV/FLV) would keep needing ffmpeg anyway, and a second mux
      implementation would mean the suite only exercises whichever path Chromium takes. Worth doing
      when video jobs need to start without a 32 MB download.
- [ ] **Trim the RNNoise frame latency.** Its delay line costs a fixed ~11 ms; compensating would
      mean dropping ~512 samples from the head and padding the tail, which needs a measurement
      rather than an argument.
- [ ] **An engine that honours a chosen sample rate.** `webaudio` renders at 16 kHz by design
      (the band limit is part of the noise reduction), and delivery is always 48 kHz, so nothing in
      the UI needs a rate. Only worth revisiting if a user asks for full-band output.
- [ ] **Verify the self-hosted core path on a deployed build**: `vite.config.ts` emits
      `dist/ffmpeg-core/*` (32 MB) and `lib/ffmpeg.ts` probes for it before falling back to
      unpkg. Confirmed for the asset paths in session 3; worth re-checking after any bundler change.
- [ ] **DeepFilterNet 3**: implement `ModelId: 'deepfilternet'` and enable the option.
- [ ] **OPFS → ffmpeg**: mount `WORKERFS`/`PROXYFS` (or move to the multithreaded core with
      `SharedArrayBuffer`, now available thanks to COI) so the input never touches RAM.
- [ ] **Persist the queue** across reloads (OPFS metadata + re-hydration).
- [ ] **Per-job parameter overrides** (gate threshold, compressor ratio) instead of fixed
      profiles, wired into `lib/dsp.ts` and the worker.
- [ ] **Code-split** the 500 kB main bundle (framer-motion is most of it; the mediabunny chunk is
      already lazy at 329 kB).
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
7. **Native decode before ffmpeg.** The 32 MB core is a tool, not a requirement — WAV is parsed in
   JS, `mediabunny` reads every other common container with the browser's own codecs, and only what
   neither can open (AVI and friends) reaches ffmpeg. Video muxing still needs it.
8. **No preview that disagrees with the output.** The live `AudioWorklet` audition ran at 48 kHz on
   the device context while the batch chain ran at 16 kHz, so it sounded different from the file it
   was previewing. It was cut rather than patched: the product is drop → engine → queue, and a
   result is judged by processing the file. A future preview has to be the rendered output, not an
   approximation of it.
