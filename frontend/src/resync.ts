/**
 * Re-sync: the sign-up tab's rows, with blanks filled from the Student Database, sent to the server.
 *
 * Both sheet pages run it in the background whenever they read the tab, so new rows and status
 * changes made in the sheet (or on the Sign-ups page) reach check-in by themselves. A background
 * run sends only when the rows changed since this browser last sent them.
 */
import { api, errorMessage } from './api'
import { readDatabaseTab, writeCells, type readTab } from './google'
import { importWarnings } from './sheetParser'
import { locateFieldMap } from './signupTracker'
import { parseWithDatabase, type Fill } from './studentDatabase'
import type { AppConfig, ResyncResult, Sheet } from './types'

export type TabData = Awaited<ReturnType<typeof readTab>>
export type Synced = { result: ResyncResult; fills: Fill[]; writeError: string | null }

// What each sheet's rows were last sent as, from this browser.
const lastSent = new Map<number, string>()

/**
 * Sends `data` (the tab as readTab just read it) to the server. With `auto`, skips it when nothing
 * changed since the last send, and when it would drop more than half of `knownKeys` (the sign-ups
 * the app has): more likely a half-edited sheet than that many people leaving. Null when skipped.
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
  const result = await api.resyncSheet(sheet.id, body)
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
