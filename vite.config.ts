import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Copy the ffmpeg.wasm core out of `node_modules` into the built site.
 *
 * That keeps production fully self-hosted — the app then fetches only its own
 * origin (which is what a privacy-first tool should do) and works without a
 * third-party CDN. `src/lib/ffmpeg.ts` probes for these files and falls back to
 * unpkg in dev, where they do not exist.
 */
function emitFFmpegCore(): Plugin {
  // Must be the ESM build: @ffmpeg/ffmpeg loads the core from a module worker.
  const source = join(root, 'node_modules/@ffmpeg/core/dist/esm')
  const files = ['ffmpeg-core.js', 'ffmpeg-core.wasm']

  return {
    name: 'hushwing:emit-ffmpeg-core',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir ?? join(root, 'dist')
      if (!existsSync(join(source, files[0]))) return

      const target = join(outDir, 'ffmpeg-core')
      mkdirSync(target, { recursive: true })
      for (const file of files) {
        copyFileSync(join(source, file), join(target, file))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), emitFFmpegCore()],
  // Relative assets: one build works at the preview root and at
  // https://<user>.github.io/<repo>/ without a rebuild.
  base: './',
  server: {
    // Do not enable HMR; the Freebuff platform manages the preview process.
    hmr: false,
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 5173,
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 4173,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  worker: {
    format: 'es',
  },
})
