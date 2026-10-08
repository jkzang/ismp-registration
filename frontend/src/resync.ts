/** Re-sync: the sign-up tab's rows, with blanks filled from the Student Database, sent to the server. */
import { api, errorMessage } from './api'
import { readDatabaseTab, writeCells, type readTab } from './google'
import { importWarnings } from './sheetParser'
import { parseWithDatabase, type Fill } from './studentDatabase'
import type { AppConfig, ResyncResult, Sheet } from './types'

/** `data` is the tab as readTab just read it. */
export async function resyncSheet(config: AppConfig, sheet: Sheet, data: Awaited<ReturnType<typeof readTab>>) {
  const database = await readDatabaseTab(config, sheet.spreadsheet_id, data.tabs, sheet.tab_id)
  const { parsed, fills } = parseWithDatabase(data.values, database, { fieldMap: sheet.field_map })
  // Doesn't hold up the re-sync; the filled values are imported either way.
  let writeError: string | null = null
  try {
    await writeCells(config, sheet.spreadsheet_id, data.tabTitle, fills)
  } catch (err) {
    writeError = errorMessage(err, 'Couldn’t write to the sheet.')
  }
  const result = await api.resyncSheet(sheet.id, {
    spreadsheet_title: data.spreadsheetTitle,
    tab_title: data.tabTitle,
    field_map: parsed.fieldMap,
    rows: parsed.rows,
    warnings: importWarnings(parsed),
  })
  return { result, fills, writeError }
}

/** "Re-synced: 2 added · 1 removed", for the banner. */
export function describeResync({ result, fills, writeError }: { result: ResyncResult; fills: Fill[]; writeError: string | null }) {
  const changes = [
    result.added && `${result.added} added`,
    result.removed && `${result.removed} removed`,
    fills.length && `${fills.length} filled from Student Database${writeError ? ' (not written to the sheet)' : ''}`,
  ].filter(Boolean)
  return changes.length ? `Re-synced: ${changes.join(' · ')}` : 'Re-synced: no new or removed sign-ups'
}
