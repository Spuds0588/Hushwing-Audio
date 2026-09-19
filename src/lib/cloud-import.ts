import { enqueueFile } from './pipeline'
import { logger } from './logger'
import type { ModelId, OutputFormat } from '../types/hushwing'

export interface CloudImportOptions {
  model: ModelId
  outputFormat: OutputFormat
}

/**
 * Import any CORS-accessible media URL straight into the queue. No SDK, no
 * credentials — this is the import path that always works.
 */
export async function importFromUrl(
  url: string,
  { model, outputFormat }: CloudImportOptions
): Promise<string> {
  logger.info(`Importing from URL: ${url}`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Import failed: HTTP ${response.status} ${response.statusText}`)
  }

  const blob = await response.blob()
  const name = decodeURIComponent(
    new URL(url, window.location.href).pathname.split('/').pop() || 'imported-media'
  )
  return enqueueBlob(blob, name, { model, outputFormat })
}

function enqueueBlob(
  blob: Blob,
  name: string,
  { model, outputFormat }: CloudImportOptions
): string {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' })
  const job = enqueueFile(file, model, outputFormat)
  logger.info(`Imported ${name} (${blob.size} bytes) as job ${job.id}`)
  return job.id
}

export const DRIVE_HELP =
  'Google Drive import needs an OAuth client ID and a Picker API key. Add ' +
  'VITE_GOOGLE_CLIENT_ID and VITE_GOOGLE_API_KEY in Settings → Environment, ' +
  'then reload — enhanced files are always saved to your device, never back to Drive.'

export const ONEDRIVE_HELP =
  'OneDrive import needs an Azure app registration with a redirect URI for this ' +
  'origin. Add VITE_ONEDRIVE_CLIENT_ID in Settings → Environment, then reload.'

/** Import-only, by PRD constraint: results are never pushed back to the cloud. */
export function cloudImportStatus() {
  return {
    url: true,
    drive: Boolean(import.meta.env.VITE_GOOGLE_CLIENT_ID),
    oneDrive: Boolean(import.meta.env.VITE_ONEDRIVE_CLIENT_ID),
  }
}

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
const DRIVE_MIME_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/flac',
  'audio/ogg',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]

const scriptPromises = new Map<string, Promise<void>>()

function loadScript(src: string): Promise<void> {
  const existing = scriptPromises.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Could not load ${src}`))
    document.head.appendChild(script)
  })

  scriptPromises.set(src, promise)
  return promise
}

/* ---------------------------------------------------------------- Google --- */

interface GooglePickerDoc {
  id: string
  name?: string
}

interface GooglePickerResponse {
  action: string
  docs?: GooglePickerDoc[]
}

interface GoogleNamespace {
  accounts?: {
    oauth2?: {
      initTokenClient(config: {
        client_id: string
        scope: string
        callback: (response: { access_token?: string; error?: string }) => void
        error_callback?: (error: { message?: string }) => void
      }): { requestAccessToken(): void }
    }
  }
  picker?: {
    DocsView: new (viewId?: string) => {
      setIncludeFolders(value: boolean): unknown
      setSelectFolderEnabled(value: boolean): unknown
      setMimeTypes(value: string): unknown
    }
    PickerBuilder: new () => {
      setDeveloperKey(key: string): unknown
      setOAuthToken(token: string): unknown
      addView(view: unknown): unknown
      setCallback(callback: (data: GooglePickerResponse) => void): unknown
      setTitle(title: string): unknown
      build(): { setVisible(value: boolean): void }
    }
    ViewId: { DOCS: string }
    Action: { PICKED: string; CANCEL: string }
  }
}

function googleNamespace(): GoogleNamespace {
  return (window as unknown as { google?: GoogleNamespace }).google ?? {}
}

function requestGoogleToken(clientId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const oauth = googleNamespace().accounts?.oauth2
    if (!oauth) {
      reject(new Error('Google sign-in could not be loaded'))
      return
    }

    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) resolve(response.access_token)
        else reject(new Error(response.error ?? 'Google sign-in was cancelled'))
      },
      error_callback: (error) => reject(new Error(error.message ?? 'Google sign-in failed')),
    })

    client.requestAccessToken()
  })
}

async function openDrivePicker(apiKey: string, accessToken: string): Promise<GooglePickerDoc | null> {
  await loadScript('https://apis.google.com/js/api.js')

  await new Promise<void>((resolve) => {
    const gapi = (window as unknown as { gapi?: { load(name: string, options: { callback: () => void }): void } })
      .gapi
    if (!gapi) throw new Error('The Google Picker loader could not be loaded')
    gapi.load('picker', { callback: resolve })
  })

  const picker = googleNamespace().picker
  if (!picker) throw new Error('The Google Picker is unavailable for this API key')

  return new Promise<GooglePickerDoc | null>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setIncludeFolders(false)
    view.setSelectFolderEnabled(false)
    view.setMimeTypes(DRIVE_MIME_TYPES.join(','))

    const builder = new picker.PickerBuilder()
    builder.setDeveloperKey(apiKey)
    builder.setOAuthToken(accessToken)
    builder.setTitle('Pick a recording from Google Drive')
    builder.setCallback((data) => {
      if (data.action === picker.Action.PICKED) resolve(data.docs?.[0] ?? null)
      else if (data.action === picker.Action.CANCEL) resolve(null)
    })
    builder.addView(view)
    builder.build().setVisible(true)
  })
}

export async function pickFromGoogleDrive(options: CloudImportOptions): Promise<string | null> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
  const apiKey = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined

  if (!clientId) throw new Error(DRIVE_HELP)
  if (!apiKey) {
    throw new Error(
      'Add VITE_GOOGLE_API_KEY (a Drive Picker API key) to open the Drive file picker.'
    )
  }

  await loadScript('https://accounts.google.com/gsi/client')
  const accessToken = await requestGoogleToken(clientId)
  const doc = await openDrivePicker(apiKey, accessToken)
  if (!doc) return null

  logger.info(`Drive picker returned ${doc.name ?? doc.id}`)

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  if (!response.ok) throw new Error(`Drive download failed: HTTP ${response.status}`)

  const blob = await response.blob()
  return enqueueBlob(blob, doc.name ?? `drive-${doc.id}`, options)
}

/* ------------------------------------------------------------- OneDrive --- */

interface OneDriveFile {
  name?: string
  '@microsoft.graph.downloadUrl'?: string
  '@content.downloadUrl'?: string
}

interface OneDriveNamespace {
  open(config: {
    clientId: string
    action: 'query'
    multiSelect: boolean
    viewType: 'files'
    advanced?: Record<string, unknown>
    success: (response: { value?: OneDriveFile[] }) => void
    cancel: () => void
    error: (error: { message?: string }) => void
  }): void
}

export async function pickFromOneDrive(options: CloudImportOptions): Promise<string | null> {
  const clientId = import.meta.env.VITE_ONEDRIVE_CLIENT_ID as string | undefined
  if (!clientId) throw new Error(ONEDRIVE_HELP)

  await loadScript('https://js.live.net/v7.2/OneDrive.js')

  const oneDrive = (window as unknown as { OneDrive?: OneDriveNamespace }).OneDrive
  if (!oneDrive) throw new Error('The OneDrive picker script did not load')

  const files = await new Promise<OneDriveFile[]>((resolve, reject) => {
    oneDrive.open({
      clientId,
      action: 'query',
      multiSelect: false,
      viewType: 'files',
      advanced: { filter: 'audio,video' },
      success: (response) => resolve(response.value ?? []),
      cancel: () => resolve([]),
      error: (error) => reject(new Error(error?.message ?? 'The OneDrive picker failed')),
    })
  })

  const file = files[0]
  if (!file) return null

  const downloadUrl = file['@microsoft.graph.downloadUrl'] ?? file['@content.downloadUrl']
  if (!downloadUrl) {
    throw new Error('OneDrive did not return a download URL for that file')
  }

  const response = await fetch(downloadUrl)
  if (!response.ok) throw new Error(`OneDrive download failed: HTTP ${response.status}`)

  const blob = await response.blob()
  return enqueueBlob(blob, file.name ?? 'onedrive-file', options)
}
