/**
 * Re-sync: the sign-up tab's rows, with blanks filled from the Student Database, sent to the server.
 *
 * Both sheet pages run it in the background whenever they read the tab, so new rows and status
 * changes made in the sheet (or on the Sign-ups page) reach check-in by themselves. A background
 * run sends only when the rows changed since this browser last sent them. Every send carries a sync
 * ticket, and the server turns it away if another device already sent a newer read, so a slow
 * device can't undo newer changes.
 */
import { api, ApiError, errorMessage } from './api'
import { readDatabaseTab, writeCells, type readTab } from './google'
import { importWarnings } from './sheetParser'
import { locateFieldMap } from './signupTracker'
import { parseWithDatabase, type Fill } from './studentDatabase'
import type { AppConfig, ResyncResult, Sheet } from './types'

export type TabData = Awaited<ReturnType<typeof readTab>> & {
  /** The sync ticket fetched just before the read. */
  readAt?: string
}
export type Synced = { result: ResyncResult; fills: Fill[]; writeError: string | null }

// What each sheet's rows were last sent as, from this browser.
const lastSent = new Map<number, string>()

/**
 * Gets a sync ticket from the server, then reads the tab with `read` (or null if that gives up), so
 * the server can turn away a send from this read if another device already sent a newer one.
 */
export async function readForSync(sheet: Sheet, read: () => Promise<TabData | null>): Promise<TabData | null> {
  const { ticket } = await api.syncTicket(sheet.id)
  const data = await read()
  return data && { ...data, readAt: ticket }
}

/**
 * Sends `data` (the tab as readTab just read it) to the server. With `auto`, skips it when nothing
 * changed since the last send, and when it would drop more than half of `knownKeys` (the sign-ups
 * the app has): more likely a half-edited sheet than that many people leaving. Null when skipped, or
 * when the server already has a newer read.
 */
export async function resyncSheet(
  config: AppConfig,
  sheet: Sheet,
  data: TabData,
  { auto = false, knownKeys }: { auto?: boolean; knownKeys?: string[] } = {},
): Promise<Synced | null> {
  const database = await readDatabaseTab(config, sheet.spreadsheet_id, data.tabs, sheet.tab_id)
  const { parsed, fills } = parseWithDatabase(data.values, database, { fieldMap: locateFieldMap(sheet.field_map) })
  const body = {
    spreadsheet_title: data.spreadsheetTitle,
    tab_title: data.tabTitle,
    field_map: parsed.fieldMap,
    rows: parsed.rows,
    warnings: importWarnings(parsed),
  }
  const signature = JSON.stringify(body)
  const send = { ...body, read_at: data.readAt ?? null }
  if (auto) {
    if (lastSent.get(sheet.id) === signature) return null
    const keys = new Set(parsed.rows.map((r) => r.key))
    const dropped = (knownKeys ?? []).filter((key) => !keys.has(key)).length
    if (dropped > 0 && dropped * 2 > (knownKeys ?? []).length) return null
  }
  // Doesn't hold up the re-sync; the filled values are imported either way.
  let writeError: string | null = null
  try {
    await writeCells(config, sheet.spreadsheet_id, data.tabTitle, fills)
  } catch (err) {
    writeError = errorMessage(err, 'Couldn’t write to the sheet.')
  }
  let result: ResyncResult
  try {
    result = await api.resyncSheet(sheet.id, send)
  } catch (err) {
    // Another device sent a newer read of the sheet (or a status was set in the app) since this read.
    if (err instanceof ApiError && err.status === 409) return null
    throw err
  }
  lastSent.set(sheet.id, signature)
  return { result, fills, writeError }
}

/** "Re-synced: 2 added · 1 removed", for the banner. */
export function describeResync({ result, fills, writeError }: Synced) {
  const changes = [
    result.added && `${result.added} added`,
    result.removed && `${result.removed} removed`,
    fills.length && `${fills.length} filled from Student Database${writeError ? ' (not written to the sheet)' : ''}`,
  ].filter(Boolean)
  return changes.length ? `Re-synced: ${changes.join(' · ')}` : 'Re-synced: no new or removed sign-ups'
}
