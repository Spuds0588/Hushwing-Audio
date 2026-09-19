# Hushwing Audio: Complete Product Requirements, Architecture, Implementation Guide, and Agent Specs

---

## Document Control & Executive Summary
- **Project Name:** Hushwing Audio (formerly LocalAudioEnhancer.wasm)
- **Target Platform:** GitHub Pages (Static Hosting, PWA, Client-Side Execution)
- **Core Objective:** Provide an open-source, private, zero-cost alternative to cloud-based voice enhancers that runs entirely inside the user's browser via WebAssembly (WASM). Features multi-model selection, batch file processing, direct video file handling, cloud drive import, and native LLM agent compatibility.

---

# SECTION 1: Product Requirements Document (PRD)

## 1. Vision & Background
Cloud-based speech enhancers provide studio-quality voice isolation but require uploading sensitive media files to third-party servers, incur usage costs, and lack customization. **Hushwing Audio** leverages modern browser capabilities (`AudioWorklet`, `WebAssembly`, `SharedArrayBuffer`, and `OPFS`) to process massive audio and video files locally. By allowing users to switch between multiple enhancement engines (RNNoise, DeepFilterNet, and Native Web Audio), Hushwing guarantees absolute privacy while delivering professional acoustic isolation.

## 2. Target Audience & Personas
- **Podcasters & Creators:** Needing zero-cost, high-fidelity vocal enhancement for raw recordings or video clips without installing desktop apps.
- **Journalists & Researchers:** Handling confidential interviews where data privacy laws prohibit cloud file uploads.
- **Autonomous AI Agents (WebMCP):** LLMs operating browsers needing a structured, headless interface to clean audio files as part of automated workflows.

## 3. Core Functional Requirements

### 3.1. Media Ingestion & Video Support (`ffmpeg.wasm`)
- **Supported Formats:** Audio (`.wav`, `.mp3`, `.m4a`, `.flac`, `.ogg`) and Video (`.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`).
- **Extraction Pipeline:** `ffmpeg.wasm` runs locally in a Web Worker to extract audio into a lossless PCM WAV stream.
- **Remuxing / Export:** After enhancement, users can export the isolated audio or the original video file with the audio track replaced/muxed back in sync.
- **Resampling:** Explicit down-sampling to 16kHz for model inference and up-sampling back to original sample rates (e.g., 48kHz) to prevent video sync drift ("chipmunking").

### 3.2. Multi-Library Model Selection Engine
1. **RNNoise (WASM):** Ultra-lightweight, near-zero latency, best for low-powered devices.
2. **DeepFilterNet3 (WASM):** Studio-grade neural suppression; handles complex non-stationary background noise (Phase 2).
3. **Native Web Audio Chain:** Zero-weight chain featuring a high-pass filter, multi-band expander/gate, and dynamic compressor.

### 3.3. Batch Processing, Queue Manager & Storage
- **Queue System:** Concurrent worker processing (locked to 1 thread initially to prevent browser memory exhaustion on iOS/Mobile).
- **OPFS Storage:** Origin Private File System handles multi-gigabyte video files directly from disk to bypass RAM limitations.
- **Export All:** Download processed files individually or as a `.zip` archive via `JSZip`.

### 3.4. Cloud Drive Import (Import-Only)
- **Google Drive & OneDrive Integration:** Users can authenticate via official SDKs to import files directly into the Hushwing queue. 
- *Constraint:* To prevent chunking/CORS proxy nightmares, this is strictly an import-to-local feature. Enhanced files are downloaded to the user's local device, not pushed back to the cloud.

### 3.5. Interactive A/B Testing & Diagnostics
- **Real-time Preview:** Real-time playback toggle using `AudioWorklet` to preview model parameters before executing a massive batch job.
- **Headless Error Diagnostics:** In-memory rolling log console capturing FFmpeg outputs and WASM traces. Users can download a `.txt` debug log if a job crashes.

---

# SECTION 2: Architecture & Implementation Guide

## 1. High-Level Architecture Diagram

```text
+---------------------------------------------------------------------------------------+
|                                  Hushwing Audio UI                                    |
| [Drag & Drop] [Cloud Pickers] [Model Selector] [Batch Queue] [A/B Waveform Player]    |
+-------------------------------------------+-------------------------------------------+
                                            |
                         (UI Thread / WebWorker RPC Bridge)
                                            |
         +----------------------------------+----------------------------------+
         |                                                                     |
+--------v---------+    +---------------------------------------+    +---------v--------+
| Diagnostics Log  |    |             STORAGE LAYER             |    |  Audio Preview   |
| (Zustand Store)  |    |  Origin Private File System (OPFS)    |    | (AudioWorklet)   |
+------------------+    |  Handles 4K Video & 30MB AI Models    |    +------------------+
                        +-------------------+-------------------+
                                            |
         +----------------------------------+----------------------------------+
         |                                                                     |
+--------v---------+                                                 +---------v--------+
|  FFmpeg Worker   |                                                 | AI Audio Worker  |
| - ffmpeg.wasm    |                                                 | - RNNoise        |
| - Extract Audio  |                                                 | - Web Audio API  |
| - Mux back to MP4|                                                 | - Batch render   |
+------------------+                                                 +------------------+
```

## 2. Core Architectural Solutions

### 2.1. The COI & Cloud SDK Collision
To use `SharedArrayBuffer` for `ffmpeg.wasm`, we require Cross-Origin Isolation. However, strict COI blocks Google/OneDrive iframe SDKs.
- **Implementation:** We will use `coi-serviceworker` configured to inject `Cross-Origin-Embedder-Policy: credentialless` and `Cross-Origin-Opener-Policy: same-origin`. This grants SAB access while allowing authenticated external SDK iframes to load safely.

### 2.2. OPFS (Origin Private File System) vs IndexedDB
Handling gigabyte files via `IndexedDB` bloats browser RAM and causes tab crashes.
- **Implementation:** Implement the File System Access API. When a file is dropped or downloaded from Google Drive, we write it as a stream directly to OPFS. FFmpeg and AI workers will read/write file chunks synchronously from OPFS virtual paths, keeping RAM usage perfectly flat regardless of file size.

### 2.3. Dual Audio Pipelines
- **Pipeline A (Render):** Uses standard Web Workers to process offline chunks as fast as the CPU allows.
- **Pipeline B (Preview):** Uses an `AudioWorkletNode` tied to the DOM `AudioContext`.
- **Implementation:** Abstract the underlying WASM processing logic into a headless class (`HushwingEngine`) that can be instantiated dynamically in either context.

### 2.4. Memory Management (The WASM Trap)
C++/Rust WASM modules do not have JS garbage collection.
- **Implementation:** Every processing function must include explicit `try/finally` blocks that trigger `.free()` or `.delete()` on the WASM pointers. Page Visibility API will pause processing if the tab is backgrounded on iOS to prevent silent memory terminations.

---

# SECTION 3: Developer Task List & Roadmap

## Phase 1: Infrastructure, Storage & Security
- [ ] **Task 1.1:** Scaffold Vite + React + TypeScript + Tailwind project with GitHub Pages base path routing.
- [ ] **Task 1.2:** Integrate `coi-serviceworker` with `COEP: credentialless` configurations.
- [ ] **Task 1.3:** Build OPFS wrapper utility (`lib/opfs.ts`) for streaming large files to and from the local virtual file system.
- [ ] **Task 1.4:** Implement headless diagnostic logger context (`lib/logger.ts`) with `.txt` export functionality.

## Phase 2: Media Pipeline & FFmpeg
- [ ] **Task 2.1:** Integrate `ffmpeg.wasm` (v0.12+) worker utilizing OPFS paths.
- [ ] **Task 2.2:** Build extraction pipeline: Video -> 16kHz Mono PCM WAV.
- [ ] **Task 2.3:** Build muxing pipeline: Enhanced WAV + Original Video -> Resampled Audio Muxed Video.
- [ ] **Task 2.4:** Implement `JSZip` for batch archive downloads.

## Phase 3: The Hushwing AI Engines
- [ ] **Task 3.1:** Implement Native Web Audio fallback engine (EQ, Multiband Compressor, Noise Gate).
- [ ] **Task 3.2:** Integrate RNNoise WASM. Create the agnostic `HushwingEngine` class.
- [ ] **Task 3.3:** Implement Web Worker wrapper for batch processing (Pipeline A).
- [ ] **Task 3.4:** Implement AudioWorklet wrapper for real-time A/B previews (Pipeline B).

## Phase 4: UI, Cloud, & Agents
- [ ] **Task 4.1:** Build drag-and-drop zone and unified Job Queue UI (progress bars, status, logs).
- [ ] **Task 4.2:** Integrate Google Drive Picker API (OAuth flow, fetch Blob, stream to OPFS).
- [ ] **Task 4.3:** Integrate Microsoft OneDrive Picker API.
- [ ] **Task 4.4:** Implement semantic DOM hooks and `window.HushwingAPI` (See AGENTS.md specs).

---

# SECTION 4: AGENTS.md (WebMCP & LLM Integration Spec)

## Overview
Hushwing Audio is designed to be fully controllable by autonomous AI agents (such as Claude via Computer Use, or WebMCP-enabled browser extensions) without requiring visual interpretation of the DOM. 

Agents can interact with Hushwing either via the injected Global API or via Semantic DOM Hooks.

## 1. Global API (`window.HushwingAPI`)
For agents capable of executing JavaScript in the browser console, Hushwing exposes a declarative headless API.

```javascript
// Check available enhancement models
const models = await window.HushwingAPI.getModels();
// Returns: ['rnnoise', 'webaudio', 'deepfilternet']

// Process a file programmatically
const fileBlob = /* obtain blob from agent local filesystem */;
const jobPromise = window.HushwingAPI.processMedia({
    file: fileBlob,
    model: 'rnnoise',
    outputFormat: 'wav' // or 'video' if input is mp4
});

// Await the enhanced file
const enhancedBlob = await jobPromise;
```

## 2. Semantic DOM Hooks
For agents relying on vision or standard DOM interaction protocols, Hushwing maintains strict semantic HTML tagging.

### File Uploading
- **Selector:** `input[data-mcp-action="upload"]`
- **Action:** Agents should target this hidden file input to push files into the queue.

### Model Selection
- **Selector:** `select[data-mcp-target="model-selector"]`
- **Action:** Standard HTML `<select>`. Set value to `"rnnoise"` or `"webaudio"`.

### Queue Control
- **Selector:** `button[data-mcp-action="process-queue"]`
- **Action:** Click this button to begin processing all queued items.

### Job Status Monitoring
Hushwing uses ARIA live regions and data attributes to track state. Agents should poll the DOM for job status.
- **Pending:** `div[data-job-id="<uuid>"][data-status="queued"]`
- **Processing:** `div[data-job-id="<uuid>"][data-status="processing"]`
- **Success:** `div[data-job-id="<uuid>"][data-status="completed"]`
- **Download Link:** `a[data-mcp-action="download-result"][data-job-id="<uuid>"]`

## 3. URL Parameter Auto-Execution
Agents can initialize the app in specific states by appending query parameters.
- `?model=rnnoise` -> Pre-selects the RNNoise model.
- `?autostart=true` -> Automatically begins processing as soon as a file is dropped or selected.
- `?debug=true` -> Exposes visual diagnostic logs on the UI for easier agent parsing. 

## 4. MCP.json Schema (WebMCP Discovery)
Hushwing hosts an `mcp.json` file at the root of the repository detailing these capabilities, allowing WebMCP-compliant clients to auto-discover tool functions upon page load.