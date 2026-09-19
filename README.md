# Hushwing

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
| A three-step wizard — add files → pick an engine → watch the queue | ✅ |
| Drag & drop with a review list, queue with per-job progress, stage labels, retry | ✅ |
| `webaudio` engine — 16 kHz high-pass → expander → soft-knee compressor → soft limiter | ✅ |
| `rnnoise` engine — real RNNoise WebAssembly at its native 48 kHz | ✅ |
| WAV · MP3 · M4A/AAC · FLAC · Ogg/Vorbis · Opus decoded natively — no ffmpeg needed | ✅ `mediabunny` |
| Video → 48 kHz mono WAV, enhance, mux back into a container that fits the picture | ✅ `ffmpeg.wasm` |
| Batch render off the main thread (worker, or the audio graph for RNNoise) | ✅ |
| Failures a person can act on ("this file has no audio track") instead of exit codes | ✅ |
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

A queue of WAV, MP3, M4A/AAC, FLAC, Ogg/Vorbis or Opus never downloads `ffmpeg.wasm`: WAV is parsed
in JavaScript and everything else goes through `mediabunny`, using the browser's own codecs. The
~32 MB core is fetched only for work that needs it — muxing a video, or opening a container
`mediabunny` cannot read (AVI, WMV, FLV). See `preloadFFmpeg` and `src/lib/decode.ts`.

## Scripts

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server. `PORT` overrides the port; binds `0.0.0.0`. HMR is deliberately **off** |
| `bun run build` | `tsc -b && vite build` → `dist/`. Must exit; it never starts a server |
| `bun run build:pages` | `vite build` alone — what CI runs, so type errors fail the build step, not the deploy |
| `bun run typecheck` | `tsc -b --noEmit`. Must be clean |
| `bun run lint` | `oxlint` |
| `bun run preview` | Serve the built `dist/` locally |
| `bun run test:e2e` | The browser suite — the wizard, seven formats, byte-level result checks (below) |
| `bun run test:bulk` | The bulk/queue suite — 20+ files in one drop, plus mid-run arrivals |

## Project layout

```
index.html ─ coi-serviceworker → cross-origin isolation
  └── src/App.tsx ──────── the studio shell: step routing, queue wiring, API install
        ├── store/app.ts ......... zustand queue + wizard step — the single source of truth
        ├── lib/dsp.ts ........... `webaudio` kernels: high-pass, compressor, limiter, resample
        ├── lib/rnnoise.ts ....... RNNoise WebAssembly, rendered through an offline audio graph
        ├── lib/decode.ts ........ WAV parser + `mediabunny` reader (lazy), ffmpeg as fallback
        ├── lib/engine.ts ........ HushwingEngine contract; worker, main-thread and RNNoise engines
        ├── lib/ffmpeg.ts ........ core loading/probing, mono extraction, video mux
        ├── lib/filekit.ts ....... WAV parse/encode, format tables, blob URLs
        ├── lib/opfs.ts .......... streaming OPFS writer/reader
        ├── lib/pipeline.ts ...... stage → decode → enhance → stream → mux
        ├── lib/hushwing-api.ts .. window.HushwingAPI
        ├── lib/{models,batch,logger}.ts
        ├── components/ .......... Header, Stepper, AddStep, EngineStep, RunStep, JobQueue,
        │                          DebugLog, ui primitives
        └── workers/enhance-worker.ts     the `webaudio` engine, off the main thread
public/
  ├── coi-serviceworker.js           COOP/COEP injection for SharedArrayBuffer
  └── mcp.json                       WebMCP discovery document, served at /mcp.json
e2e/hushwing.e2e.mjs                 the browser suite
```

`src/lib/dsp.ts` is the single source of truth for the `webaudio` chain, and there is no second copy
of it: the real-time `AudioWorklet` preview was removed (it could not match the delivered file) and
RNNoise has exactly one code path, `renderWithRnnoise`, driven through an `OfflineAudioContext`.

## Testing

```bash
bunx playwright install chromium                          # once
PREVIEW_URL=https://<host> bun run test:e2e               # headless
HEADED=1 E2E_SCREENSHOT=/tmp/studio.png \
  xvfb-run -a --server-args="-screen 0 1600x1000x24" \
  PREVIEW_URL=https://<host> bun run test:e2e             # real windowed Chromium
```

`e2e/hushwing.e2e.mjs` drives real Chromium and asserts on the *delivered bytes*, not on the UI:

1. proves step one is the only step on screen (no engine cards, queue or progress yet), then drops a
   generated 16 kHz WAV and follows the wizard to the engine step;
2. asserts the removed preview UI and its worklet chunk stay gone;
3. queues a real H.264/AAC MP4, an MP3, a FLAC, an Ogg/Vorbis file, an M4A/AAC file, an AVI and a
   VP8/Opus WebM recorded in-page, all through the `rnnoise` engine;
4. asserts which decoder read each file — `wav reader` for WAV, `mediabunny` for MP3/FLAC/Ogg/M4A
   and for the audio inside MP4/WebM, `ffmpeg` only for AVI — and checks every result's container,
   rate and channel count (RIFF/fmt at 48 kHz mono, Matroska `1a45dfa3`, MP4 `ftyp`, AVI
   `RIFF`+`AVI `);
5. audits that an audio-only queue fetches the ffmpeg core **zero** times, in a fresh browser
   context so the cache cannot flatter it;
6. checks a video with no audio track fails with a sentence rather than an exit code;
7. exports the `.zip` and verifies the `PK` header;
8. exercises `?model=`, `?debug=`, the semantic DOM hooks and `window.HushwingAPI`.

A run covers both engines between the two suites: this one drives RNNoise (the WebAssembly path,
including its per-job `OfflineAudioContext`) and the bulk suite runs the JS chain.

When a job fails it dumps the app's own diagnostic log, which is the fastest route to the cause.
Point `PREVIEW_URL` at the dev preview or at the live site — both are supported (the dev-only
diagnostics import degrades to a note in production). A green run is required before shipping a
change to the pipeline or an engine.

### Bulk and queued workloads

```bash
PREVIEW_URL=https://<host> bun run test:bulk                   # 20 audio files + 1 video + 3 late arrivals
PREVIEW_URL=https://<host> BULK_MODEL=rnnoise bun run test:bulk            # the WebAssembly engine
BULK_COUNT=50 BULK_VIDEO=0 PREVIEW_URL=https://<host> bun run test:bulk    # bigger, audio-only
```

`e2e/hushwing.bulk.mjs` covers the part that has to hold up when someone drops a folder on it:

1. one multi-file drop through `?autostart=true` queues and drains every file without a click;
2. **concurrency never exceeds 1** and per-job progress never goes backwards;
3. files added *while the batch is draining* (through the wizard's "Add more files") are picked up,
   not stranded at `queued`, and land back on the running batch;
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
`/mcp.json` and `/ffmpeg-core/…`). `public/.nojekyll` keeps `assets/` from being filtered if that
ever happens.

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
- **The wizard step is derived from the queue, not from clicks alone.** `enqueue()` moves you to the
  engine step, `runQueue()` moves you to the queue, and adding a file while a batch runs keeps you on
  the queue. A step that cannot act on the current state renders disabled instead of vanishing.

## Headless / agent surface

```js
await window.HushwingAPI.getModels()            // ['webaudio', 'rnnoise'] — only what really runs
await window.HushwingAPI.processMedia({ file, model: 'webaudio' })  // → Blob, container follows the source
await window.HushwingAPI.queueMedia({ file })   // → job id
window.HushwingAPI.getJobs()                    // id, status, name, progress, stage, resultUrl,
                                                // error, warning, decoder
window.HushwingAPI.downloadDebugLog()
```

| Selector | Purpose |
| --- | --- |
| `main[data-wizard-step="add|engine|run"]` | Which step is on screen |
| `[data-mcp-target="wizard-step"][data-step="<id>"]` | Step tab (`data-state`: current/done/later) |
| `input[data-mcp-action="upload"]` | Hidden file input, step 1 — agents set `.files` and dispatch `change` |
| `[data-mcp-target="model-selector"][data-model-id="webaudio|rnnoise"]` | Engine card, step 2 |
| `button[data-mcp-action="process-queue"]` | Process every queued job |
| `a[data-mcp-action="download-result"][data-job-id="<uuid>"]` | Result download link |
| `button[data-mcp-action="export-zip"]` | Download every finished result as a zip |
| `[data-mcp-target="diagnostics"]` | Diagnostics panel (present only while the log is open) |

Job rows poll cleanly: `<li data-job-id="<uuid>" data-status="queued|preparing|processing|completed|error"
data-job-name="voiceover.mp3" data-job-model="rnnoise" data-job-decoder="mediabunny">`.

URL parameters: `?model=rnnoise`, `?autostart=true`, `?debug=true`, `?coi=off`. Full contract in
[`AGENTS.md`](./AGENTS.md) §4–§7; discovery document [`public/mcp.json`](./public/mcp.json), served
at `/mcp.json`.

## Conventions

Vite + React 19 + TypeScript built with Bun, Tailwind CSS v4 with theme tokens declared in
`src/index.css` (`--color-surface-*`, `--color-ink-*`, `--color-accent`, `--color-border` — use the
tokens, never hardcoded hex). No component library: `src/components/ui.tsx` holds the primitives.
State lives in one zustand store and the queue is the source of truth.

**Everything is client-side. If a change would send user media anywhere, it is wrong.** There is no
server state, so do not add a data-fetching layer.

## Known limitations

- `@ffmpeg/ffmpeg` 0.12 cannot mount OPFS, so the input passes through the WASM filesystem (RAM)
  during the ffmpeg step. Everything before and after it streams through OPFS. That step now only
  happens for video muxing and for containers `mediabunny` cannot open (AVI, WMV, FLV) — WAV, MP3,
  M4A/AAC, FLAC, Ogg/Vorbis and Opus are decoded natively.
- Video still needs the 32 MB core, for the mux. Removing it would mean writing the container
  ourselves; the researched path is in `todo.md` §3.
- `mediabunny` decodes with the browser's own codecs, so a browser lacking WebCodecs support for a
  format falls back to ffmpeg rather than failing.
- RNNoise only runs at 48 kHz and adds a fixed ~11 ms of latency from its frame scheduler. That is
  below the threshold where it reads as out of sync with picture, and the mux keeps frame counts
  exact, so audio cannot drift across a long video.
- The `webaudio` chain runs at 16 kHz, because the band limit is part of what removes wideband hiss.
  RNNoise is 48 kHz, and everything is delivered at 48 kHz.
- There is no in-app preview. The live `AudioWorklet` audition could not match the delivered file
  (it ran at 48 kHz against a 16 kHz chain), and a preview that disagrees with the output is worse
  than none, so it was removed rather than patched. Judge a result by processing it — the queue
  reports progress and the finished file downloads.
- Verified in Chromium only (headless, and headed under Xvfb). A physical Android/iOS pass over a
  long recording is still on the list.

## Licence

See [`LICENSE`](./LICENSE).
