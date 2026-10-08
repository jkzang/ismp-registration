/**
 * Re-sync: the sign-up tab's rows, with blanks filled from the Student Database, sent to the server.
 *
 * Both sheet pages run it in the background whenever they read the tab, so new rows and status
 * changes made in the sheet (or on the Sign-ups page) reach check-in by themselves. A background
 * run sends only when the rows changed since this browser last sent them. Every send carries a sync
 * ticket, and the server turns it away if another device already sent a newer read, so a slow
 * device can't undo newer changes.
 *
 * Every read also tends the tab (sheetTending.ts): the added columns, their blanks, No Response
 * after 48 hours and the stats above the header.
 */
import { api, ApiError, errorMessage } from './api'
import { applyTending, getAccessToken, readDatabaseTab, readTab, writeCells } from './google'
import { planTending, type Turnout } from './sheetTending'
import { importWarnings, type FieldMap } from './sheetParser'
import { locateFieldMap } from './signupTracker'
import { parseWithDatabase, type Fill } from './studentDatabase'
import type { AppConfig, ResyncResult, SeatingPlan, Sheet } from './types'

export type TabData = Awaited<ReturnType<typeof readTab>> & {
  /** The sync ticket fetched just before the read. */
  readAt?: string
  /** The Student Database tab, read with it (null when there isn't one). */
  database?: string[][] | null
  /** Why the tab couldn't be tended, e.g. it's view-only. */
  tendError?: string
}

type TabRef = { spreadsheet_id: string; tab_id: number; field_map: FieldMap }

/** The expected attendance's inputs, from the sheet's plan, for the stats in the sheet. */
export const turnoutOf = (sheet: Pick<Sheet, 'capacity'>, plan: SeatingPlan | null): Turnout | null =>
  plan && {
    show_up_rates: plan.show_up_rates,
    walk_in_rate: plan.walk_in_rate,
    checkedIn: new Set(plan.students.filter((s) => s.checked_in).map((s) => s.key)),
    capacity: sheet.capacity,
  }

// One tend at a time per tab in this browser, each reading after the last one wrote, so two
// pages reading at once can't both add the stats block.
const tending = new Map<string, Promise<unknown>>()

/**
 * Reads the tab with `read` (null if that gives up) and tends it, returning the values as they are
 * once tended. A tab that can't be written to is still read; `tendError` says why.
 */
export function readTended(
  config: AppConfig,
  sheet: TabRef,
  read: () => Promise<TabData | null>,
  turnout: Turnout | null = null,
): Promise<TabData | null> {
  const key = `${sheet.spreadsheet_id}/${sheet.tab_id}`
  const run = (tending.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const data = await read()
      if (!data) return null
      const database = await readDatabaseTab(config, sheet.spreadsheet_id, data.tabs, sheet.tab_id)
      const tab = data.tabs.find((t) => t.id === sheet.tab_id)
      const plan = planTending(data.values, sheet.field_map, database, { turnout, version: tab?.version?.value ?? 0 })
      if (!tab || !plan?.changed) return { ...data, database }
      try {
        // Null, or why the dropdowns couldn't be set (the values are in either way).
        const tableError = await applyTending(config, sheet.spreadsheet_id, tab, plan)
        return { ...data, values: plan.values, database, ...(tableError && { tendError: tableError }) }
      } catch (err) {
        return {
          ...data,
          database,
          tendError: `The sheet’s status columns and statistics couldn’t be updated: ${errorMessage(err, 'Google Sheets didn’t take the changes.')}`,
        }
      }
    })
  tending.set(key, run)
  return run
}

/**
 * Tends every sheet in the background when the app opens, so Not Contacted, No Response and the
 * stats are up to date even in sheets nobody has open. Only with a Google token already in hand:
 * it never opens Google's popup.
 */
export async function tendSheets(config: AppConfig, sheets: Sheet[]) {
  try {
    await getAccessToken(config, { interactive: false })
  } catch {
    return
  }
  for (const sheet of sheets) {
    const plan = await api.getPlan(sheet.id).catch(() => null)
    await readTended(config, sheet, () => readTab(config, sheet.spreadsheet_id, sheet.tab_id), turnoutOf(sheet, plan)).catch(() => {})
  }
}
export type Synced = { result: ResyncResult; fills: Fill[]; writeError: string | null }

// What each sheet's rows were last sent as, from this browser.
const lastSent = new Map<number, string>()

/**
 * Gets a sync ticket from the server, then reads and tends the tab with `read` (or null if that gives up), so
 * the server can turn away a send from this read if another device already sent a newer one.
 */
export async function readForSync(
  config: AppConfig,
  sheet: Sheet,
  read: () => Promise<TabData | null>,
  turnout: Turnout | null = null,
): Promise<TabData | null> {
  const { ticket } = await api.syncTicket(sheet.id)
  const data = await readTended(config, sheet, read, turnout)
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
  const database = data.database !== undefined ? data.database : await readDatabaseTab(config, sheet.spreadsheet_id, data.tabs, sheet.tab_id)
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
