/**
 * Google sign-in, Drive file picking and Sheets reads, all from the browser.
 *
 * Access tokens stay in this tab's memory and are never sent to our server. The app asks only for
 * the drive.file scope, so it can read just the spreadsheets someone picks in the Google Picker.
 */
import type { AppConfig } from './types'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

const scripts = new Map<string, Promise<void>>()

function loadScript(src: string) {
  let promise = scripts.get(src)
  if (!promise) {
    promise = new Promise<void>((resolve, reject) => {
      const el = document.createElement('script')
      el.src = src
      el.async = true
      el.onload = () => resolve()
      el.onerror = () => {
        scripts.delete(src)
        reject(new Error('Couldn’t load Google’s sign-in. Check your connection and try again.'))
      }
      document.head.appendChild(el)
    })
    scripts.set(src, promise)
  }
  return promise
}

const loadIdentity = () => loadScript('https://accounts.google.com/gsi/client')

let pickerReady: Promise<void> | null = null
function loadPicker() {
  pickerReady ??= loadScript('https://apis.google.com/js/api.js').then(
    () => new Promise<void>((resolve) => gapi.load('picker', () => resolve())),
  )
  return pickerReady
}

export async function renderSignInButton(el: HTMLElement, config: AppConfig, onCredential: (credential: string) => void) {
  await loadIdentity()
  google.accounts.id.initialize({
    client_id: config.google_client_id,
    callback: (response) => onCredential(response.credential),
    hd: config.allowed_domain,
    ux_mode: 'popup',
  } as google.accounts.id.IdConfiguration)
  google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' })
}

export function signOutOfGoogle() {
  token = null
  if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect()
}

let token: { value: string; expiresAt: number } | null = null

/** Opens Google's consent popup the first time; call it from a click so the popup isn't blocked. */
export async function getAccessToken(config: AppConfig): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value
  await loadIdentity()
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: config.google_client_id,
      scope: SHEETS_SCOPE,
      hd: config.allowed_domain,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || 'Google didn’t grant access to Sheets.'))
          return
        }
        token = { value: response.access_token, expiresAt: Date.now() + Number(response.expires_in) * 1000 }
        resolve(response.access_token)
      },
      error_callback: (error) =>
        reject(new Error(error.type === 'popup_closed' ? 'The Google window was closed.' : 'Google sign-in failed. Allow pop-ups for this site and try again.')),
    })
    client.requestAccessToken({ prompt: '' })
  })
}

export type PickedFile = { id: string; name: string }

/** Google's own file picker, limited to spreadsheets. With `onlyFileId`, it shows just that file (to re-grant access). */
export async function pickSpreadsheet(config: AppConfig, accessToken: string, onlyFileId?: string): Promise<PickedFile | null> {
  await loadPicker()
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(google.picker.DocsViewMode.LIST)
    if (onlyFileId) (view as unknown as { setFileIds(ids: string): void }).setFileIds(onlyFileId)
    const builder = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.google_api_key)
      .setAppId(config.google_app_id)
      .setTitle(onlyFileId ? 'Allow access to this spreadsheet' : 'Choose the sign up spreadsheet')
      .setCallback((data: google.picker.ResponseObject) => {
        const action = data[google.picker.Response.ACTION]
        if (action === google.picker.Action.PICKED) {
          const doc = data[google.picker.Response.DOCUMENTS]![0]
          resolve({ id: doc[google.picker.Document.ID], name: doc[google.picker.Document.NAME] ?? 'Spreadsheet' })
        } else if (action === google.picker.Action.CANCEL) {
          resolve(null)
        }
      })
    if (!onlyFileId) {
      builder.addView(new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setEnableDrives(true))
      builder.enableFeature(google.picker.Feature.SUPPORT_DRIVES)
    }
    builder.build().setVisible(true)
  })
}

/** The app can't see this spreadsheet yet: the person has to pick it once in the Picker. */
export class NoAccessError extends Error {}

async function sheetsGet<T>(config: AppConfig, path: string, retried = false): Promise<T> {
  const accessToken = await getAccessToken(config)
  const res = await fetch(`${SHEETS_API}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (res.status === 401 && !retried) {
    token = null
    return sheetsGet(config, path, true)
  }
  if (res.status === 403 || res.status === 404) throw new NoAccessError('This app doesn’t have access to that spreadsheet yet.')
  if (!res.ok) throw new Error(`Google Sheets returned an error (${res.status}).`)
  return res.json()
}

export type Tab = { id: number; title: string; rows: number }

export async function getSpreadsheet(config: AppConfig, spreadsheetId: string): Promise<{ title: string; tabs: Tab[] }> {
  type Meta = {
    properties: { title: string }
    sheets: { properties: { sheetId: number; title: string; hidden?: boolean; gridProperties?: { rowCount?: number } } }[]
  }
  const fields = 'properties.title,sheets.properties(sheetId,title,hidden,gridProperties.rowCount)'
  const meta = await sheetsGet<Meta>(config, `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`)
  return {
    title: meta.properties.title,
    tabs: meta.sheets
      .filter((s) => !s.properties.hidden)
      .map((s) => ({ id: s.properties.sheetId, title: s.properties.title, rows: s.properties.gridProperties?.rowCount ?? 0 })),
  }
}

export async function getTabValues(config: AppConfig, spreadsheetId: string, tabTitle: string): Promise<string[][]> {
  const range = `'${tabTitle.replace(/'/g, "''")}'`
  const data = await sheetsGet<{ values?: string[][] }>(
    config,
    `${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
  )
  return data.values ?? []
}

/** Reads a tab by its id, so a renamed tab still re-syncs. */
export async function readTab(config: AppConfig, spreadsheetId: string, tabId: number) {
  const { title, tabs } = await getSpreadsheet(config, spreadsheetId)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) throw new Error('That tab no longer exists in the spreadsheet.')
  return { spreadsheetTitle: title, tabTitle: tab.title, values: await getTabValues(config, spreadsheetId, tab.title) }
}
