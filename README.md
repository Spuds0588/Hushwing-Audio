# Hushwing Audio

A private, zero-cost alternative to cloud-based voice enhancers that runs entirely inside the
user's browser via WebAssembly (WASM). Drop in audio or video, pick an engine, and export the
cleaned track — nothing is uploaded, and there is no account, quota or telemetry.

Product requirements live in [`PRD-Hushwing.md`](./PRD-Hushwing.md), the agent/contributor
contract in [`AGENTS.md`](./AGENTS.md), the build log in [`history.md`](./history.md) and the
live task list in [`todo.md`](./todo.md).

## What v1 ships

| Area | Status |
| --- | --- |
| Landing page + studio UI (Tailwind v4, Framer Motion) | ✅ |
| Drag & drop, queue with per-job progress, stage labels, retry | ✅ |
| Video → 16 kHz mono WAV extraction, enhance, mux back to MP4 | ✅ `ffmpeg.wasm` |
| Native Web Audio engine (high-pass → compressor → soft limiter) | ✅ |
| Adaptive noise-floor gate engine (id `rnnoise`) | ✅ |
| Batch render in a Web Worker (Pipeline A) | ✅ |
| Real-time A/B preview via AudioWorklet (Pipeline B) | ✅ |
| OPFS staging + streamed results, `.zip` batch export | ✅ |
| `window.HushwingAPI`, semantic DOM hooks, URL params, `mcp.json` | ✅ |
| Google Drive / OneDrive import | ⚙️ Needs OAuth keys (see below) |
| DeepFilterNet 3 | ⏳ Planned — the option is disabled, not fake |

## Requirements

- [Bun](https://bun.sh) (or any package manager that can run the Vite scripts)
- A Chromium/Firefox/Safari build with `AudioWorklet`, Web Workers and OPFS

```bash
bun install
bun run dev        # http://localhost:5173
bun run typecheck  # tsc -b --noEmit
bun run build      # tsc -b && vite build → dist/
```

### End-to-end verification

```bash
bunx playwright install chromium                 # once
PREVIEW_URL=https://<preview-host> bun run test:e2e
```

`e2e/hushwing.e2e.mjs` drives real headless Chromium against the running preview. It queues a
generated WAV, a real H.264/AAC MP4 and a VP8/Opus WebM recorded in-page, then checks the delivered
bytes of every result (RIFF/fmt header, Matroska magic, MP4 `ftyp` brand), the `.zip` export, the
AudioWorklet A/B preview (level meter, playhead, switching, teardown), the URL parameters and
`window.HushwingAPI`. It prints the app's own diagnostics whenever a job fails. A green run is
required before shipping a change to the pipeline, an engine or the preview.

## Deploying to GitHub Pages

The build is static and uses `base: './'`, so one build works at a domain root *and* at
`https://<user>.github.io/<repo>/`.

```bash
bunx vite build     # emits dist/ (including dist/ffmpeg-core) — must exit, never start a server
```

`.github/workflows/deploy.yml` does this on every push to `main` and publishes `dist/` with
`actions/deploy-pages`. Enable **Settings → Pages → Source: GitHub Actions** once, then push.
`public/.nojekyll` keeps the `assets/` folder from being filtered by Jekyll.

Static hosting cannot send `COOP`/`COEP` headers, so `public/coi-serviceworker.js` injects
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
(PRD §2.1) to make `SharedArrayBuffer` available. It only registers in a top-level window, so it
stays inert inside embedded previews; append `?coi=off` to disable it entirely.

## Environment variables

Set these in **Settings → Environment** (sandbox) and in the hosting panel (production). All are
optional — without them the app still processes local files.

| Variable | Purpose |
| --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | OAuth client id enabling the Google Drive picker |
| `VITE_GOOGLE_API_KEY` | Drive Picker API key (required next to the client id) |
| `VITE_ONEDRIVE_CLIENT_ID` | Azure app registration (redirect URI: this site's origin) |
| `VITE_FFMPEG_CORE_BASE` | Force a specific `ffmpeg-core.js` / `.wasm` location (overrides the automatic probe) |

The ffmpeg core is **self-hosted in production**: the build copies `node_modules/@ffmpeg/core`
(the ESM build — `@ffmpeg/ffmpeg` loads the core from a module worker, and the UMD bundle has no
default export) into `dist/ffmpeg-core/`, and `src/lib/ffmpeg.ts` probes for those files before
falling back to a CDN. A deployed build therefore fetches nothing but its own origin — no CDN, no
third-party request, and `CORE_VERSION` in `src/lib/ffmpeg.ts` only pins the fallback.

`public/ffmpeg-core/` is an optional local copy of the same two files (convenient offline, and what
the dev preview uses when present). It is **gitignored on purpose** — committing 32 MB of WASM to
git is not worth it, and nothing depends on it being there.

## Architecture

```
index.html ─ coi-serviceworker → cross-origin isolation
  └── src/App.tsx ─ landing page + studio shell
        ├── store/app.ts ......... zustand queue (single source of truth)
        ├── lib/opfs.ts .......... streaming OPFS writer/reader
        ├── lib/ffmpeg.ts ........ extract 16 kHz mono WAV, mux video (worker inside ffmpeg.wasm)
        ├── lib/filekit.ts ....... WAV parse/encode, format tables, blob URLs
        ├── lib/dsp.ts ........... pure-JS kernels: high-pass, gate, compressor, limiter, resample
        ├── workers/enhance-worker.ts  Pipeline A — batch render off the main thread
        ├── public/worklets/hushwing-preview.js  Pipeline B — real-time A/B monitoring
        └── lib/pipeline.ts ...... stage → extract → enhance → resample → stream to OPFS → mux
```

Every engine implements the same contract (`{ process(samples, sampleRate) }`), which is what
lets the identical DSP run in a worker and behind an `AudioWorkletNode`.

### Known v1 limitations

- `@ffmpeg/ffmpeg` 0.12 cannot mount OPFS, so the input passes through the WASM filesystem
  (RAM) during the ffmpeg step. Everything before and after streams through OPFS. The 32 MB core
  makes the deployed `dist/` roughly 33 MB; set `build.assetsInlineLimit` aside and expect the
  first load to be dominated by that download (it is cache-busted by the host, so reloads are
  cheap).
- The `rnnoise` model id is kept for API compatibility, but this build ships an adaptive
  gate/expander DSP profile, not the RNNoise WASM weights. It is labelled honestly in the UI.
- Cloud pickers need the OAuth keys above; the import-to-local constraint from the PRD is
  enforced by design (results are never written back to the cloud).

## Headless / agent surface

```js
await window.HushwingAPI.getModels()            // ['webaudio', 'rnnoise']
await window.HushwingAPI.processMedia({ file, model: 'webaudio', outputFormat: 'wav' })
window.HushwingAPI.getJobs()                    // id, status, progress, stage, resultUrl, error
window.HushwingAPI.downloadDebugLog()
```

Semantic hooks: `input[data-mcp-action="upload"]`,
`select[data-mcp-target="model-selector"]`, `button[data-mcp-action="process-queue"]`,
`a[data-mcp-action="download-result"][data-job-id="<uuid>"]`,
`[data-mcp-target="diagnostics"]`, and job rows carrying `data-job-id` / `data-status`.
URL parameters: `?model=`, `?autostart=true`, `?debug=true`, `?coi=off`. Discovery document:
[`public/mcp.json`](./public/mcp.json), served at `/mcp.json`.

## Licence

See [`LICENSE`](./LICENSE).
