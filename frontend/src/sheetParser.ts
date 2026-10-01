/**
 * Turns a Google Sheets tab into standardized sign-up rows, in the browser.
 *
 * Only name, nickname, gender, enrollment level and contact status leave this module; phone,
 * email, chat IDs and every other column are dropped here and never sent to the server. The
 * attendance, phone and email columns are only located: attendance so check-ins can be ticked off
 * in the sheet, phone and email so studentDatabase.ts can match people in the browser.
 */

export type Gender = 'female' | 'male'
/** 'other' is Enrollment Status "Other": not a student. */
export type Level = 'undergrad' | 'grad' | 'other'
export type ContactStatus =
  | 'not_contacted'
  | 'waiting_to_contact'
  | 'awaiting_response'
  | 'confirmed'
  | 'no_response'
  | 'not_coming'
  | 'no_room'
  | 'not_inviting'

export type FieldKey =
  | 'name' | 'first_name' | 'last_name' | 'nickname' | 'gender' | 'level' | 'status' | 'timestamp'
  | 'attendance' | 'phone' | 'email'

/** Located but never imported. */
export const LOCATE_ONLY: FieldKey[] = ['attendance', 'phone', 'email']

/** Field -> the header text of the column it comes from; '' means "don't use a column". */
export type FieldMap = Partial<Record<FieldKey, string>>

export type SignupRow = {
  key: string
  name: string
  nickname: string
  gender: Gender | ''
  level: Level | ''
  status: ContactStatus
}

export type ParseResult = {
  /** 0-based row index of the header in the tab. */
  headerRow: number
  headers: string[]
  columns: Partial<Record<FieldKey, number>>
  fieldMap: FieldMap
  rows: SignupRow[]
  /** 0-based row index in the tab of each of `rows`. */
  rowIndexes: number[]
  /** Headers of columns that are not imported. */
  ignored: string[]
  unrecognized: { gender: string[]; level: string[]; status: string[] }
  missing: { gender: number; level: number }
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  nickname: 'Nickname',
  gender: 'Gender',
  level: 'Enrollment status',
  status: 'Contact status',
  timestamp: 'Timestamp',
  attendance: 'Attendance',
  phone: 'Phone (for matching)',
  email: 'Email (for matching)',
}

export const FIELD_KEYS = Object.keys(FIELD_LABELS) as FieldKey[]

const HEADER_SCAN_ROWS = 40

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// Checked in order: each field takes the first column that matches its earliest pattern.
const FIELD_PATTERNS: [FieldKey, RegExp[]][] = [
  ['timestamp', [/\btimestamp\b/, /\bsubmitted\b/]],
  ['nickname', [/\bnick ?name\b/, /\bnick\b/, /\bpreferred name\b/, /\benglish name\b/]],
  ['first_name', [/^(your )?first name$/, /^given name$/]],
  ['last_name', [/^(your )?last name$/, /^(surname|family name)$/]],
  ['name', [/\bfirst (and )?last name\b/, /\bfull name\b/, /^(your |student )?name$/, /\bname\b/]],
  ['gender', [/\bgender\b/, /\bsex\b/]],
  ['level', [/\benrollment\b/, /\b(student|academic|degree|school) level\b/, /\byear in school\b/, /\bdegree\b/, /^level$/]],
  ['status', [/\bcontact status\b/, /^status$/]],
  ['attendance', [/\battend(ance|ed)?\b/, /\bchecked in\b/, /^present$/]],
  ['phone', [/\b(phone|cell|mobile)\b/]],
  ['email', [/\be ?mail\b/]],
]

// Never treated as a name column even though the header mentions "name".
const NOT_A_NAME = /\b(nick|user ?name|wechat|line|instagram|email|mentor|preferred|english)\b/

function autoColumns(headers: string[]): Partial<Record<FieldKey, number>> {
  const normalized = headers.map(normalize)
  const used = new Set<number>()
  const columns: Partial<Record<FieldKey, number>> = {}
  for (const [field, patterns] of FIELD_PATTERNS) {
    for (const pattern of patterns) {
      const index = normalized.findIndex(
        (h, i) => h && !used.has(i) && pattern.test(h) && !(field === 'name' && NOT_A_NAME.test(h)),
      )
      if (index !== -1) {
        columns[field] = index
        used.add(index)
        break
      }
    }
  }
  return columns
}

function hasName(columns: Partial<Record<FieldKey, number>>) {
  return columns.name !== undefined || columns.first_name !== undefined
}

/** Columns for each field: a saved/chosen header wins, otherwise the auto match. */
function resolveColumns(headers: string[], fieldMap: FieldMap = {}) {
  const auto = autoColumns(headers)
  const columns: Partial<Record<FieldKey, number>> = {}
  for (const field of FIELD_KEYS) {
    const wanted = fieldMap[field]
    const chosen = wanted ? headers.findIndex((h) => normalize(h) === normalize(wanted)) : -1
    if (chosen !== -1) columns[field] = chosen
  }
  const taken = new Set(Object.values(columns))
  for (const field of FIELD_KEYS) {
    const index = auto[field]
    if (columns[field] === undefined && fieldMap[field] !== '' && index !== undefined && !taken.has(index)) {
      columns[field] = index
      taken.add(index)
    }
  }
  return columns
}

/** The header is the row near the top that names the most known fields (sign-up sheets often have intro rows). */
export function findHeaderRow(values: string[][], fieldMap?: FieldMap): number {
  let best = -1
  let bestScore = 1
  for (let r = 0; r < Math.min(values.length, HEADER_SCAN_ROWS); r++) {
    const columns = resolveColumns((values[r] ?? []).map((h) => clean(h)), fieldMap)
    const score = Object.keys(columns).length
    if (hasName(columns) && score > bestScore) {
      best = r
      bestScore = score
    }
  }
  return best
}

export function genderOf(text: string): Gender | '' {
  const t = normalize(text)
  if (/^(f|female|woman|girl|women|girls)$/.test(t)) return 'female'
  if (/^(m|male|man|guy|boy|men|guys)$/.test(t)) return 'male'
  return ''
}

export function levelOf(text: string): Level | '' {
  const t = normalize(text)
  if (!t) return ''
  if (t === 'other') return 'other'
  if (/undergrad|exchange|freshman|sophomore|junior|senior|bachelor/.test(t)) return 'undergrad'
  if (/master|\bms\b|\bma\b|mba|ph ?d|doctor|grad|visiting|scholar|postdoc/.test(t)) return 'grad'
  return ''
}

const STATUS_BY_TEXT: Record<string, ContactStatus> = {
  'not contacted': 'not_contacted',
  'waiting to contact': 'waiting_to_contact',
  'awaiting response': 'awaiting_response',
  awaiting: 'awaiting_response',
  confirmed: 'confirmed',
  'no response': 'no_response',
  'not coming': 'not_coming',
  'no room': 'no_room',
  'not inviting': 'not_inviting',
}

export function statusOf(text: string): ContactStatus | null {
  const t = normalize(text)
  if (!t) return 'not_contacted'
  return STATUS_BY_TEXT[t] ?? null
}

const BLANK_NICKNAME = /^(n ?a|none|no|nil|null)?$/

function clean(text: string | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim()
}

// cyrb53: a small stable hash, only used to recognize the same row again on re-sync.
function hash(text: string) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

export class SheetFormatError extends Error {}

export function parseSheet(values: string[][], options: { headerRow?: number; fieldMap?: FieldMap } = {}): ParseResult {
  const headerRow = options.headerRow ?? findHeaderRow(values, options.fieldMap)
  if (headerRow < 0 || headerRow >= values.length) {
    throw new SheetFormatError('Couldn’t find a header row with a name column in the first 40 rows.')
  }
  const headers = (values[headerRow] ?? []).map((h) => clean(h))
  const columns = resolveColumns(headers, options.fieldMap)
  if (!hasName(columns)) throw new SheetFormatError('Pick which column has the name.')

  const fieldMap: FieldMap = {}
  for (const field of FIELD_KEYS) fieldMap[field] = columns[field] === undefined ? '' : headers[columns[field]!]
  const usedColumns = new Set(FIELD_KEYS.filter((f) => !LOCATE_ONLY.includes(f)).map((f) => columns[f]))
  const ignored = headers.filter((h, i) => h && !usedColumns.has(i))

  const cell = (row: string[], field: FieldKey) => (columns[field] === undefined ? '' : clean(row[columns[field]!]))
  const unrecognized = { gender: new Set<string>(), level: new Set<string>(), status: new Set<string>() }
  const missing = { gender: 0, level: 0 }
  const seenKeys = new Map<string, number>()
  const rows: SignupRow[] = []
  const rowIndexes: number[] = []
  const headerName = normalize(columns.name !== undefined ? headers[columns.name] : headers[columns.first_name!])

  for (const [offset, row] of values.slice(headerRow + 1).entries()) {
    const name = (cell(row, 'name') || clean(`${cell(row, 'first_name')} ${cell(row, 'last_name')}`)).slice(0, 200)
    if (!name || normalize(name) === headerName) continue

    const genderText = cell(row, 'gender')
    const levelText = cell(row, 'level')
    const statusText = cell(row, 'status')
    const gender = genderOf(genderText)
    const level = levelOf(levelText)
    const status = statusOf(statusText)
    if (genderText && !gender) unrecognized.gender.add(genderText)
    if (levelText && !level) unrecognized.level.add(levelText)
    if (status === null) unrecognized.status.add(statusText)
    if (!gender) missing.gender++
    if (!level) missing.level++

    const nickname = cell(row, 'nickname')
    const base = hash(`${cell(row, 'timestamp')}|${normalize(name)}`)
    const seen = seenKeys.get(base) ?? 0
    seenKeys.set(base, seen + 1)
    rowIndexes.push(headerRow + 1 + offset)
    rows.push({
      key: seen ? `${base}-${seen + 1}` : base,
      name,
      nickname: BLANK_NICKNAME.test(normalize(nickname)) || normalize(nickname) === normalize(name) ? '' : nickname.slice(0, 120),
      gender,
      level,
      status: status ?? 'not_contacted',
    })
  }

  return {
    headerRow,
    headers,
    columns,
    fieldMap,
    rows,
    rowIndexes,
    ignored,
    unrecognized: {
      gender: [...unrecognized.gender],
      level: [...unrecognized.level],
      status: [...unrecognized.status],
    },
    missing,
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
// Cell text goes into a warning, so keep it short.
const quote = (values: string[]) => {
  const shown = values.slice(0, 5).map((v) => `“${v.length > 30 ? `${v.slice(0, 29)}…` : v}”`)
  return values.length > 5 ? `${shown.join(', ')} and ${values.length - 5} more` : shown.join(', ')
}

/** Anything about the tab worth a second look, in plain words. Empty when it's formatted as expected. */
export function importWarnings(parsed: ParseResult): string[] {
  const { columns, rows, unrecognized, missing } = parsed
  const warnings: string[] = []
  if (columns.gender === undefined) warnings.push('No Gender column found, so check-in will ask everyone.')
  else if (missing.gender) {
    const values = unrecognized.gender.length ? ` (unrecognized: ${quote(unrecognized.gender)})` : ''
    warnings.push(`${plural(missing.gender, 'sign-up has', 'sign-ups have')} no gender${values}, so check-in will ask.`)
  }
  if (columns.level === undefined) warnings.push('No Enrollment Status column found, so check-in will ask everyone.')
  else if (missing.level) {
    const values = unrecognized.level.length ? ` (unrecognized: ${quote(unrecognized.level)})` : ''
    warnings.push(`${plural(missing.level, 'sign-up has', 'sign-ups have')} no enrollment status${values}, so check-in will ask.`)
  }
  if (columns.status === undefined) warnings.push('No Contact Status column found, so everyone counts as Not contacted.')
  else if (unrecognized.status.length) {
    warnings.push(`Unrecognized contact statuses ${quote(unrecognized.status)} count as Not contacted.`)
  }
  const others = rows.filter((r) => r.level === 'other').length
  if (others) {
    warnings.push(`${plural(others, 'sign-up has', 'sign-ups have')} enrollment Other: not planned for, and check-in asks before admitting them.`)
  }
  return warnings
}
