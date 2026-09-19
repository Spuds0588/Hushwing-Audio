import type { LogEntry } from '../types/hushwing'

const MAX_LOGS = 250

let entries: LogEntry[] = []
let snapshot: readonly LogEntry[] = []
let dirty = true
let enabled = true

const listeners = new Set<() => void>()

export function setLoggerEnabled(value: boolean) {
  enabled = value
}

export function isLoggerEnabled(): boolean {
  return enabled
}

function append(tag: LogEntry['tag'], message: string) {
  entries.push({ time: Date.now(), tag, message })
  if (entries.length > MAX_LOGS) {
    entries = entries.slice(entries.length - MAX_LOGS)
  }
  dirty = true
  listeners.forEach((listener) => listener())
}

/**
 * Bounded, synchronous diagnostic logger.
 * Captures ffmpeg output and engine traces so a crashed job can be reported.
 */
export const logger = {
  info(message: string) {
    if (enabled) append('info', message)
  },
  warn(message: string) {
    if (enabled) append('warn', message)
  },
  error(message: string) {
    if (enabled) append('error', message)
  },
  debug(message: string) {
    if (enabled) append('debug', message)
  },
}

/** Stable snapshot for `useSyncExternalStore` — rebuilt only when logs change. */
export function getLogsSnapshot(): readonly LogEntry[] {
  if (dirty) {
    snapshot = entries.slice()
    dirty = false
  }
  return snapshot
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getLogs(): readonly LogEntry[] {
  return getLogsSnapshot()
}

export function exportLogs(): string {
  const header = [
    'Hushwing — Diagnostic Log',
    `Exported: ${new Date().toISOString()}`,
    `User agent: ${typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}`,
    '--------------------------------------------------',
  ].join('\n')

  const rows = getLogsSnapshot().map(
    (entry) =>
      `[${new Date(entry.time).toISOString()}] [${entry.tag.toUpperCase().padEnd(5)}] ${entry.message}`
  )

  return [header, '', ...rows].join('\n')
}

export function clearLogs() {
  entries = []
  dirty = true
  listeners.forEach((listener) => listener())
}

export function downloadLogs() {
  downloadTextFile(exportLogs(), `hushwing-debug-${Date.now()}.txt`)
}

export function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
