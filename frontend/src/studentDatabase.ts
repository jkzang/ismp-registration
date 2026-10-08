/**
 * Fills sign-ups' blank gender, enrollment and nickname cells from the spreadsheet's "Student
 * Database" tab, in the browser. People are matched by phone, then email, then name (only when that
 * name is unique in the database). Only empty cells are filled, with the database's own text.
 */
import { genderOf, levelOf, parseSheet, type FieldMap, type ParseResult } from './sheetParser'

const DATABASE_TAB = /^student ?data ?base$/

export function isDatabaseTab(title: string) {
  return DATABASE_TAB.test(title.toLowerCase().replace(/[^a-z]+/g, ' ').trim())
}

export const FILLED_FIELDS = ['gender', 'level', 'nickname'] as const
export type FilledField = (typeof FILLED_FIELDS)[number]

/** One blank cell in the sign-up tab and the text it gets. Row and column are 0-based. */
export type Fill = { row: number; column: number; field: FilledField; text: string }

const digits = (text: string) => text.replace(/\D/g, '')
// Last 10 digits, so "+1 (858) 555-0100" and "858-555-0100" match. Too short to trust: no key.
const phoneKey = (text: string) => {
  const d = digits(text)
  return d.length >= 7 ? d.slice(-10) : ''
}
const emailKey = (text: string) => (text.includes('@') ? text.trim().toLowerCase() : '')
const nameKey = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

type Entry = { phone: string; email: string; name: string; values: Partial<Record<FilledField, string>> }

function cellOf(values: string[][], row: number, column: number | undefined) {
  return column === undefined ? '' : (values[row]?.[column] ?? '').trim()
}

function readDatabase(values: string[][]): Entry[] {
  let parsed: ParseResult
  try {
    parsed = parseSheet(values)
  } catch {
    return []
  }
  const { columns } = parsed
  return parsed.rowIndexes.map((row, i) => {
    const gender = cellOf(values, row, columns.gender)
    const level = cellOf(values, row, columns.level)
    return {
      phone: phoneKey(cellOf(values, row, columns.phone)),
      email: emailKey(cellOf(values, row, columns.email)),
      name: nameKey(parsed.rows[i].name),
      values: {
        // Only text the app understands, so what's written back also imports cleanly.
        ...(genderOf(gender) && { gender }),
        ...(levelOf(level) && { level }),
        ...(parsed.rows[i].nickname && { nickname: parsed.rows[i].nickname }),
      },
    }
  })
}

/**
 * The fills for `signups` (a parsed sign-up tab and its values) from the database tab's values,
 * and the sign-up values with them applied, ready to parse again.
 */
/**
 * Finds each sign-up (by its index in `signups.rows`) in the database tab's values: by phone, then
 * email, then name when only one person in the database has it. Null when they aren't in it.
 */
export function databaseMatcher(signupValues: string[][], signups: ParseResult, databaseValues: string[][]) {
  const records = readDatabase(databaseValues)
  const byPhone = new Map<string, Entry>()
  const byEmail = new Map<string, Entry>()
  const byName = new Map<string, Entry | null>()
  for (const r of records) {
    if (r.phone && !byPhone.has(r.phone)) byPhone.set(r.phone, r)
    if (r.email && !byEmail.has(r.email)) byEmail.set(r.email, r)
    // Two people with the same name: neither can be matched by name.
    if (r.name) byName.set(r.name, byName.has(r.name) ? null : r)
  }
  const { columns } = signups
  return (i: number): Entry | null => {
    const row = signups.rowIndexes[i]
    const phone = phoneKey(cellOf(signupValues, row, columns.phone))
    const email = emailKey(cellOf(signupValues, row, columns.email))
    return (phone && byPhone.get(phone)) || (email && byEmail.get(email)) || byName.get(nameKey(signups.rows[i].name)) || null
  }
}

export function fillFromDatabase(signupValues: string[][], signups: ParseResult, databaseValues: string[][]) {
  const matchOf = databaseMatcher(signupValues, signups, databaseValues)
  const { columns } = signups
  const fills: Fill[] = []
  signups.rowIndexes.forEach((row, i) => {
    const blank = FILLED_FIELDS.filter((f) => columns[f] !== undefined && !cellOf(signupValues, row, columns[f]))
    if (blank.length === 0) return
    const match = matchOf(i)
    if (!match) return
    for (const field of blank) {
      const text = match.values[field]
      if (text) fills.push({ row, column: columns[field]!, field, text })
    }
  })

  const filled = signupValues.map((r) => [...r])
  for (const f of fills) {
    const row = (filled[f.row] ??= [])
    while (row.length <= f.column) row.push('')
    row[f.column] = f.text
  }
  return { fills, values: filled }
}

/** parseSheet, with blanks filled from the database tab's values when there is one. */
export function parseWithDatabase(
  values: string[][],
  databaseValues: string[][] | null,
  options: { headerRow?: number; fieldMap?: FieldMap } = {},
) {
  const first = parseSheet(values, options)
  if (!databaseValues) return { parsed: first, fills: [] as Fill[] }
  const { fills, values: filled } = fillFromDatabase(values, first, databaseValues)
  if (fills.length === 0) return { parsed: first, fills }
  // Same header and columns; the row keys don't change, since they come from the timestamp and name.
  return { parsed: parseSheet(filled, { headerRow: first.headerRow, fieldMap: first.fieldMap }), fills }
}

export function describeFills(fills: Fill[]) {
  const count = (field: FilledField) => fills.filter((f) => f.field === field).length
  return [
    count('gender') && `${count('gender')} gender`,
    count('level') && `${count('level')} enrollment`,
    count('nickname') && `${count('nickname')} nickname`,
  ]
    .filter(Boolean)
    .join(', ')
}
