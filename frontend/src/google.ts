/**
 * Google sign-in, Drive file picking and Sheets reads, all from the browser.
 *
 * Access tokens stay in this tab (memory and sessionStorage, so a reload doesn't need Google's popup
 * again) and are never sent to our server. The app asks only for the drive.file scope, so it can
 * read (and tick attendance in) just the spreadsheets someone picks in the Google Picker.
 */
import { checkInTabTitle, type CheckInLayout } from './checkInTab'
import { parseSheet, type ContactStatus, type FieldMap } from './sheetParser'
import { formatStamp, groupChatLabel, groupChatOf, type GroupChatStatus } from './signupColumns'
import { STATS_ROWS, TEND_VERSION, type StatCell, type Tending } from './sheetTending'
import { extraColumns, locateFieldMap, statusText } from './signupTracker'
import { isDatabaseTab } from './studentDatabase'
import { CONTACT_STATUSES, type AppConfig } from './types'

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
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = body?.error?.message ? `: ${body.error.message}` : ''
    throw new Error(`Google Sheets returned an error (${res.status})${detail}.`)
  }
  return res.json()
}

/**
 * Runs Google Sheets calls, first getting a token (call from a click, for the popup). If this person
 * hasn't picked the file yet (someone else imported it), the Picker asks them to once. Null if they
 * close it.
 */
export async function withSheetAccess<T>(config: AppConfig, spreadsheetId: string, run: () => Promise<T>): Promise<T | null> {
  await getAccessToken(config)
  try {
    return await run()
  } catch (err) {
    if (!(err instanceof NoAccessError)) throw err
    const picked = await pickSpreadsheet(config, await getAccessToken(config), spreadsheetId)
    return picked ? run() : null
  }
}

/**
 * `rows` and `columns` are the tab's grid size, which can be more than its values show. `version` is
 * the app version that last tended it (see sheetTending.ts), from its developer metadata.
 */
export type Tab = {
  id: number
  title: string
  rows: number
  columns: number
  version: { id: number; value: number } | null
  /** The tab's row groups (the stats block's is the one that hides it). */
  rowGroups: { start: number; end: number }[]
}

const VERSION_KEY = 'ismp-registration-tended'

export async function getSpreadsheet(config: AppConfig, spreadsheetId: string): Promise<{ title: string; tabs: Tab[] }> {
  type Meta = {
    properties: { title: string }
    sheets: {
      properties: { sheetId: number; title: string; hidden?: boolean; gridProperties?: { rowCount?: number; columnCount?: number } }
      developerMetadata?: { metadataId: number; metadataKey: string; metadataValue?: string }[]
      rowGroups?: { range: { startIndex?: number; endIndex?: number } }[]
    }[]
  }
  const fields =
    'properties.title,sheets(properties(sheetId,title,hidden,gridProperties(rowCount,columnCount)),developerMetadata(metadataId,metadataKey,metadataValue),rowGroups(range(startIndex,endIndex)))'
  const meta = await sheetsFetch<Meta>(config, `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent(fields)}`)
  return {
    title: meta.properties.title,
    tabs: meta.sheets
      .filter((s) => !s.properties.hidden)
      .map((s) => ({
        id: s.properties.sheetId,
        title: s.properties.title,
        rows: s.properties.gridProperties?.rowCount ?? 0,
        columns: s.properties.gridProperties?.columnCount ?? 0,
        version: (() => {
          const meta = s.developerMetadata?.find((m) => m.metadataKey === VERSION_KEY)
          return meta ? { id: meta.metadataId, value: Number(meta.metadataValue) || 0 } : null
        })(),
        rowGroups: (s.rowGroups ?? []).map((g) => ({ start: g.range.startIndex ?? 0, end: g.range.endIndex ?? 0 })),
      })),
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
  const parsed = parseSheet(values, { fieldMap: locateFieldMap(sheet.field_map) })
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

export class NoStatusColumnError extends Error {}

/** Someone else changed the status since; `status` is what the sheet has now. */
export class StatusChangedError extends Error {
  status: ContactStatus
  constructor(name: string, status: ContactStatus) {
    const label = CONTACT_STATUSES.find((s) => s.value === status)?.label
    super(`${name}’s status was changed to ${label} by someone else since, so it was left as is.`)
    this.status = status
  }
}

/**
 * Sets one sign-up's Contact Status cell (`key` is their row's key). The tab is read again first, so
 * the right row is found even if rows were added or sorted since the page last read it.
 */
export async function writeStatus(
  config: AppConfig,
  sheet: { spreadsheet_id: string; tab_id: number; field_map: FieldMap },
  key: string,
  status: ContactStatus,
  /** For undo and redo: only write if the sheet still has this, so someone else's newer change stays. */
  expected?: ContactStatus,
) {
  const { tabTitle, values } = await readTab(config, sheet.spreadsheet_id, sheet.tab_id)
  const parsed = parseSheet(values, { fieldMap: locateFieldMap(sheet.field_map) })
  const column = parsed.columns.status
  if (column === undefined) {
    throw new NoStatusColumnError('No Contact Status column found. Name a column “Contact Status” in the sheet.')
  }
  const i = parsed.rows.findIndex((row) => row.key === key)
  if (i === -1) throw new Error('That sign-up is no longer in the sheet, or their name or timestamp changed. Refresh and try again.')
  const now = parsed.rows[i].status
  if (expected !== undefined && now !== expected && now !== status) throw new StatusChangedError(parsed.rows[i].name, now)
  const row = parsed.rowIndexes[i]
  // Reaching out starts the 48 hours to No Response over (see sheetTending.ts).
  const contactedAt = extraColumns(parsed.headers, new Set(Object.values(parsed.columns))).contactedAt
  await writeCells(config, sheet.spreadsheet_id, tabTitle, [
    { row, column, text: statusText(values, parsed, status) },
    ...(status === 'awaiting_response' && contactedAt !== undefined ? [{ row, column: contactedAt, text: formatStamp(new Date()) }] : []),
  ])
}

export class NoChatColumnError extends Error {}

/**
 * Sets one sign-up's Group Chat Status (`key` is their row's key), finding their row again like
 * writeStatus. With `expected` (undo and redo), only if the cell still shows that.
 */
export async function writeGroupChat(
  config: AppConfig,
  sheet: { spreadsheet_id: string; tab_id: number; field_map: FieldMap },
  key: string,
  status: GroupChatStatus,
  expected?: GroupChatStatus | null,
) {
  const { tabTitle, values } = await readTab(config, sheet.spreadsheet_id, sheet.tab_id)
  const parsed = parseSheet(values, { fieldMap: locateFieldMap(sheet.field_map) })
  const column = extraColumns(parsed.headers, new Set(Object.values(parsed.columns))).groupChat
  if (column === undefined) throw new NoChatColumnError('No Group Chat Status column found. Refresh to add it to the sheet.')
  const i = parsed.rows.findIndex((row) => row.key === key)
  if (i === -1) throw new Error('That sign-up is no longer in the sheet, or their name or timestamp changed. Refresh and try again.')
  const row = parsed.rowIndexes[i]
  const now = groupChatOf(values[row]?.[column] ?? '')
  if (expected !== undefined && now !== expected && now !== status) {
    throw new Error(`Someone else changed ${parsed.rows[i].name}’s group chat status since, so it was left as is.`)
  }
  await writeCells(config, sheet.spreadsheet_id, tabTitle, [{ row, column, text: groupChatLabel(status) }])
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

/**
 * Writes what planTending worked out into the sign-up tab, in one request so it all lands together:
 * the rows for the stats block, the new columns with their dropdowns and colors, the filled cells
 * and the stats.
 */
export async function applyTending(config: AppConfig, spreadsheetId: string, tab: Tab, tending: Tending) {
  const sheetId = tab.id
  // Before the stats are written, in case taking a table away clears its cells.
  if (tending.setVersion) await removeStatsTables(config, spreadsheetId, sheetId).catch(() => {})
  const requests: unknown[] = []
  if (tending.dropdowns.length) {
    // The app's own color rules (text equal to one of its options) go, to be added again below.
    const labels = new Set(tending.dropdowns.flatMap((d) => d.options.map((o) => o.label)))
    type Rule = { booleanRule?: { condition?: { type?: string; values?: { userEnteredValue?: string }[] } } }
    const meta = await sheetsFetch<{ sheets: { properties: { sheetId: number }; conditionalFormats?: Rule[] }[] }>(
      config,
      `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets(properties.sheetId,conditionalFormats)')}`,
    )
    const rules = meta.sheets.find((s) => s.properties.sheetId === sheetId)?.conditionalFormats ?? []
    rules.forEach((rule, index) => {
      const condition = rule.booleanRule?.condition
      const value = condition?.values?.[0]?.userEnteredValue
      if (condition?.type === 'TEXT_EQ' && value !== undefined && labels.has(value)) {
        // Last first, so the indexes before it still hold.
        requests.unshift({ deleteConditionalFormatRule: { sheetId, index } })
      }
    })
  }
  const op = tending.rowOp
  if (op) {
    const range = { sheetId, dimension: 'ROWS', startIndex: op.at, endIndex: op.at + op.count }
    requests.push(
      op.kind === 'insert' ? { insertDimension: { range, inheritFromBefore: false } } : { deleteDimension: { range } },
      // The stats and the header stay in view.
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: tending.headerRow + 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
    )
  }
  // The empty rows under the last sign-up go.
  const rows = tab.rows + (op ? (op.kind === 'insert' ? op.count : -op.count) : 0)
  if (rows > tending.rowCount) {
    requests.push({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: tending.rowCount, endIndex: rows } } })
  }
  let columns = tab.columns
  for (const c of tending.columnOps) {
    if (c.kind === 'insert') {
      columns++
      requests.push({
        insertDimension: { range: { sheetId, dimension: 'COLUMNS', startIndex: c.at, endIndex: c.at + 1 }, inheritFromBefore: false },
      })
    } else {
      // The destination counts columns as they are before the move; moves here only go left.
      requests.push({
        moveDimension: { source: { sheetId, dimension: 'COLUMNS', startIndex: c.from, endIndex: c.from + 1 }, destinationIndex: c.to },
      })
    }
  }
  if (tending.columnCount > columns) {
    requests.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: tending.columnCount - columns } })
  }
  for (const { column } of tending.newColumns) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 },
        properties: { pixelSize: 190 },
        fields: 'pixelSize',
      },
    })
  }
  for (const { column, options } of tending.dropdowns) {
    const range = { sheetId, startRowIndex: tending.headerRow + 1, startColumnIndex: column, endColumnIndex: column + 1 }
    requests.push({
      repeatCell: {
        range,
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP' } },
        fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,wrapStrategy,borders)',
      },
    })
    for (const { label, swatch } of options) {
      requests.push({
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [range],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: label }] },
              format: { backgroundColor: swatch.background, textFormat: { foregroundColor: swatch.text, bold: true } },
            },
          },
        },
      })
    }
  }
  for (const { row, column, text } of tending.cells) {
    requests.push({
      updateCells: {
        start: { sheetId, rowIndex: row, columnIndex: column },
        rows: [{ values: [{ userEnteredValue: { stringValue: text } }] }],
        fields: 'userEnteredValue',
      },
    })
  }
  if (tending.stats) {
    const width = Math.max(tending.columnCount, tab.columns)
    requests.push(
      {
        updateCells: {
          // The whole width, so a shorter line clears what the last one left.
          range: { sheetId, startRowIndex: 0, endRowIndex: STATS_ROWS, startColumnIndex: 0, endColumnIndex: width },
          rows: tending.stats.map((row, r) => ({
            // The title bar runs the whole width.
            values: Array.from({ length: r === 0 ? width : row.length }, (_, c) =>
              r === 0 ? statCell(row[c] ?? { text: '', style: 'heading' }, c) : chipCell(row[c] ?? { text: '' }, c),
            ),
          })),
          fields: 'userEnteredValue,userEnteredFormat',
        },
      },
      ...STATS_ROW_HEIGHTS.map((pixelSize, r) => ({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: r, endIndex: r + 1 },
          properties: { pixelSize },
          fields: 'pixelSize',
        },
      })),
    )
  }
  if (tending.setVersion) {
    const value = String(TEND_VERSION)
    requests.push(
      tab.version
        ? {
            updateDeveloperMetadata: {
              dataFilters: [{ developerMetadataLookup: { metadataId: tab.version.id } }],
              developerMetadata: { metadataValue: value },
              fields: 'metadataValue',
            },
          }
        : {
            createDeveloperMetadata: {
              developerMetadata: { metadataKey: VERSION_KEY, metadataValue: value, location: { sheetId }, visibility: 'DOCUMENT' },
            },
          },
    )
  }
  if (requests.length) {
    try {
      await batchUpdate(config, spreadsheetId, requests)
    } catch (err) {
      if (err instanceof NoAccessError) throw new Error('You can view this spreadsheet but not edit it. Ask its owner for edit access.')
      throw err
    }
  }
  // Set again when the block changes shape or is missing its group.
  const grouped = !tending.rowOp && tab.rowGroups.some((g) => g.start === 1 && g.end === STATS_ROWS)
  if (tending.stats && !grouped) await groupStats(config, spreadsheetId, sheetId).catch(() => {})
  return applyDropdowns(config, spreadsheetId, sheetId, tending)
}

/**
 * Makes everything under the stats' title row one row group, so the − / + beside the title hides or
 * shows it. Any group already at the top goes first (read again, as the rows may just have moved),
 * so they don't nest. On its own: if Google won't group the frozen rows, nothing else is held up.
 */
async function groupStats(config: AppConfig, spreadsheetId: string, sheetId: number) {
  const meta = await sheetsFetch<{ sheets: { properties: { sheetId: number }; rowGroups?: { range: { startIndex?: number; endIndex?: number } }[] }[] }>(
    config,
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets(properties.sheetId,rowGroups(range(startIndex,endIndex)))')}`,
  )
  const groups = meta.sheets.find((s) => s.properties.sheetId === sheetId)?.rowGroups ?? []
  await batchUpdate(config, spreadsheetId, [
    ...groups
      .filter((g) => (g.range.startIndex ?? 0) < STATS_ROWS)
      .map((g) => ({
        deleteDimensionGroup: { range: { sheetId, dimension: 'ROWS', startIndex: g.range.startIndex ?? 0, endIndex: g.range.endIndex ?? 0 } },
      })),
    { addDimensionGroup: { range: { sheetId, dimension: 'ROWS', startIndex: 1, endIndex: STATS_ROWS } } },
    // The − / + beside the title, above what it hides.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { rowGroupControlAfter: false } },
        fields: 'gridProperties.rowGroupControlAfter',
      },
    },
  ])
}

/**
 * The status columns' dropdowns, on their own so a sheet that won't take them still gets everything
 * else. Returns why not, or null. They're only set again by a new layout or version of the app, so a
 * display style chosen by hand in Sheets (the API can't choose one) stays.
 */
async function applyDropdowns(config: AppConfig, spreadsheetId: string, sheetId: number, tending: Tending): Promise<string | null> {
  if (tending.dropdowns.length === 0) return null
  try {
    await batchUpdate(
      config,
      spreadsheetId,
      tending.dropdowns.map(({ column, options }) => ({
        setDataValidation: {
          range: { sheetId, startRowIndex: tending.headerRow + 1, startColumnIndex: column, endColumnIndex: column + 1 },
          rule: { condition: { type: 'ONE_OF_LIST', values: options.map((o) => ({ userEnteredValue: o.label })) }, showCustomUi: true, strict: false },
        },
      })),
    )
    return null
  } catch (err) {
    return `The status columns’ dropdowns couldn’t be set: ${errorMessage(err)}`
  }
}

/**
 * The previous version tried to make the stats' Contact status and Group chats tables into Google
 * Sheets tables; where it managed to, they go back to plain cells (rewritten with the stats). Only
 * those: a sign-ups table someone made is left alone.
 */
async function removeStatsTables(config: AppConfig, spreadsheetId: string, sheetId: number) {
  const meta = await sheetsFetch<{ sheets: { properties: { sheetId: number }; tables?: { tableId: string; name: string }[] }[] }>(
    config,
    `${encodeURIComponent(spreadsheetId)}?fields=${encodeURIComponent('sheets(properties.sheetId,tables(tableId,name))')}`,
  )
  const tables = meta.sheets.find((s) => s.properties.sheetId === sheetId)?.tables ?? []
  const ours = tables.filter((t) => t.name === `Contact_status_${sheetId}` || t.name === `Group_chats_${sheetId}`)
  if (ours.length) await batchUpdate(config, spreadsheetId, ours.map((t) => ({ deleteTable: { tableId: t.tableId } })))
}

const errorMessage = (err: unknown) => (err instanceof Error && err.message ? err.message : 'unknown error')

// The title, the gap, the tables' names, their nine rows (the first, with the expected attendance,
// taller), and the two empty rows before the header.
const STATS_ROW_HEIGHTS = [34, 10, 28, 36, ...Array<number>(8).fill(24), 21, 21]
const INK = { red: 0.2, green: 0.25, blue: 0.33 }
const MUTED = { red: 0.39, green: 0.45, blue: 0.55 }
const WHITE = { red: 1, green: 1, blue: 1 }
const RULE = { style: 'SOLID', color: { red: 0.89, green: 0.91, blue: 0.94 } }
const FRAME = { style: 'SOLID', color: { red: 0.8, green: 0.84, blue: 0.88 } }
/** A thick white edge around a colored cell, so it reads as a chip. */
const CHIP_EDGE = { style: 'SOLID_THICK', color: WHITE }

/** One cell of the stats block, as Sheets' CellData. Each table is boxed, with a rule under each row. */
function statCell({ text, style, last }: StatCell, column: number) {
  const inTable = style === 'head' || style === 'name' || style === 'value' || style === 'big'
  // Tables are two columns wide, starting at A.
  const side = column % 2 === 0 ? 'left' : 'right'
  const background =
    style === 'heading' ? { red: 0.12, green: 0.16, blue: 0.23 } : style === 'head' ? { red: 0.2, green: 0.25, blue: 0.33 } : undefined
  return {
    ...(text && { userEnteredValue: { stringValue: text } }),
    userEnteredFormat: {
      verticalAlignment: 'MIDDLE',
      horizontalAlignment: style === 'value' || (style === 'big' && side === 'right') ? 'RIGHT' : 'LEFT',
      wrapStrategy: style === 'heading' || style === 'head' ? 'OVERFLOW_CELL' : 'CLIP',
      padding: { left: 8, right: 8 },
      ...(background && { backgroundColor: background }),
      ...(inTable && { borders: { [side]: FRAME, bottom: last || style === 'head' ? FRAME : RULE } }),
      textFormat: {
        foregroundColor: style === 'heading' || style === 'head' ? WHITE : style === 'value' || style === 'big' ? INK : MUTED,
        bold: style !== 'name',
        // The expected attendance stands out.
        fontSize: style === 'heading' ? 13 : style === 'big' ? (side === 'right' ? 20 : 12) : 10,
      },
    },
  }
}

/** A name colored like its status, as a chip inside its cell. */
function chipCell(cell: StatCell, column: number) {
  const base = statCell(cell, column)
  if (!cell.swatch) return base
  return {
    ...base,
    userEnteredFormat: {
      ...base.userEnteredFormat,
      backgroundColor: cell.swatch.background,
      borders: { left: FRAME, top: CHIP_EDGE, bottom: cell.last ? FRAME : CHIP_EDGE, right: CHIP_EDGE },
      textFormat: { ...base.userEnteredFormat.textFormat, foregroundColor: cell.swatch.text, bold: true },
    },
  }
}
