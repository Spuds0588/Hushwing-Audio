export class OPFSUnavailable extends Error {
  constructor() {
    super(
      'Origin Private File System is not available in this browser. Chrome, Edge, Firefox and Safari 16.4+ support it.'
    )
    this.name = 'OPFSUnavailable'
  }
}

let root: FileSystemDirectoryHandle | null = null

function storageManager(): StorageManager | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.storage
}

export function opfsSupported(): boolean {
  return typeof storageManager()?.getDirectory === 'function'
}

export async function getOPFSRoot(): Promise<FileSystemDirectoryHandle> {
  const storage = storageManager()
  if (!storage?.getDirectory) throw new OPFSUnavailable()

  root = await storage.getDirectory()
  return root
}

export async function ensureRoot(): Promise<FileSystemDirectoryHandle> {
  if (!root) return getOPFSRoot()
  return root
}

type WritableData = string | ArrayBuffer | Uint8Array<ArrayBuffer> | Uint8Array

function normalizePath(path: string): string[] {
  return path
    .trim()
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part.length > 0)
}

async function resolveParent(
  path: string,
  options: { create: boolean }
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const parts = normalizePath(path)
  const name = parts.pop()
  if (!name) throw new Error('A file name is required')

  let current = await ensureRoot()
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: options.create })
  }
  return { dir: current, name }
}

export async function writeDataToOPFS(
  path: string,
  data: WritableData | Blob
): Promise<FileSystemFileHandle> {
  const { dir, name } = await resolveParent(path, { create: true })
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()

  try {
    if (data instanceof Blob) {
      // Blob → writable streams straight to disk in the browser implementation.
      await writable.write(data)
    } else if (typeof data === 'string') {
      await writable.write(data)
    } else {
      await writable.write(data as Uint8Array<ArrayBuffer>)
    }
  } finally {
    await writable.close()
  }

  return file
}

/**
 * Append-only writer for results that are produced in chunks (a streamed WAV,
 * for example). Keeps peak memory flat instead of assembling one giant blob.
 */
export interface OPFSWriter {
  write(data: Uint8Array): Promise<void>
  seek(position: number): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export async function openOPFSWriter(path: string): Promise<OPFSWriter> {
  const { dir, name } = await resolveParent(path, { create: true })
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable({ keepExistingData: false })
  let position = 0
  let closed = false

  return {
    async write(data: Uint8Array) {
      if (closed) throw new Error('OPFS writer is already closed')
      await writable.write(data as unknown as BufferSource)
      position += data.byteLength
    },
    async seek(next: number) {
      if (closed) throw new Error('OPFS writer is already closed')
      await writable.seek(next)
      position = next
    },
    async close() {
      if (closed) return
      closed = true
      await writable.close()
    },
    async abort() {
      if (closed) return
      closed = true
      await writable.abort()
    },
  }
}

export async function readDataFromOPFS(
  path: string,
  options?: { asBlob?: boolean; asText?: boolean }
): Promise<Blob | string | ArrayBuffer | null> {
  const { dir, name } = await resolveParent(path, { create: false })

  let file: FileSystemFileHandle
  try {
    file = await dir.getFileHandle(name)
  } catch {
    return null
  }

  const value = await file.getFile()
  if (options?.asText) return value.text()
  if (options?.asBlob) return value
  return value.arrayBuffer()
}

export async function existsInOPFS(path: string): Promise<boolean> {
  try {
    const { dir, name } = await resolveParent(path, { create: false })
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

export async function removeFromOPFS(path: string): Promise<boolean> {
  try {
    const { dir, name } = await resolveParent(path, { create: false })
    await dir.removeEntry(name, { recursive: false })
    return true
  } catch {
    return false
  }
}

/** Remove several files at once, ignoring the ones that never existed. */
export async function removeManyFromOPFS(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => removeFromOPFS(path).catch(() => false)))
}

export async function listOPFS(prefix: string): Promise<string[]> {
  const parts = normalizePath(prefix)
  let current = await ensureRoot()
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part)
    } catch {
      return []
    }
  }

  const names: string[] = []
  for await (const [name] of (current as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    names.push(parts.concat(name).join('/'))
  }
  return names
}

/** Best-effort storage report for the diagnostics panel. */
export async function opfsUsage(): Promise<{ used: number; quota: number } | null> {
  const storage = storageManager()
  if (!storage?.estimate) return null
  const estimate = await storage.estimate()
  return { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}
