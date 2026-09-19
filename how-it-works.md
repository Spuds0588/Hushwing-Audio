# How Hushwing Audio works

A tour of the moving parts, written for someone who wants to know *why* it is built this way and
where to start poking. For the rules you must follow when changing things, read
[`AGENTS.md`](./AGENTS.md); for the product requirements, [`PRD-Hushwing.md`](./PRD-Hushwing.md).

The whole app is client-side. There is no server to call, no upload step to reason about, and no
place for media to escape: a job is just a `File` that goes into the Origin Private File System and
comes back out as a different `File`.

## 1. The shape of a job

`runJob()` in `src/lib/pipeline.ts` is the spine. Every job walks the same path, reporting progress
and a human-readable stage as it goes:

```
File/Blob
   │  stageFileInOPFS()                    4 → 8 %   "Copying into OPFS"
   ▼
OPFS uploads/<ts>-<rand>.<ext>
   │  read back as a Blob, hand to ffmpeg
   │  extractAudioToWav()                 12 → 38 %  "Extracting audio"
   ▼
16 kHz mono PCM WAV  (-vn -ac 1 -acodec pcm_s16le -ar 16000)
   │  parseWav()  (own parser, no AudioContext)  40 %
   ▼
Float32Array @ 16 kHz
   │  createEngine(model).process()        45 → 72 %  "Enhancing with <model>"
   ▼
enhanced Float32Array @ 16 kHz
   │  resample(16 kHz → 48 kHz)            72 %
   ▼
Float32Array @ 48 kHz
   │  encodeWavChunks() → openOPFSWriter()  streamed, 1 MiB chunks
   ▼
OPFS outputs/<jobId>.wav
   │  muxVideo()  (video jobs only)        80 → 94 %  "Muxing video"
   ▼
OPFS outputs/<jobId>.<ext>  →  object URL  →  the download link
```

Two rates are involved, and they are constants on purpose:

- **16 kHz is the inference rate.** Speech intelligibility lives below 8 kHz, and every sample the
  DSP touches costs time and memory. Denoisers in the wild are trained at 16 kHz for the same reason.
- **48 kHz is the delivery rate.** It is what video containers and editors expect, so muxed results
  do not need an arbitrary resample downstream.

Two decisions inside that flow are worth calling out:

- **The WAV is parsed by hand, not by `decodeAudioData`.** `parseWav()` in `src/lib/filekit.ts` needs
  no `AudioContext`, which is what allows the whole pipeline — including the DSP — to run inside a
  Web Worker where there is no audio device.
- **A failed mux never loses the audio.** If the container is unhappy, the job keeps the enhanced
  WAV, attaches a `warning`, and completes. Losing a finished render to a container mismatch would
  be the worst possible failure mode.

`runQueue()` walks pending jobs **one at a time** (PRD §5). A browser tab on a phone cannot be asked
to hold several multi-hundred-megabyte buffers, so concurrency stays at 1. Between jobs it waits for
`document.visibilityState === 'visible'`, because iOS can silently freeze a backgrounded tab and
that is a much better place to pause than mid-render.

## 2. The DSP

`src/lib/dsp.ts` is the authority. Every kernel is a tiny class implementing:

```ts
interface DspKernel {
  process(input: Float32Array): void   // in place
  reset(): void
}
```

Kernels are **stateful and block-size agnostic**: filter state carries across calls, so the same
code can be fed 128-sample frames from an `AudioWorklet` or a ten-minute buffer offline and produce
the same result. That property is what makes the two pipelines in §3 possible at all.

| Kernel | What it does |
| --- | --- |
| `Highpass` | RBJ biquad, transposed direct form II, default `Q = 0.7071`. Kills rumble, HVAC and desk thumps below the voice band |
| `Compressor` | Feed-forward, soft knee (quadratic), exponential attack/release ballistics, makeup gain. Even out level without pumping |
| `FrameGate` | Adaptive noise gate / downward expander driven by a tracked noise floor — the `rnnoise` profile |
| `SoftLimiter` | Below the threshold: untouched. Above it: asymptotic approach to the ceiling, so the gain stages before it cannot hard-clip |
| `Chain` | Runs kernels in order; `resample`, `computePeaks` and `peakLevel` are the free functions |

### The two profiles

`createKernel(model, sampleRate)` wires the chains:

```
webaudio   Highpass 85 Hz
        →  Compressor   −18 dB · 3:1 · knee 8 dB · attack 4 ms · release 140 ms · makeup 1.18
        →  SoftLimiter  ceiling 0.98, threshold 0.8

rnnoise    Highpass 70 Hz
        →  FrameGate    open at 4× the noise floor, closed below 1.5×, floor −23 dB when shut
        →  Compressor   −12 dB · 2:1 · knee 6 dB · attack 8 ms · release 200 ms · makeup 1.1
        →  SoftLimiter
```

The interesting one is `FrameGate`, whose whole job is deciding what counts as *noise* without a
neural network. It smooths signal power over ~10 ms and tracks a noise floor with
minimum-statistics: when a frame is quieter than the current floor the estimate **snaps down**
(5 % blend), and otherwise it **creeps up** very slowly (0.04 % per sample). Speech is loud and
intermittent, so the floor keeps sliding down into the gaps and the speech is never absorbed into
it. Each frame is then attenuated by its ratio to that floor — fully open at 4×, fully shut below
1.5×, interpolated logarithmically in between, with a fast 3 ms attack and a slow 120 ms release so
the opening and closing are inaudible.

Everything is plain arithmetic — no WASM, no allocation per block. That is deliberate: it keeps the
whole engine inside one file a human can read, and it means the preview and the final render cannot
disagree.

### Resampling

`resample()` has two paths, and the asymmetry is the point:

- **Upsampling (16 → 48 kHz, the delivery path)** uses Catmull-Rom cubic interpolation. The source
  has already been band-limited to 8 kHz by the extraction step, so there is nothing to alias
  against; a 32-tap sinc would be pure cost. On an hour-long file that is the difference between
  seconds and hours.
- **Downsampling** keeps a 16-tap windowed-sinc filter (Hann window, normalized weights), because
  that path *does* need the anti-aliasing.

Output length is `Math.round(input.length × ratio)`, so frame counts stay exact — muxed audio must
not drift against the video track it is joined to.

## 3. Two pipelines, one DSP

The same kernels run in three places, which is the core design idea:

| | Where | Purpose |
| --- | --- | --- |
| **A** | `src/workers/enhance-worker.ts`, driven by `WorkerEngine` | Batch render, off the main thread, so the UI never freezes |
| **B** | `public/worklets/hushwing-preview.js` | Real-time A/B monitoring while you listen |
| fallback | `LocalEngine` on the main thread | When workers are blocked by the environment |

All three implement one contract (`src/lib/engine.ts`):

```ts
interface HushwingEngine {
  readonly model: ModelId
  process(input: Float32Array, sampleRate: number): Promise<EngineResult>
  dispose(): void
}
```

`WorkerEngine` posts the sample buffer with the buffer **transferred**, not copied, so a long file
costs no extra memory on the way in or out. `createEngine()` prefers the worker and silently falls
back to the main thread, so a hardened environment degrades instead of failing.

### Pipeline B, and why the A/B switch is click-free

`PreviewSession` (`src/lib/preview.ts`) builds this graph:

```
<audio> ─ createMediaElementSource ─► AudioWorkletNode('hushwing-preview') ─► AnalyserNode ─► destination
```

The worklet holds *both* profiles and a `bypass` flag. Switching A → B posts `{ type: 'bypass' }`
and nothing else: the graph is never rebuilt, no node is reconnected, no buffer is reallocated. That
is why the comparison does not click or gap — you are listening to one continuous signal path and
flipping a boolean inside it. Changing the model posts `{ type: 'model' }` and resets the kernel
state so the new profile starts clean.

Peaks are decoded once up front with an `OfflineAudioContext(1, 1, 48000)` used purely as a decoder,
then downsampled to 320 buckets of max-abs values (`computePeaks`) for the waveform canvas. The level
meter is RMS from the analyser's time-domain data, scaled by 3.2 and clamped — cheap, and it moves
with the audio rather than with the styling.

The worklet is **plain JavaScript, and mirrors `src/lib/dsp.ts` by hand**, because an `AudioWorklet`
module is fetched outside the bundler and cannot import TypeScript. The constants are duplicated
(`MIN_GAIN`, `OPEN_RATIO`, `CLOSED_RATIO`, …). If you change one file, change the other — the two
pipelines drifting apart would mean the preview stops predicting the render, which is the only thing
the preview is for. A test hook pins this behaviour: `[data-preview-mode="a"|"b"]`,
`[data-preview-level]`, `[data-preview-position]`.

## 4. ffmpeg.wasm, and the traps in it

`src/lib/ffmpeg.ts` wraps `@ffmpeg/ffmpeg` for exactly two operations: pull a 16 kHz mono WAV out of
any input, and put enhanced audio back into a video without re-encoding the picture.

**The core is single-threaded.** That means no `SharedArrayBuffer`, no cross-origin isolation
requirement, and a binary that works on any static host. The COI service worker (§5) is for the
broader PRD requirement, not for ffmpeg.

**It must be the ESM core build.** `@ffmpeg/ffmpeg` always spawns a *module* worker, where
`importScripts()` does not exist, so the loader falls back to `import(coreURL)` — and importing the
UMD bundle produces no default export. The failure reads `failed to import ffmpeg-core.js`, which
tells you nothing. This cost an afternoon; it is written down here so it does not cost another.

**Where the core comes from** is resolved once, in this order:

1. `VITE_FFMPEG_CORE_BASE`, if set;
2. a same-origin probe — `HEAD` on `<base>/ffmpeg-core.wasm`, rejected if the response is
   `text/html` (the classic SPA-fallback trap, where a 200 is really a 404);
3. the pinned CDN fallback.

In production step 2 always wins, because `vite.config.ts` copies the core into `dist/ffmpeg-core/`
at build time. A deployed build therefore fetches nothing but its own origin — verified, not assumed.

**Container and codec are chosen from the input.** The video stream is always copied (`-c:v copy`),
so the output container has to accept the source codec: VP8/VP9 cannot be stored in MP4, and WebM
only takes Vorbis or Opus. `muxTargetFor()` maps the input extension to a container plus an ordered
list of candidate audio encoders, and `listEncoders()` asks the core what it actually ships (`-encoders`)
instead of guessing — so the choice adapts to the core rather than to a hardcoded belief about it.
MP4 output also gets `-movflags +faststart`.

**Progress is derived from the log.** ffmpeg reports duration in a log line, which is parsed out and
used to turn the worker's `time` into a real fraction; without it the progress bar would lie.

**Everything is freed in a `finally`.** Inputs and outputs are deleted from the virtual filesystem
after every run, and a job's staged input is removed from OPFS once the result exists.

### The one honest performance limitation

`@ffmpeg/ffmpeg` 0.12 offers no way to mount OPFS, so during the ffmpeg step the input bytes live in
the WASM filesystem — i.e. in RAM. Everything before and after that step streams through OPFS. Lifting
this (via `WORKERFS`/`PROXYFS`, or the multithreaded core) is the top item in the v2 backlog, because
it is the memory high-water mark for large videos.

## 5. Storage and the platform constraints

**OPFS, streamed.** `src/lib/opfs.ts` exposes a writer rather than a blob API: results are written in
chunks, so peak memory stays roughly one buffer per job instead of "the whole rendered file, twice".
The point of staging the input at all is that the queue can then pass a *path* around instead of
dragging megabytes of `ArrayBuffer` through every stage.

**Cross-origin isolation.** `SharedArrayBuffer` only becomes available in a cross-origin-isolated
document, which needs `COOP: same-origin` and `COEP: credentialless` — headers a static host like
GitHub Pages cannot send. `public/coi-serviceworker.js` (vendored from the `coi-serviceworker`
package) registers a service worker that injects them. It only registers in a top-level window, so it
stays inert inside embedded previews and cannot cause a reload loop there, and `?coi=off` disables it
outright. `credentialless` rather than `require-corp` is what keeps the Google/OneDrive picker iframes
usable. The diagnostics panel reports the resulting state as a "Cross-origin isolated ✓/✗" badge.

**The logger is synchronous and bounded.** `src/lib/logger.ts` keeps a rolling 250-entry buffer and
exposes it through `useSyncExternalStore`, so logging costs nothing when the panel is closed and the
buffer can never grow without limit. Download it from the panel or via
`window.HushwingAPI.downloadDebugLog()`.

## 6. Driving it without a mouse

Everything the UI can do is reachable programmatically, which is what makes the app testable and
agent-drivable (contract in [`AGENTS.md`](./AGENTS.md) §4–§7):

- `window.HushwingAPI` — `getModels()`, `processMedia()`, `queueMedia()`, `getJobs()`,
  `downloadDebugLog()`.
- semantic `data-mcp-*` hooks on the real controls, plus `data-job-id` / `data-status` on job rows.
- URL parameters `?model=`, `?autostart=true`, `?debug=true`, `?coi=off`, and the `#studio` hash.
- `public/mcp.json`, served at `/mcp.json`, so WebMCP clients can discover the tool surface at load.

`e2e/hushwing.e2e.mjs` uses exactly this surface, which is why the suite is short enough to read and
still covers the whole product: generated WAV, real H.264/AAC MP4, in-page VP8/Opus WebM, container
and header assertions on every delivered result, the zip export, the worklet preview (ready, meter,
playhead, A↔B, teardown), the URL parameters and the API.

## 7. Where to start reading

| If you want to… | Read |
| --- | --- |
| understand a job end to end | `src/lib/pipeline.ts` → `runJob()` |
| change how cleaning sounds | `src/lib/dsp.ts`, then mirror it in `public/worklets/hushwing-preview.js` |
| work on containers or codecs | `src/lib/ffmpeg.ts` → `muxTargetFor()`, `listEncoders()` |
| touch the preview or A/B | `src/lib/preview.ts` + `src/components/AbPreview.tsx` |
| add an engine | `src/types/hushwing.ts`, `src/lib/models.ts`, `createKernel()`, both pipelines |
| add UI or state | `src/store/app.ts` first — the queue is the source of truth |
| make it faster | the ffmpeg RAM buffer (§4), then code-splitting the 500 kB main bundle |

## 8. Known limits, and the honest state of the engines

- **`rnnoise` is an id, not the RNNoise weights.** This build ships the adaptive gate above, and the
  UI labels it that way. Vendoring the real WASM weights behind the same id is a drop-in follow-up —
  the id is kept so the API and saved settings do not break when that lands.
- **DeepFilterNet 3 is not implemented.** The option renders disabled rather than pretending.
- **Cloud import is one-way.** Google Drive / OneDrive import into OPFS; results are never written
  back, which is a PRD constraint and a deliberate one.
- **iOS is unproven.** The worklet and the visibility handling exist for it, but the A/B preview has
  not been verified on a physical device, where Safari interrupts `AudioWorklet` differently.
- **First load is ~32 MB** for the ffmpeg core. It is fetched lazily (only once there is work to do)
  and cached by the browser afterwards, but it is the dominant cost of a cold start.
