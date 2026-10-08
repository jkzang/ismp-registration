/**
 * The "[tab] - Check In" tab: a Google Sheets copy of the sheet's page, with everyone signed up and
 * whether they're here on the left, and the tables with their mentors on the right.
 *
 * The app owns the tab and rewrites all of it whenever the saved plan changes, so anything typed
 * into it is overwritten. This file only lays it out; google.ts writes it.
 */
import { TABLE_GROUPS, type SeatingPlan, type SeatingTable } from './types'

type Color = { red: number; green: number; blue: number }
type Border = { style: 'SOLID' | 'SOLID_MEDIUM'; color: Color }
type Format = {
  textFormat?: { bold?: boolean; italic?: boolean; fontSize?: number; foregroundColor?: Color }
  backgroundColor?: Color
  horizontalAlignment?: 'LEFT' | 'CENTER' | 'RIGHT'
  verticalAlignment?: 'TOP' | 'MIDDLE' | 'BOTTOM'
  wrapStrategy?: 'OVERFLOW_CELL' | 'CLIP'
  padding?: { left?: number; right?: number }
  borders?: { top?: Border; bottom?: Border; left?: Border; right?: Border }
}

/** One cell, as Google Sheets' CellData takes it (only the parts used here). */
export type Cell = { userEnteredValue?: { stringValue: string }; userEnteredFormat?: Format }

export type CheckInLayout = {
  rows: Cell[][]
  columnCount: number
  /** Rows kept in view while scrolling: the title, the summary and the headers. */
  frozenRows: number
  /** In pixels, by column. */
  columnWidths: number[]
  /** In pixels, by row. */
  rowHeights: number[]
}

// Google caps a tab's title at 100 characters.
const MAX_TITLE = 100
const SUFFIX = ' - Check In'

export const checkInTabTitle = (tabTitle: string) => tabTitle.slice(0, MAX_TITLE - SUFFIX.length) + SUFFIX
export const isCheckInTab = (title: string) => title.endsWith(SUFFIX)

// Like the app's board: four tables across, each a card with a thin column between.
const TABLES_ACROSS = 4
const LIST_COLUMNS = 3
const TABLES_COLUMN = LIST_COLUMNS + 1
const tableColumn = (i: number) => TABLES_COLUMN + i * 2
const COLUMN_COUNT = tableColumn(TABLES_ACROSS - 1) + 1
const HEADER_ROW = 4
const FIRST_ROW = HEADER_ROW + 1

const rgb = (hex: string): Color => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
})
const INK = rgb('#0f172a')
const MUTED = rgb('#64748b')
const FAINT = rgb('#94a3b8')
const STRIPE = rgb('#f8fafc')
const BAR = rgb('#1e293b')
const WHITE = rgb('#ffffff')
const HERE = rgb('#dcfce7')
const HERE_TEXT = rgb('#15803d')

/** Each table's card is colored by who it's for, in a strong shade and a tint. */
const GROUP_COLORS: Record<SeatingTable['gender'], [Color, Color]> = {
  female: [rgb('#be185d'), rgb('#fdf2f8')],
  male: [rgb('#1d4ed8'), rgb('#eff6ff')],
  coed: [rgb('#6d28d9'), rgb('#f5f3ff')],
  '': [rgb('#475569'), rgb('#f1f5f9')],
}

const BODY: Format = { verticalAlignment: 'MIDDLE', wrapStrategy: 'CLIP', padding: { left: 8, right: 8 } }
const cell = (value: string, format: Format = {}): Cell => ({
  ...(value && { userEnteredValue: { stringValue: value } }),
  userEnteredFormat: { ...BODY, ...format, textFormat: { foregroundColor: INK, ...format.textFormat } },
})
// The heading lines overflow across the empty cells beside them.
const heading = (value: string, textFormat: Format['textFormat']): Cell => ({
  userEnteredValue: { stringValue: value },
  userEnteredFormat: { verticalAlignment: 'MIDDLE', wrapStrategy: 'OVERFLOW_CELL', textFormat },
})

const groupLabel = (table: SeatingTable) =>
  TABLE_GROUPS.find((g) => g.value === `${table.gender}:${table.level}`)?.label ?? 'No group'
const displayName = (person: { name: string; nickname: string }) =>
  person.nickname ? `${person.name} (${person.nickname})` : person.name
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Lays out the whole tab. `updated` is when it was written, for the note at the top. */
export function checkInLayout(plan: SeatingPlan, title: string, updated?: string): CheckInLayout {
  const rows: Cell[][] = []
  const put = (row: number, column: number, value: Cell) => {
    while (rows.length <= row) rows.push([])
    rows[row][column] = value
  }

  const studentsById = new Map(plan.students.map((s) => [s.id, s]))
  const mentorsById = new Map(plan.mentors.map((m) => [m.id, m]))
  const tableOf = new Map<number, SeatingTable>()
  for (const t of plan.tables) for (const m of t.members) if (m.kind === 'student') tableOf.set(m.id, t)
  const here = plan.students.filter((s) => s.checked_in).length
  const seatedMentors = plan.tables.reduce((n, t) => n + t.members.filter((m) => m.kind === 'mentor').length, 0)

  put(0, 0, heading(title, { bold: true, fontSize: 18, foregroundColor: INK }))
  put(1, 0, heading(
    `${here} checked in  ·  ${plan.students.length} signed up  ·  ${plural(plan.tables.length, 'table')}  ·  ${plural(seatedMentors, 'mentor')}`,
    { bold: true, fontSize: 11, foregroundColor: MUTED },
  ))
  put(2, 0, heading(
    'Kept up to date by the registration app. Changes made in this tab are overwritten.' + (updated ? `  Updated ${updated}.` : ''),
    { italic: true, fontSize: 9, foregroundColor: FAINT },
  ))

  // A dark bar over the list and over the tables, with a gap between.
  const bar = (value: string, align: Format['horizontalAlignment'] = 'LEFT') =>
    cell(value, { backgroundColor: BAR, horizontalAlignment: align, textFormat: { bold: true, foregroundColor: WHITE } })
  put(HEADER_ROW, 0, bar('Name'))
  put(HEADER_ROW, 1, bar('Checked in', 'CENTER'))
  put(HEADER_ROW, 2, bar('Table'))
  for (let c = TABLES_COLUMN; c < COLUMN_COUNT; c++) put(HEADER_ROW, c, bar(c === TABLES_COLUMN ? 'Tables' : ''))

  // The list, by name like the app's, in stripes.
  const people = [...plan.students].sort((a, b) => a.name.localeCompare(b.name))
  people.forEach((person, i) => {
    const row = FIRST_ROW + i
    const stripe = i % 2 ? { backgroundColor: STRIPE } : {}
    const table = tableOf.get(person.id)
    put(row, 0, cell(displayName(person), stripe))
    put(row, 1, person.checked_in
      ? cell('✓  Here', { backgroundColor: HERE, horizontalAlignment: 'CENTER', textFormat: { bold: true, foregroundColor: HERE_TEXT } })
      : cell('Not yet', { ...stripe, horizontalAlignment: 'CENTER', textFormat: { foregroundColor: FAINT } }))
    put(row, 2, table
      ? cell(table.name, { ...stripe, textFormat: { bold: true, foregroundColor: GROUP_COLORS[table.gender][0] } })
      : cell('—', { ...stripe, textFormat: { foregroundColor: FAINT } }))
  })

  // The tables as cards, four across: name, group and who's here, mentors, then students. Cards in
  // a row are the same height.
  if (plan.tables.length === 0) {
    put(FIRST_ROW, TABLES_COLUMN, cell('No tables planned yet.', { textFormat: { italic: true, foregroundColor: MUTED } }))
  }
  let top = FIRST_ROW
  for (let start = 0; start < plan.tables.length; start += TABLES_ACROSS) {
    const band = plan.tables.slice(start, start + TABLES_ACROSS).map((table) => {
      const mentors = table.members.flatMap((m) => (m.kind === 'mentor' ? mentorsById.get(m.id) ?? [] : []))
      // Checked in first, each in name order; the rest are where they'd sit, in grey.
      const students = table.members
        .flatMap((m) => (m.kind === 'student' ? studentsById.get(m.id) ?? [] : []))
        .sort((a, b) => Number(b.checked_in) - Number(a.checked_in) || a.name.localeCompare(b.name))
      return { table, mentors, students }
    })
    const height = 2 + Math.max(...band.map((t) => Math.max(t.mentors.length, 1) + t.students.length))
    band.forEach(({ table, mentors, students }, i) => {
      const column = tableColumn(i)
      const [strong, tint] = GROUP_COLORS[table.gender]
      const side: Border = { style: 'SOLID', color: strong }
      const card = (row: number, value: string, format: Format = {}) =>
        put(top + row, column, cell(value, {
          ...format,
          borders: { left: side, right: side, ...(row === height - 1 && { bottom: side }) },
        }))
      const seatedHere = students.filter((s) => s.checked_in).length
      card(0, table.name, { backgroundColor: strong, textFormat: { bold: true, fontSize: 11, foregroundColor: WHITE } })
      card(1, `${groupLabel(table)}  ·  ${seatedHere} of ${students.length} here`, {
        backgroundColor: tint,
        textFormat: { fontSize: 9, foregroundColor: strong },
      })
      let row = 2
      if (mentors.length === 0) card(row++, 'No mentor', { backgroundColor: tint, textFormat: { italic: true, foregroundColor: MUTED } })
      for (const mentor of mentors) card(row++, `★  ${mentor.name}`, { backgroundColor: tint, textFormat: { bold: true, foregroundColor: strong } })
      for (const s of students) {
        card(row++, s.checked_in ? `✓  ${displayName(s)}` : `     ${displayName(s)}`, {
          textFormat: s.checked_in ? { foregroundColor: INK } : { foregroundColor: FAINT },
        })
      }
      while (row < height) card(row++, '')
    })
    top += height + 1
  }

  // Sheets wants every row the same length; blank cells fill the gaps.
  const filled = rows.map((row) => Array.from({ length: COLUMN_COUNT }, (_, c) => row[c] ?? {}))
  return {
    rows: filled,
    columnCount: COLUMN_COUNT,
    frozenRows: FIRST_ROW,
    columnWidths: [230, 100, 120, 28, ...Array.from({ length: COLUMN_COUNT - TABLES_COLUMN }, (_, i) => (i % 2 ? 14 : 210))],
    rowHeights: filled.map((_, i) => [40, 24, 20, 10, 30][i] ?? 26),
  }
}
