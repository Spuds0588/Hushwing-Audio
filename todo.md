# Hushwing Audio — TODO / Work Log

Last updated: 2026-09-19 (session 2)
Status: **v1 is complete, compiling and running.** Landing page + studio render, the queue
processes local audio and video end to end, and the static build is GitHub Pages ready.

---

## 0. Where things stand

- App moved from `Hushwing-Audio/` to the repository root so `vite build` emits `dist/` where
  the Freebuff hosting panel and the Pages workflow can find it.
- `bun tsc -b --noEmit` is clean; `bunx vite build` emits `dist/` (index.html, assets,
  `mcp.json`, `worklets/`, `coi-serviceworker.js`) with relative paths.
- Preview commands saved: install `bun install`, dev `bun run dev` (5173), build `bunx vite build`.
- Freebuff preview reaches ready; every module in the graph transforms without error.
- **Verified end to end in a real browser (session 2):** `bun run test:e2e` drives headless
  Chromium through the whole product and passes 21/21 — WAV, MP4 and WebM jobs all complete and
  the delivered bytes are inspected, the A/B worklet preview plays and switches, the `.zip`
  export works, and the URL params / `window.HushwingAPI` behave.

## 1. Done in v1

- [x] Landing page (hero, features, pipeline steps, engine cards, privacy table, CTAs) and the
      studio dashboard, themed with the mint-on-charcoal `@theme` tokens.
- [x] Drag & drop queue with per-job progress, stage labels, retry, remove, clear-finished.
- [x] `ffmpeg.wasm` (single-threaded core, self-hosted in production with a CDN fallback and a
      `VITE_FFMPEG_CORE_BASE` override) extraction to 16 kHz mono WAV and video remux with
      `-c:v copy`.
- [x] Pure-JS DSP kernels (`lib/dsp.ts`): high-pass, adaptive noise-floor gate, soft-knee
      compressor, soft limiter, windowed-sinc resampler.
- [x] Pipeline A: `workers/enhance-worker.ts` renders batches off the main thread with
      transferable buffers; `createEngine` falls back to the main thread if workers are blocked.
- [x] Pipeline B: `public/worklets/hushwing-preview.js` + `lib/preview.ts` drive a real-time A/B
      player with a waveform canvas, level meter and live model switching.
- [x] OPFS staging, streamed WAV output via `openOPFSWriter`, stage cleanup after each job.
- [x] JSZip `.zip` export of every finished result.
- [x] `window.HushwingAPI`, semantic `data-mcp-*` hooks, `?model=` / `?autostart=` / `?debug=`,
      `#studio` deep link, `public/mcp.json`.
- [x] Google Drive + OneDrive import paths implemented behind `VITE_GOOGLE_CLIENT_ID` +
      `VITE_GOOGLE_API_KEY` and `VITE_ONEDRIVE_CLIENT_ID`; generic CORS URL import always works.
- [x] `coi-serviceworker` vendored into `public/` with a credentialless COEP config, guarded to
      top-level windows and disableable with `?coi=off`.
- [x] GitHub Pages: `base: './'`, relative asset URLs, `public/.nojekyll`,
      `.github/workflows/deploy.yml`, `permissions: pages: write`.
- [x] Browser end-to-end suite (`e2e/hushwing.e2e.mjs`, `bun run test:e2e`) covering audio and
      video processing, the A/B preview, the zip export and the agent surface. It found and
      fixed three real bugs: a UMD/ESM ffmpeg-core mismatch that blocked every job, a mux that
      forced VP8/VP9 into MP4, and job errors that carried no stack.

## 2. Open — needs a key or a browser check

- [ ] **Google Drive / OneDrive**: the code paths are complete but unverified because no OAuth
      keys exist. Set `VITE_GOOGLE_CLIENT_ID` + `VITE_GOOGLE_API_KEY` (Drive Picker API enabled)
      and `VITE_ONEDRIVE_CLIENT_ID` (Azure app with this origin as a redirect URI), then run one
      import of each.
- [ ] **A/B preview on a real device**: headless Chromium is green (worklet ready, meter
      moving, playhead advancing, click-free A/B switch), but iOS Safari's `AudioWorklet`
      behaves differently under interruption and still needs a physical device.
- [ ] **Large-file run**: process a >1 GB video and watch memory. The ffmpeg step is the known
      high-water mark (see limitations).
- [ ] **Cross-origin isolation check** on a real Pages deployment: confirm
      `window.crossOriginIsolated === true` after the service worker installs, and that the
      Google/OneDrive iframes still load under `COEP: credentialless`.

## 3. v2 backlog

- [ ] **RNNoise WASM**: vendor real weights behind the existing `rnnoise` id so the engine
      matches the name (today it is an adaptive gate/expander profile, labelled as such).
- [ ] **Verify the self-hosted core path on a deployed build**: `vite.config.ts` emits
      `dist/ffmpeg-core/*` (32 MB) and `lib/ffmpeg.ts` probes for it before falling back to
      unpkg. Confirm the probe hits the local copy on Pages (check the network tab) and that the
      first-load download is acceptable.
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
4. **Honest model naming.** `rnnoise` is an adapted DSP profile and the UI says so. Promising a
   neural model we do not ship would be worse than a slower roadmap.
5. **Engine contract returns samples, not blobs.** Blob creation moved into the pipeline so
   results can stream to OPFS instead of being assembled in memory.
