/**
 * Google sign-in, Drive file picking and Sheets reads, all from the browser.
 *
 * Access tokens stay in this tab (memory and sessionStorage, so a reload doesn't need Google's popup
 * again) and are never sent to our server. The app asks only for the drive.file scope, so it can
 * read (and tick attendance in) just the spreadsheets someone picks in the Google Picker.
 */
import { checkInTabTitle, type CheckInLayout } from './checkInTab'
import { parseSheet, type FieldMap } from './sheetParser'
import { isDatabaseTab } from './studentDatabase'
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
  setToken(null)
  if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect()
}

type Token = { value: string; expiresAt: number }
const TOKEN_KEY = 'google-sheets-token'

let token: Token | null = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as Token | null
  } catch {
    return null
  }
})()

function setToken(next: Token | null) {
  token = next
  try {
    if (next) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(next))
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage blocked: the token just lives in memory.
  }
}

/** Google needs its popup to hand over a token, and that popup has to come from a click. */
export class NeedsSignInError extends Error {}

/**
 * Opens Google's consent popup the first time; call it from a click so the popup isn't blocked.
 * With `interactive: false` it never opens the popup, and throws NeedsSignInError instead.
 */
export async function getAccessToken(config: AppConfig, { interactive = true } = {}): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value
  if (!interactive) throw new NeedsSignInError('Sign in to Google to write attendance to the sheet.')
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
        setToken({ value: response.access_token, expiresAt: Date.now() + Number(response.expires_in) * 1000 })
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

async function sheetsFetch<T>(config: AppConfig, path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const accessToken = await getAccessToken(config)
  const res = await fetch(`${SHEETS_API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  })
  if (res.status === 401 && !retried) {
    setToken(null)
    return sheetsFetch(config, path, init, true)
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
  const meta = await sheetsFetch<Meta>(config, `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`)
  return {
    title: meta.properties.title,
    tabs: meta.sheets
      .filter((s) => !s.properties.hidden)
      .map((s) => ({ id: s.properties.sheetId, title: s.properties.title, rows: s.properties.gridProperties?.rowCount ?? 0 })),
  }
}

export async function getTabValues(config: AppConfig, spreadsheetId: string, tabTitle: string): Promise<string[][]> {
  const range = `'${tabTitle.replace(/'/g, "''")}'`
  const data = await sheetsFetch<{ values?: string[][] }>(
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
  return { spreadsheetTitle: title, tabTitle: tab.title, tabs, values: await getTabValues(config, spreadsheetId, tab.title) }
}

/** The spreadsheet's "Student Database" tab, if it has one other than `skipTabId`. */
export async function readDatabaseTab(config: AppConfig, spreadsheetId: string, tabs: Tab[], skipTabId: number) {
  const tab = tabs.find((t) => t.id !== skipTabId && isDatabaseTab(t.title))
  return tab ? getTabValues(config, spreadsheetId, tab.title) : null
}

/** Writes text into cells of one tab (row and column 0-based), as if typed. */
export async function writeCells(
  config: AppConfig,
  spreadsheetId: string,
  tabTitle: string,
  cells: { row: number; column: number; text: string }[],
) {
  if (cells.length === 0) return
  const tab = `'${tabTitle.replace(/'/g, "''")}'`
  const data = cells.map((c) => ({ range: `${tab}!${columnLetter(c.column)}${c.row + 1}`, values: [[c.text]] }))
  try {
    await sheetsFetch(config, `${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    })
  } catch (err) {
    if (err instanceof NoAccessError) throw new Error('You can view this spreadsheet but not edit it. Ask its owner for edit access.')
    throw err
  }
}

function columnLetter(index: number) {
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  return letters
}

export class NoAttendanceColumnError extends Error {}

/**
 * Ticks the attendance checkbox of everyone in `tick` and clears it for everyone in `untick`
 * (keys of sign-up rows), skipping boxes already right. Returns how many boxes it changed.
 */
export async function writeAttendance(
  config: AppConfig,
  sheet: { spreadsheet_id: string; tab_id: number; field_map: FieldMap },
  tick: Set<string>,
  untick: Set<string>,
) {
  const { tabTitle, values } = await readTab(config, sheet.spreadsheet_id, sheet.tab_id)
  // An import from before the column existed saved it as "none"; look for it again.
  const fieldMap = { ...sheet.field_map }
  if (!fieldMap.attendance) delete fieldMap.attendance
  const parsed = parseSheet(values, { fieldMap })
  const column = parsed.columns.attendance
  if (column === undefined) {
    throw new NoAttendanceColumnError('No attendance column found. Name a column “Attendance” in the sheet.')
  }
  const tab = `'${tabTitle.replace(/'/g, "''")}'`
  const data = parsed.rows.flatMap((row, i) => {
    const index = parsed.rowIndexes[i]
    const ticked = (values[index]?.[column] ?? '').trim().toUpperCase() === 'TRUE'
    const want = tick.has(row.key) ? true : untick.has(row.key) ? false : ticked
    return want !== ticked ? [{ range: `${tab}!${columnLetter(column)}${index + 1}`, values: [[want]] }] : []
  })
  if (data.length > 0) {
    try {
      await sheetsFetch(config, `${encodeURIComponent(sheet.spreadsheet_id)}/values:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'RAW', data }),
      })
    } catch (err) {
      // It could be read, so this is Google's own sharing: view-only.
      if (err instanceof NoAccessError) throw new Error('You can view this spreadsheet but not edit it. Ask its owner for edit access.')
      throw err
    }
  }
  return data.length
}

type TabProperties = { sheetId: number; title: string; index: number }

async function listTabs(config: AppConfig, spreadsheetId: string) {
  const fields = 'sheets.properties(sheetId,title,index)'
  const meta = await sheetsFetch<{ sheets: { properties: TabProperties }[] }>(
    config,
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`,
  )
  return meta.sheets.map((s) => s.properties)
}

const batchUpdate = (config: AppConfig, spreadsheetId: string, requests: unknown[]) =>
  sheetsFetch<{ replies: { addSheet?: { properties: TabProperties } }[] }>(
    config,
    `${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    { method: 'POST', body: JSON.stringify({ requests }) },
  )

/**
 * Rewrites the sheet's "[tab] - Check In" tab with `layout`, adding it just after the sign-up tab
 * the first time. The tab is found by its title, so it follows the sign-up tab if that's renamed.
 */
export async function writeCheckInTab(
  config: AppConfig,
  sheet: { spreadsheet_id: string; tab_id: number },
  /** Given the check-in tab's title. */
  layout: (title: string) => CheckInLayout,
) {
  const id = sheet.spreadsheet_id
  let tabs = await listTabs(config, id)
  const source = tabs.find((t) => t.sheetId === sheet.tab_id)
  if (!source) throw new Error('The sign-up tab no longer exists in the spreadsheet.')
  const title = checkInTabTitle(source.title)
  const { rows, columnCount, frozenRows, columnWidths, rowHeights } = layout(title)
  const grid = { rowCount: Math.max(rows.length, frozenRows + 1), columnCount, frozenRowCount: frozenRows, hideGridlines: true }
  const tabColor = { red: 0.09, green: 0.64, blue: 0.29 }
  let tabId: number | undefined
  const size = (dimension: 'ROWS' | 'COLUMNS', startIndex: number, endIndex: number, pixelSize: number) => ({
    updateDimensionProperties: {
      range: { sheetId: tabId, dimension, startIndex, endIndex },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  })
  // One request per run of rows the same height.
  const heights: { start: number; end: number; height: number }[] = []
  rowHeights.forEach((height, i) => {
    const last = heights.at(-1)
    if (last?.height === height) last.end = i + 1
    else heights.push({ start: i, end: i + 1, height })
  })
  try {
    tabId = tabs.find((t) => t.title === title)?.sheetId
    if (tabId === undefined) {
      try {
        const added = await batchUpdate(config, id, [
          { addSheet: { properties: { title, index: source.index + 1, gridProperties: grid, tabColor } } },
        ])
        tabId = added.replies[0].addSheet!.properties.sheetId
      } catch (err) {
        // Another volunteer's device may have just added it.
        tabs = await listTabs(config, id)
        tabId = tabs.find((t) => t.title === title)?.sheetId
        if (tabId === undefined) throw err
      }
    }
    await batchUpdate(config, id, [
      {
        updateSheetProperties: {
          properties: { sheetId: tabId, gridProperties: grid, tabColor },
          fields: 'tabColor,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.hideGridlines',
        },
      },
      ...columnWidths.map((pixelSize, i) => size('COLUMNS', i, i + 1, pixelSize)),
      ...heights.map(({ start, end, height }) => size('ROWS', start, end, height)),
      // The whole tab, so whatever was there before is cleared.
      { updateCells: { range: { sheetId: tabId }, rows: rows.map((values) => ({ values })), fields: 'userEnteredValue,userEnteredFormat' } },
    ])
  } catch (err) {
    // It could be read, so this is Google's own sharing: view-only.
    if (err instanceof NoAccessError) throw new Error('You can view this spreadsheet but not edit it. Ask its owner for edit access.')
    throw err
  }
}
