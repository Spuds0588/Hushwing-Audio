# Hushwing Audio

### ▶ **[Try it now — spuds0588.github.io/Hushwing-Audio](https://spuds0588.github.io/Hushwing-Audio/)**

No install, no account, no upload. Open the link, drop in a file, export the cleaned track.

A private, zero-cost alternative to cloud-based voice enhancers. Everything runs inside the
browser via `ffmpeg.wasm` and the Web Audio API: media never leaves the machine, there is no
backend, no quota and no telemetry.

| | |
| --- | --- |
| **Live tool** | <https://spuds0588.github.io/Hushwing-Audio/> |
| **How it works** | [`how-it-works.md`](./how-it-works.md) — the pipeline, the DSP, and why it is built this way |
| **Product requirements** | [`PRD-Hushwing.md`](./PRD-Hushwing.md) |
| **Agent & contributor contract** | [`AGENTS.md`](./AGENTS.md) — read this before changing code |
| **Build log / task list** | [`history.md`](./history.md) · [`todo.md`](./todo.md) |

## Status

| Area | State |
| --- | --- |
| One page, and it is the studio — drop, engine, progress (Tailwind v4, Framer Motion) | ✅ |
| Drag & drop, queue with per-job progress, stage labels, retry | ✅ |
| Video → 16 kHz mono WAV, enhance, mux back into the source container | ✅ `ffmpeg.wasm` |
| `webaudio` engine — high-pass → soft-knee compressor → soft limiter | ✅ |
| `rnnoise` engine — adaptive noise-floor gate (id kept, weights are a follow-up) | ✅ |
| Pipeline A: batch render in a Web Worker | ✅ |
| Pipeline B: real-time A/B preview through an `AudioWorklet` | ✅ |
| OPFS staging + streamed results, `.zip` batch export | ✅ |
| `window.HushwingAPI`, semantic DOM hooks, URL params, `mcp.json` | ✅ |
| No format control to get wrong — video stays video, audio becomes 48 kHz WAV | ✅ |
| DeepFilterNet 3 | ⏳ planned, the option is disabled rather than faked |

Verified end to end in Chromium against both the dev preview and the live Pages deployment — see
[Testing](#testing).

---

# For developers

## Quick start

```bash
bun install
bun run dev          # http://localhost:5173 — the studio is the whole app
```

The first load pulls a ~32 MB `ffmpeg.wasm` core. It is only fetched when there is actually work
to do (see `preloadFFmpeg`), and the browser caches it afterwards.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server. `PORT` overrides the port; binds `0.0.0.0`. HMR is deliberately **off** |
| `bun run build` | `tsc -b && vite build` → `dist/`. Must exit; it never starts a server |
| `bun run build:pages` | `vite build` alone — what CI runs, so type errors fail the build step, not the deploy |
| `bun run typecheck` | `tsc -b --noEmit`. Must be clean |
| `bun run lint` | `oxlint` |
| `bun run preview` | Serve the built `dist/` locally |
| `bun run test:e2e` | The browser suite — one audio job, two video jobs, the preview (below) |
| `bun run test:bulk` | The bulk/queue suite — 20+ files in one drop, plus mid-run arrivals |

## Project layout

```
index.html ─ coi-serviceworker → cross-origin isolation
  └── src/App.tsx ──────── the studio: dropzone, batch status, queue, API install
        ├── store/app.ts ......... zustand queue — the single source of truth
        ├── lib/dsp.ts ........... DSP kernels: high-pass, gate, compressor, limiter, resample
        ├── lib/engine.ts ........ HushwingEngine contract; worker engine + main-thread fallback
        ├── lib/ffmpeg.ts ........ core loading/probing, 16 kHz extraction, video mux
        ├── lib/filekit.ts ....... WAV parse/encode, format tables, blob URLs
        ├── lib/opfs.ts .......... streaming OPFS writer/reader
        ├── lib/pipeline.ts ...... stage → extract → enhance → resample → stream → mux
        ├── lib/preview.ts ....... Pipeline B session (peaks, worklet graph, A/B, meter)
        ├── lib/hushwing-api.ts .. window.HushwingAPI
        ├── lib/{models,batch,logger}.ts
        ├── components/ .......... Header, UploadZone, JobQueue, DebugLog, AbPreview,
        │                          ui primitives
        └── workers/enhance-worker.ts     Pipeline A
public/
  ├── worklets/hushwing-preview.js   Pipeline B processor — plain JS mirror of lib/dsp.ts
  ├── coi-serviceworker.js           COOP/COEP injection for SharedArrayBuffer
  └── mcp.json                       WebMCP discovery document, served at /mcp.json
e2e/hushwing.e2e.mjs                 the browser suite
```

`src/lib/dsp.ts` is the single source of truth for the DSP. `public/worklets/hushwing-preview.js`
is a hand-maintained plain-JS copy, because an `AudioWorklet` module is loaded outside the bundler
and cannot import TypeScript. **Change both together** — that is item 3 of `AGENTS.md` §3.

## Testing

```bash
bunx playwright install chromium                          # once
PREVIEW_URL=https://<host> bun run test:e2e               # headless
HEADED=1 E2E_SCREENSHOT=/tmp/studio.png \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  PREVIEW_URL=https://<host> bun run test:e2e             # real windowed Chromium
```

`e2e/hushwing.e2e.mjs` drives real Chromium and asserts on the *delivered bytes*, not on the UI:

1. queues a generated 16 kHz WAV, a real H.264/AAC MP4 and a VP8/Opus WebM recorded in-page;
2. checks every result's container and header (RIFF/fmt, Matroska magic `1a45dfa3`, MP4 `ftyp`);
3. exports the `.zip` and verifies the `PK` header;
4. runs the A/B preview — worklet ready, level meter moving, playhead advancing, A↔B switching,
   graph teardown;
5. exercises `?model=`, `?debug=`, the semantic DOM hooks and `window.HushwingAPI`.

When a job fails it dumps the app's own diagnostic log, which is the fastest route to the cause.
Point `PREVIEW_URL` at the dev preview or at the live site — both are supported (the dev-only
diagnostics import degrades to a note in production). A green run is required before shipping a
change to the pipeline, an engine or the preview.

### Bulk and queued workloads

```bash
PREVIEW_URL=https://<host> bun run test:bulk                   # 20 audio files + 1 video + 3 late arrivals
BULK_COUNT=50 BULK_VIDEO=0 PREVIEW_URL=https://<host> bun run test:bulk   # bigger, audio-only
```

`e2e/hushwing.bulk.mjs` covers the part that has to hold up when someone drops a folder on it:

1. one multi-file drop through `?autostart=true` queues and drains every file without a click;
2. **concurrency never exceeds 1** and per-job progress never goes backwards;
3. files dropped *while the batch is draining* are picked up, not stranded at `queued`;
4. OPFS hygiene: `uploads/` is empty afterwards (each staging copy is deleted in the job's
   `finally`) and `outputs/` holds exactly one result per job;
5. every result follows its own source — in a mixed batch the audio files come back as WAV and the
   video as video, with no setting to get it wrong;
6. the `.zip` contains one entry per result, and "Clear finished" purges the whole batch;
7. heap growth across the batch stays bounded (it prints the peak, so a leak is visible).

Behaviour worth knowing before you promise someone "drop 500 files and walk away":

- The queue is strictly serial, so wall-clock time is the sum of every job. That is deliberate —
  one tab never holds several hundred megabytes of buffers at once.
- Results stay in OPFS until you download or clear them, and the browser only grants roughly 1 GB
  of it, so a very large batch is bounded by result size, not by file count. Small files (24 jobs
  ≈ 9.5 MB in the run above) are nowhere near that; a folder of long videos is.
- The queue drains anything still `queued`, so arrivals mid-run are picked up automatically.

## Deploying to GitHub Pages

The build is static and uses `base: './'`, so one artifact works at a domain root *and* at
`https://<user>.github.io/<repo>/`.

`.github/workflows/deploy.yml` runs install → typecheck → `vite build` → `actions/deploy-pages` on
every push to `main`. **Settings → Pages → Source must be "GitHub Actions"** — if it is left on
"Deploy from a branch", the legacy Jekyll pipeline republishes the raw repository root on each push
and silently overrides the deployed artifact (the site then serves `/src/main.tsx` and 404s on
`/mcp.json`, `/worklets/…` and `/ffmpeg-core/…`). `public/.nojekyll` keeps `assets/` from being
filtered if that ever happens.

Static hosting cannot send `COOP`/`COEP` headers, so `public/coi-serviceworker.js` injects
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`
(PRD §2.1) to make `SharedArrayBuffer` available. It only registers in a top-level window, so it
stays inert inside an embedded preview; append `?coi=off` to disable it entirely.

## Environment variables

All optional — without them the app still processes local files. Set them in
**Settings → Environment** (sandbox) and in the hosting panel (production); Vite only exposes
`VITE_`-prefixed keys to the client.

| Variable | Purpose |
| --- | --- |
| `VITE_FFMPEG_CORE_BASE` | Force a specific `ffmpeg-core.js` / `.wasm` location, overriding the probe |

That is the whole list — there is no OAuth, database or API key, because the app talks to nothing.

### Where the ffmpeg core comes from

`vite.config.ts` copies `node_modules/@ffmpeg/core` into `dist/ffmpeg-core/` at build time, and
`src/lib/ffmpeg.ts` probes for those files before falling back to a CDN. It must be the **ESM**
build: `@ffmpeg/ffmpeg` always spawns a *module* worker, where `importScripts()` does not exist and
the loader falls back to `import(coreURL)` — importing the UMD bundle yields no default export and
the load fails. A deployed build therefore fetches nothing but its own origin (verified: zero
third-party requests at runtime).

`public/ffmpeg-core/` is an optional local copy of the same two files, used by the dev preview when
present. It is **gitignored on purpose** — 32 MB of WASM does not belong in git, and nothing
depends on it being there.

## Debugging

- **`?debug=true`** opens the on-screen diagnostics panel: a bounded 250-entry rolling log, the
  capability badges (OPFS, AudioWorklet, SharedArrayBuffer, cross-origin isolation, Web Workers)
  and a log download. It has a stable hook: `[data-mcp-target="diagnostics"]`.
- **`window.HushwingAPI.downloadDebugLog()`** exports the same log as a `.txt`.
- From the console the queue is fully drivable: `HushwingAPI.getJobs()`, `queueMedia()`,
  `processMedia()`.

### Gotchas that will cost you an afternoon

- **`innerText` reflects CSS `text-transform`.** Headings are styled `uppercase`, so `innerText`
  reports `DIAGNOSTICS` while `textContent` reports `Diagnostics`. Assert on `textContent` or on a
  `data-*` hook.
- **A dev-server module URL can be served stale.** If `curl` shows an edit missing, cache-bust the
  URL (`?t=1`) before believing it — and never conclude the app is broken from a plain-URL fetch.
- **Never collect a whole rendered file into one blob** unless it is already a single buffer.
  Inputs stage in OPFS and results stream back through `openOPFSWriter`.
- **Queue concurrency is 1** by design (`runQueue`), so a phone tab never holds several
  multi-hundred-megabyte buffers.
- **Release WASM resources in `finally`**: delete ffmpeg virtual files after every run and reject
  pending worker calls on dispose.
- **The worker reports failures as plain strings**, not `Error`s. `describeError()` in
  `lib/ffmpeg.ts` exists because a naive `instanceof Error` check threw away the only useful detail.
- **Cloud pickers must never write back.** Import goes cloud → OPFS only; results stay local.

## Headless / agent surface

```js
await window.HushwingAPI.getModels()            // ['webaudio', 'rnnoise'] — only what really runs
await window.HushwingAPI.processMedia({ file, model: 'webaudio' })  // → Blob, container follows the source
await window.HushwingAPI.queueMedia({ file })   // → job id
window.HushwingAPI.getJobs()                    // id, status, name, progress, stage, resultUrl, error
window.HushwingAPI.downloadDebugLog()
```

| Selector | Purpose |
| --- | --- |
| `input[data-mcp-action="upload"]` | Hidden file input — agents set `.files` and dispatch `change` |
| `select[data-mcp-target="model-selector"]` | `webaudio` \| `rnnoise` |
| `button[data-mcp-action="process-queue"]` | Process every queued job |
| `a[data-mcp-action="download-result"][data-job-id="<uuid>"]` | Result download link |
| `[data-mcp-target="diagnostics"]` | Diagnostics panel (present only while the log is open) |

Job rows poll cleanly: `<li data-job-id="<uuid>" data-status="queued|preparing|processing|completed|error" data-job-name="interview.wav">`.

URL parameters: `?model=rnnoise`, `?autostart=true`, `?debug=true`, `?coi=off`; the hash `#studio`
opens the dashboard directly. Full contract in [`AGENTS.md`](./AGENTS.md) §4–§7; discovery document
[`public/mcp.json`](./public/mcp.json), served at `/mcp.json`.

## Conventions

Vite + React 19 + TypeScript built with Bun, Tailwind CSS v4 with theme tokens declared in
`src/index.css` (`--color-surface-*`, `--color-ink-*`, `--color-accent`, `--color-border` — use the
tokens, never hardcoded hex). No component library: `src/components/ui.tsx` holds the primitives.
State lives in one zustand store and the queue is the source of truth.

**Everything is client-side. If a change would send user media anywhere, it is wrong.** There is no
server state, so do not add a data-fetching layer.

## Known limitations

- `@ffmpeg/ffmpeg` 0.12 cannot mount OPFS, so the input passes through the WASM filesystem (RAM)
  during the ffmpeg step. Everything before and after it streams through OPFS. Expect the first
  load to be dominated by the 32 MB core download.
- The `rnnoise` id is kept for API compatibility, but this build ships an adaptive gate/expander
  DSP profile, not the RNNoise WASM weights. The UI says so.
- The A/B preview has not been verified on a physical iOS device, where Safari interrupts
  `AudioWorklet` differently.

## Licence

See [`LICENSE`](./LICENSE).
