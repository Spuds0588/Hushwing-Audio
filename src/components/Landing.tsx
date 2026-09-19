import { motion } from 'framer-motion'
import { MODEL_SPECS } from '../lib/models'
import { SUPPORTED_AUDIO, SUPPORTED_VIDEO } from '../types/hushwing'
import { Badge, Button, Card } from './ui'

const FEATURES = [
  {
    title: 'Nothing leaves the tab',
    body: 'Files are read through the File System API and processed in-process. There is no upload step, no queue on a server, and no telemetry to opt out of.',
  },
  {
    title: 'Video-aware by default',
    body: 'Drop a .mov or .mkv and Hushwing extracts the 16 kHz track, enhances it, then muxes it back into the original video without re-encoding the picture.',
  },
  {
    title: 'Choose your engine',
    body: 'A zero-download Web Audio chain for quick cleanups, or an adaptive noise-floor gate for hiss and hum. DeepFilterNet 3 is a drop-in slot once its weights ship.',
  },
  {
    title: 'Batch without a meter',
    body: 'Queue a folder and walk away: one job runs at a time, results stream back into Origin Private File System storage, and you can export the lot as a .zip.',
  },
  {
    title: 'A/B before you commit',
    body: 'An AudioWorklet preview lets you flip between the untouched and enhanced signal mid-playback, with the exact DSP profile the batch render uses.',
  },
  {
    title: 'Built to be driven by agents',
    body: 'window.HushwingAPI, stable data-mcp-* selectors and ?model= / ?autostart= / ?debug= parameters give MCP clients a headless surface.',
  },
]

const STEPS = [
  {
    step: '01',
    title: 'Drop or import',
    body: 'Local files, a direct link, or a Google Drive / OneDrive pick. Everything is copied into OPFS first so the queue never depends on RAM.',
  },
  {
    step: '02',
    title: 'Pick an engine',
    body: 'ffmpeg.wasm normalises the source to 16 kHz mono, then the selected kernel runs in a Web Worker while the UI stays responsive.',
  },
  {
    step: '03',
    title: 'Export anywhere',
    body: 'Resampled to 48 kHz to keep video in sync, streamed back to disk, and downloadable one file at a time or as a single archive.',
  },
]

const PRIVACY_ROWS = [
  { label: 'Where the audio goes', cloud: 'Your cloud bucket', hushwing: 'Nowhere' },
  { label: 'Cost per minute', cloud: 'Metered API calls', hushwing: 'Zero' },
  { label: 'Account required', cloud: 'Yes', hushwing: 'No' },
  { label: 'Works offline', cloud: 'No', hushwing: 'After first load' },
  { label: 'Model choice', cloud: 'Vendor decides', hushwing: 'You do' },
]

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
}

const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: 'easeOut' as const } },
}

export function Landing({ onStart }: { onStart: () => void }) {
  return (
    <main className="relative overflow-hidden">
      <BackdropGlow />

      <section className="relative mx-auto max-w-6xl px-4 pt-16 pb-20 sm:px-6 sm:pt-24">
        <motion.div initial="hidden" animate="show" variants={container}>
          <motion.div variants={item}>
            <Badge variant="success" className="px-3 py-1 text-[11px]">
              100% client-side · WebAssembly · open source
            </Badge>
          </motion.div>

          <motion.h1
            variants={item}
            className="mt-6 max-w-4xl text-4xl leading-[1.05] font-extrabold tracking-tight sm:text-6xl"
          >
            Clean up any recording
            <span className="block bg-gradient-to-r from-[var(--color-accent)] to-[var(--color-accent-2)] bg-clip-text text-transparent">
              without uploading a single byte.
            </span>
          </motion.h1>

          <motion.p
            variants={item}
            className="mt-6 max-w-2xl text-lg leading-relaxed text-[var(--color-ink-2)]"
          >
            Hushwing Audio is a private alternative to cloud voice enhancers. It runs ffmpeg.wasm,
            a Web Audio chain and an adaptive noise gate entirely inside this browser tab — so
            interviews, podcast takes and confidential field recordings never leave your machine.
          </motion.p>

          <motion.div variants={item} className="mt-9 flex flex-wrap items-center gap-4">
            <Button size="lg" onClick={onStart} data-mcp-action="open-studio">
              Open the studio
            </Button>
            <a
              href="#how"
              className="inline-flex h-12 items-center rounded-xl border border-border px-6 text-base text-[var(--color-ink-1)] transition-colors hover:bg-[var(--color-surface-2)]"
            >
              See how it works
            </a>
          </motion.div>

          <motion.dl
            variants={item}
            className="mt-12 grid max-w-3xl grid-cols-2 gap-6 border-t border-border pt-6 sm:grid-cols-4"
          >
            {[
              { value: '0', label: 'bytes uploaded' },
              { value: '2', label: 'engines shipped' },
              { value: '10', label: 'formats ingested' },
              { value: '48 kHz', label: 'delivery rate' },
            ].map((stat) => (
              <div key={stat.label}>
                <dt className="text-2xl font-semibold text-[var(--color-accent)]">{stat.value}</dt>
                <dd className="mt-1 text-xs tracking-wide text-[var(--color-ink-muted)] uppercase">
                  {stat.label}
                </dd>
              </div>
            ))}
          </motion.dl>
        </motion.div>
      </section>

      <section className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, index) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.4, delay: index * 0.04 }}
            >
              <Card className="h-full bg-[var(--color-surface-1)]/70 transition-colors hover:bg-[var(--color-surface-1)]">
                <h3 className="text-base font-semibold text-[var(--color-ink-0)]">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-muted)]">
                  {feature.body}
                </p>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section id="how" className="relative border-y border-border bg-[var(--color-surface-1)]/40">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Three moves, all local
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-[var(--color-ink-muted)]">
            The pipeline mirrors the architecture in <code>PRD-Hushwing.md</code>: OPFS for storage,
            a worker for rendering, and a worklet for live monitoring.
          </p>

          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((entry, index) => (
              <motion.div
                key={entry.step}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.4, delay: index * 0.06 }}
                className="relative rounded-2xl border border-border bg-[var(--color-surface-0)]/70 p-6"
              >
                <span className="font-mono text-xs text-[var(--color-accent)]">{entry.step}</span>
                <h3 className="mt-3 text-lg font-semibold">{entry.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-muted)]">
                  {entry.body}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Engines you can inspect</h2>
            <p className="mt-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
              Every engine implements the same <code>{'{ process(pcm, sampleRate) }'}</code> contract,
              so the same code renders a batch job and drives the live preview. Nothing is labelled
              as a model it is not.
            </p>

            <p className="mt-6 text-xs tracking-wide text-[var(--color-ink-muted)] uppercase">
              Accepts {SUPPORTED_AUDIO.map((spec) => spec.name).join(' · ')} ·{' '}
              {SUPPORTED_VIDEO.map((spec) => spec.name).join(' · ')}
            </p>
          </div>

          <div className="flex flex-col gap-4">
            {MODEL_SPECS.map((spec) => (
              <div
                key={spec.id}
                className="rounded-2xl border border-border bg-[var(--color-surface-1)]/70 p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-[var(--color-ink-0)]">{spec.label}</h3>
                  <Badge variant={spec.ready ? 'success' : 'default'}>
                    {spec.ready ? 'ready' : 'planned'}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--color-ink-muted)]">{spec.description}</p>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
                  {spec.implementation}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="overflow-hidden rounded-2xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-[var(--color-surface-1)]">
              <tr>
                <th className="px-5 py-3 font-medium text-[var(--color-ink-muted)]">&nbsp;</th>
                <th className="px-5 py-3 font-medium text-[var(--color-ink-muted)]">
                  Cloud enhancer
                </th>
                <th className="px-5 py-3 font-semibold text-[var(--color-accent)]">Hushwing Audio</th>
              </tr>
            </thead>
            <tbody>
              {PRIVACY_ROWS.map((row) => (
                <tr key={row.label} className="border-t border-border">
                  <td className="px-5 py-3 text-[var(--color-ink-1)]">{row.label}</td>
                  <td className="px-5 py-3 text-[var(--color-ink-muted)]">{row.cloud}</td>
                  <td className="px-5 py-3 font-medium text-[var(--color-ink-0)]">{row.hushwing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-6 rounded-2xl border border-border bg-[var(--color-surface-1)]/70 p-8 sm:flex-row sm:items-center">
          <div>
            <h3 className="text-xl font-semibold">Ready when you are</h3>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              No account, no quota. Drop a file and watch the queue work.
            </p>
          </div>
          <Button size="lg" onClick={onStart}>
            Start enhancing
          </Button>
        </div>
      </section>
    </main>
  )
}

function BackdropGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[var(--color-accent)]/10 blur-3xl" />
      <div className="absolute top-40 -right-32 h-[360px] w-[360px] rounded-full bg-[var(--color-warm)]/5 blur-3xl" />
      <div
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            'linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black, transparent 70%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black, transparent 70%)',
        }}
      />
    </div>
  )
}
