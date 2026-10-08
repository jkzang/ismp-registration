/**
 * The "[tab] - Check In" tab: a Google Sheets copy of the sheet's page, with everyone signed up and
 * whether they're here on the left, and the tables with their mentors on the right.
 *
 * The app owns the tab and rewrites all of it whenever the saved plan changes, so anything typed
 * into it is overwritten. This file only lays it out; google.ts writes it.
 */
import { TABLE_GROUPS, type SeatingPlan } from './types'

/** One cell, as Google Sheets' CellData takes it (only the parts used here). */
export type Cell = {
  userEnteredValue?: { stringValue: string }
  userEnteredFormat?: {
    textFormat?: { bold?: boolean; italic?: boolean; fontSize?: number; foregroundColor?: Color }
    backgroundColor?: Color
    horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT'
  }
}
type Color = { red: number; green: number; blue: number }

export type CheckInLayout = {
  rows: Cell[][]
  columnCount: number
  /** Rows kept in view while scrolling: the title, the note and the headers. */
  frozenRows: number
  /** In pixels, by column. */
  columnWidths: number[]
}

// Google caps a tab's title at 100 characters.
const MAX_TITLE = 100
const SUFFIX = ' - Check In'

export const checkInTabTitle = (tabTitle: string) => tabTitle.slice(0, MAX_TITLE - SUFFIX.length) + SUFFIX
export const isCheckInTab = (title: string) => title.endsWith(SUFFIX)

// Like the app's board: four tables across.
const TABLES_ACROSS = 4
const LIST_COLUMNS = 3
// An empty column between the list and the tables.
const TABLES_COLUMN = LIST_COLUMNS + 1
const HEADER_ROW = 2

const rgb = (hex: string): Color => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
})
const GREY = rgb('#6b7280')
const LIGHT = rgb('#f3f4f6')
const HERE = rgb('#dcfce7')
const HERE_TEXT = rgb('#166534')
const TABLE_HEAD = rgb('#1f2937')
const WHITE = rgb('#ffffff')
const MENTOR = rgb('#e0e7ff')

const text = (value: string, format?: Cell['userEnteredFormat']): Cell => ({
  userEnteredValue: { stringValue: value },
  ...(format && { userEnteredFormat: format }),
})
const bold = (value: string, more: Cell['userEnteredFormat'] = {}) =>
  text(value, { ...more, textFormat: { bold: true, ...more.textFormat } })

const groupLabel = (gender: string, level: string) =>
  TABLE_GROUPS.find((g) => g.value === `${gender}:${level}`)?.label ?? 'No group'

/** Lays out the whole tab. `updated` is when it was written, for the note at the top. */
export function checkInLayout(plan: SeatingPlan, title: string, updated?: string): CheckInLayout {
  const rows: Cell[][] = []
  const put = (row: number, column: number, cell: Cell) => {
    while (rows.length <= row) rows.push([])
    rows[row][column] = cell
  }

  const studentsById = new Map(plan.students.map((s) => [s.id, s]))
  const mentorsById = new Map(plan.mentors.map((m) => [m.id, m]))
  const tableOf = new Map<number, string>()
  for (const t of plan.tables) for (const m of t.members) if (m.kind === 'student') tableOf.set(m.id, t.name)
  const here = plan.students.filter((s) => s.checked_in).length

  put(0, 0, bold(title, { textFormat: { fontSize: 14 } }))
  put(1, 0, text(
    `${here} of ${plan.students.length} checked in. Kept up to date by the registration app; changes made here are overwritten.` +
      (updated ? ` Updated ${updated}.` : ''),
    { textFormat: { italic: true, foregroundColor: GREY } },
  ))

  // The list, by name like the app's.
  const header = { backgroundColor: LIGHT }
  put(HEADER_ROW, 0, bold('Name', header))
  put(HEADER_ROW, 1, bold('Checked in', { ...header, horizontalAlignment: 'CENTER' }))
  put(HEADER_ROW, 2, bold('Table', header))
  const people = [...plan.students].sort((a, b) => a.name.localeCompare(b.name))
  people.forEach((person, i) => {
    const row = HEADER_ROW + 1 + i
    const name = person.nickname ? `${person.name} (${person.nickname})` : person.name
    put(row, 0, text(name, person.checked_in ? undefined : { textFormat: { foregroundColor: GREY } }))
    put(row, 1, person.checked_in
      ? bold('Yes', { horizontalAlignment: 'CENTER', backgroundColor: HERE, textFormat: { foregroundColor: HERE_TEXT } })
      : text('No', { horizontalAlignment: 'CENTER', textFormat: { foregroundColor: GREY } }))
    put(row, 2, text(tableOf.get(person.id) ?? '', person.checked_in ? undefined : { textFormat: { foregroundColor: GREY } }))
  })

  // The tables, four across: name, group and who's here, mentors, then students.
  put(HEADER_ROW, TABLES_COLUMN, bold('Tables', header))
  for (let c = 1; c < TABLES_ACROSS; c++) put(HEADER_ROW, TABLES_COLUMN + c, text('', header))
  if (plan.tables.length === 0) {
    put(HEADER_ROW + 1, TABLES_COLUMN, text('No tables planned yet.', { textFormat: { italic: true, foregroundColor: GREY } }))
  }
  let top = HEADER_ROW + 1
  for (let start = 0; start < plan.tables.length; start += TABLES_ACROSS) {
    const band = plan.tables.slice(start, start + TABLES_ACROSS)
    let height = 0
    band.forEach((table, c) => {
      const column = TABLES_COLUMN + c
      const mentors = table.members.flatMap((m) => (m.kind === 'mentor' ? mentorsById.get(m.id) ?? [] : []))
      const students = table.members.flatMap((m) => (m.kind === 'student' ? studentsById.get(m.id) ?? [] : []))
      const seatedHere = students.filter((s) => s.checked_in).length
      put(top, column, bold(table.name, { backgroundColor: TABLE_HEAD, textFormat: { foregroundColor: WHITE } }))
      put(top + 1, column, text(`${groupLabel(table.gender, table.level)} · ${seatedHere} of ${students.length} here`, {
        textFormat: { italic: true, foregroundColor: GREY },
      }))
      let row = top + 2
      if (mentors.length === 0) put(row++, column, text('No mentor', { textFormat: { italic: true, foregroundColor: GREY } }))
      for (const mentor of mentors) put(row++, column, bold(mentor.name, { backgroundColor: MENTOR }))
      // Checked in first, each in name order; the rest are where they'd sit, in grey.
      const ordered = [...students].sort((a, b) => Number(b.checked_in) - Number(a.checked_in) || a.name.localeCompare(b.name))
      for (const s of ordered) {
        const name = s.nickname ? `${s.name} (${s.nickname})` : s.name
        put(row++, column, s.checked_in ? text(`✓ ${name}`) : text(name, { textFormat: { foregroundColor: GREY } }))
      }
      height = Math.max(height, row - top)
    })
    top += height + 1
  }

  const columnCount = TABLES_COLUMN + TABLES_ACROSS
  // Sheets wants every row the same length; blank cells fill the gaps.
  const filled = rows.map((row) => Array.from({ length: columnCount }, (_, c) => row[c] ?? {}))
  return {
    rows: filled,
    columnCount,
    frozenRows: HEADER_ROW + 1,
    columnWidths: [240, 90, 110, 24, ...Array(TABLES_ACROSS).fill(210)],
  }
}
