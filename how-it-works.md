# How Hushwing Audio works

A tour of the moving parts, written for someone who wants to know *why* it is built this way and
where to start poking. For the rules you must follow when changing things, read
[`AGENTS.md`](./AGENTS.md); for the product requirements, [`PRD-Hushwing.md`](./PRD-Hushwing.md).

The whole app is client-side. There is no server to call, no upload step to reason about, and no
place for media to escape: a job is just a `File` that goes into the Origin Private File System and
comes back out as a different `File`.

It is also one page with one decision in it, arranged as a **three-step wizard**: add files, pick an
engine, watch the queue. Only the current step is on screen. The output follows the source (a video
keeps its picture with the enhanced track muxed back in, audio comes back as a 48 kHz WAV) so there
is no format to choose and no import source to configure.

## 1. The shape of a job

`runJob()` in `src/lib/pipeline.ts` is the spine. Every job walks the same path, reporting progress
and a human-readable stage as it goes:

```
File/Blob
   │  stageFileInOPFS()                    4 → 8 %   "Copying into OPFS"
   ▼
OPFS uploads/<ts>-<rand>.<ext>
   │  read back as a Blob
   │  prepareAudio()                       12 → 42 %  "Reading audio"
   ▼
Float32Array @ the engine's inference rate, mono
   │  createEngine(model).process()        46 %      "Enhancing with <model>"
   ▼
enhanced Float32Array @ the inference rate
   │  resample(inference → 48 kHz)         76 %      (a no-op when they already match)
   ▼
Float32Array @ 48 kHz
   │  encodeWavChunks() → openOPFSWriter()  streamed, 1 MiB chunks
   ▼
OPFS outputs/<jobId>.wav
   │  muxVideo()  (video jobs only)        80 → 94 %  "Muxing video"
   ▼
OPFS outputs/<jobId>.<ext>  →  object URL  →  the download link
```

`prepareAudio()` is where the format work happens, and it has two paths:

1. **JavaScript decoders first** (`src/lib/decode.ts`). WAV, MP3 and FLAC are decoded in-process, so
   an audio job starts immediately and never downloads the 32 MB ffmpeg core. Those decoders are
   imported lazily, so a queue of video never downloads them either. `job.decoder` records exactly
   which one ran.
2. **ffmpeg for everything else** — M4A/AAC, Ogg/Vorbis, and any video container — which also
   resamples to the target rate for free. If a JavaScript decoder recognises a container but cannot
   read it, the job falls back to ffmpeg rather than failing.

Two rates are involved:

- **The inference rate belongs to the engine**, and `MODEL_SPECS[].inferenceRate` declares it. The
  Web Audio chain runs at **16 kHz**: speech intelligibility lives below 8 kHz, so 16 kHz is the
  band limit as well as the cheap choice. RNNoise runs at **48 kHz**, which is not a preference —
  it is trained there and refuses anything else.
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
| `SoftLimiter` | Below the threshold: untouched. Above it: asymptotic approach to the ceiling, so the gain stages before it cannot hard-clip |
| `Chain` | Runs kernels in order; `resample`, `computePeaks` and `peakLevel` are the free functions |

### The `webaudio` profile

`createKernel('webaudio', sampleRate)` wires the chain:

```
Highpass 85 Hz
 →  Compressor   −18 dB · 3:1 · knee 8 dB · attack 4 ms · release 140 ms · makeup 1.18
 →  SoftLimiter  ceiling 0.98, threshold 0.8
```

Everything is plain arithmetic — no WASM, no allocation per block. That is deliberate: it keeps the
whole engine inside one file a human can read, and it means the preview and the final render cannot
disagree.

### The `rnnoise` engine is not a kernel

RNNoise is a recurrent neural network, not a filter chain, so it does not live in `dsp.ts` at all.
`src/lib/rnnoise.ts` drives Shiguredo's WebAssembly build (through
`@sapphi-red/web-noise-suppressor`) in one of two ways:

- **Batch:** an `OfflineAudioContext(1, frames, 48000)` with the RNNoise `AudioWorkletProcessor`
  wired between a buffer source and the destination. `startRendering()` renders the whole file at
  full speed on the audio thread, which is the cheapest correct way to run a 48 kHz framed network.
- **Preview:** the same processor, the same wasm binary, live in the A/B graph.

The frame scheduler in the processor is a delay line that hands RNNoise 480-sample frames and reads
results back out, which costs a fixed **~11 ms of latency**. Frame counts are preserved exactly, so a
muxed video track cannot drift; the shift is far below the threshold where it reads as out of sync.

### Resampling

`resample()` has two paths, and the asymmetry is the point:

- **Upsampling (16 → 48 kHz, the `webaudio` delivery path)** uses Catmull-Rom cubic interpolation. The
  source has already been band-limited to 8 kHz by the 16 kHz chain, so there is nothing to alias
  against; a 32-tap sinc would be pure cost. On an hour-long file that is the difference between
  seconds and hours. An MP3 (44.1 → 48 kHz for RNNoise) takes the same path: upsampling can only
  add imaging, never aliasing.
- **Downsampling** keeps a 16-tap windowed-sinc filter (Hann window, normalized weights), because
  that path *does* need the anti-aliasing.

Output length is `Math.round(input.length × ratio)`, so frame counts stay exact — muxed audio must
not drift against the video track it is joined to.

## 3. Two pipelines, one engine

Every engine implements one contract (`src/lib/engine.ts`), whatever it runs on underneath:

```ts
interface HushwingEngine {
  readonly model: ModelId
  process(input: Float32Array, sampleRate: number): Promise<EngineResult>
  dispose(): void
}
```

| Engine | Where the work happens | Purpose |
| --- | --- | --- |
| `webaudio` | `src/workers/enhance-worker.ts`, driven by `WorkerEngine` | Batch render, off the main thread, so the UI never freezes |
| `webaudio` (fallback) | `LocalEngine` on the main thread | When workers are blocked by the environment |
| `rnnoise` | An `OfflineAudioContext` on the audio rendering thread | Same contract, WebAssembly underneath |

`WorkerEngine` posts the sample buffer with the buffer **transferred**, not copied, so a long file
costs no extra memory on the way in or out. `createEngine()` routes RNNoise to its own engine and
everything else to the worker, falling back to the main thread, so a hardened environment degrades
instead of failing.

### Pipeline B, and why the A/B switch is click-free

`PreviewSession` (`src/lib/preview.ts`) builds the whole graph once and never rewires it:

```
                 ┌─ dry ─────────────────────┐
  <audio> ───────┤                            │
   (MediaElement │─ dsp worklet ─ dsp gain ───┼──► AnalyserNode ─► destination
    Source)      └─ rnnoise ─── rnnoise gain ┘
```

Each branch ends in a `GainNode`, and switching A → B only ramps two gains over 20 ms. Nothing is
reconnected, nothing is reallocated, and the comparison never stops — which is why it does not click
or gap. The "wet" branch is whichever engine is selected; `setModel()` creates the RNNoise node on
demand (and says so in the panel if the browser will not host it), then just moves the gains again.

The preview asks for `AudioContext({ sampleRate: 48000 })` rather than accepting the device rate,
because the comparison happens against a 48 kHz delivery and RNNoise only runs at 48 kHz. A browser
that ignores the hint still gets a working Web Audio preview, with an amber note explaining that the
RNNoise audition is unavailable.

Peaks are decoded once up front with an `OfflineAudioContext(1, 1, 48000)` used purely as a decoder,
then downsampled to 320 buckets of max-abs values (`computePeaks`) for the waveform canvas. The level
meter is RMS from the analyser's time-domain data, scaled by 3.2 and clamped — cheap, and it moves
with the audio rather than with the styling.

The `webaudio` worklet is **plain JavaScript, and mirrors `src/lib/dsp.ts` by hand**, because an
`AudioWorklet` module is fetched outside the bundler and cannot import TypeScript. The constants are
duplicated (`HIGHPASS_HZ`, the compressor set, the limiter pair). If you change one file, change the
other — the two pipelines drifting apart would mean the preview stops predicting the render, which is
the only thing the preview is for. RNNoise has no such copy: batch and preview load the same wasm
binary, so they cannot drift at all. A test hook pins the behaviour: `[data-preview-mode="a"|"b"]`,
`[data-preview-level]`, `[data-preview-position]`, `[data-preview-model]`.

## 4. ffmpeg.wasm, and the traps in it

`src/lib/ffmpeg.ts` wraps `@ffmpeg/ffmpeg` for exactly two operations: pull mono PCM at the engine's
rate out of any input (`extractAudioToWav(input, name, sampleRate)`), and put enhanced audio back
into a video without re-encoding the picture.

**It is the fallback, not the front door.** `src/lib/decode.ts` handles WAV, MP3 and FLAC in plain
JavaScript, so those formats never fetch the core — a queue of audio makes zero `ffmpeg-core`
requests, which is verified by the suite rather than assumed. `App.tsx` only preloads the core when a
queued file is a video or an extension no JavaScript decoder claims.

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
outright. `credentialless` rather than `require-corp` keeps any cross-origin subresource loadable,
which costs nothing here because the app only ever fetches its own origin. The diagnostics panel
reports the resulting state as a "Cross-origin isolated ✓/✗" badge.

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
- the wizard itself: `main[data-wizard-step]`, `[data-mcp-target="wizard-step"][data-step]`,
  `[data-mcp-target="model-selector"][data-model-id]`, `[data-mcp-target="ab-preview"]`.
- URL parameters `?model=`, `?autostart=true`, `?debug=true`, `?coi=off`. The studio is the only
  page, so the `#studio` hash older links use does nothing (harmlessly).
- `public/mcp.json`, served at `/mcp.json`, so WebMCP clients can discover the tool surface at load.

`e2e/hushwing.e2e.mjs` uses exactly this surface, which is why the suite is short enough to read and
still covers the whole product: it walks the wizard (and asserts that step one is the *only* step on
screen), auditions RNNoise live, then queues a generated WAV, a real H.264/AAC MP4, an MP3, a FLAC, an
Ogg/Vorbis file and an in-page VP8/Opus WebM. Every delivered result is checked for container, rate
and channels, and every job is checked for which decoder read it — `wav reader`, `mp3` and `flac`
natively, `ffmpeg` for Vorbis and the videos. Then the zip export, the A/B panel, the URL parameters
and the API.

`e2e/hushwing.bulk.mjs` (`bun run test:bulk`) covers the queue instead of one file: 20+ files dropped
at once, three more dropped mid-drain, and assertions on the invariants that matter at that size —
concurrency pinned to 1, progress never regressing, `uploads/` emptied per job while `outputs/` keeps
exactly one result each, no stranded arrivals, a zip whose entry count matches, and bounded heap
growth.

## 7. Where to start reading

| If you want to… | Read |
| --- | --- |
| understand a job end to end | `src/lib/pipeline.ts` → `runJob()` |
| change how cleaning sounds | `src/lib/dsp.ts`, then mirror it in `public/worklets/hushwing-preview.js` |
| work on containers or codecs | `src/lib/ffmpeg.ts` → `muxTargetFor()`, `listEncoders()` |
| touch the preview or A/B | `src/lib/preview.ts` + `src/components/AbPreview.tsx` |
| work on decoding or formats | `src/lib/decode.ts` (native decoders), `src/lib/ffmpeg.ts` (everything else) |
| add an engine | `src/types/hushwing.ts`, `src/lib/models.ts`, `createEngine()` in `src/lib/engine.ts`, then both pipelines |
| add UI or state | `src/store/app.ts` first — the queue and the wizard step are the source of truth |
| change the flow | `src/components/{Stepper,AddStep,EngineStep,RunStep}.tsx`, composed by `src/App.tsx` |
| make it faster | the ffmpeg RAM buffer (§4), then code-splitting the 500 kB main bundle |

## 8. Known limits, and the honest state of the engines

- **`rnnoise` is the real thing now.** Shiguredo's WASM build at 48 kHz, in both pipelines. The
  earlier stand-in (an adaptive gate/expander behind the same id) is gone, not kept as a second
  implementation — `createKernel('rnnoise')` throws, because reaching it means something asked the
  wrong layer to render the model.
- **DeepFilterNet 3 is not implemented.** The option renders disabled rather than pretending.
- **RNNoise is 48 kHz or nothing.** A device that will not give the preview a 48 kHz context gets a
  note and a Web Audio audition instead; the batch render is unaffected.
- **Nothing but local files, on purpose.** Cloud import (Drive/OneDrive) and import-from-URL were
  removed: they added keys, OAuth setup and a first-run decision without improving the core loop of
  dropping files in and watching them clean up.
- **iOS is unproven.** The worklet and the visibility handling exist for it, but the A/B preview has
  not been verified on a physical device, where Safari interrupts `AudioWorklet` differently.
- **First load is ~32 MB** for the ffmpeg core. It is fetched lazily (only once there is work to do)
  and cached by the browser afterwards, but it is the dominant cost of a cold start.
