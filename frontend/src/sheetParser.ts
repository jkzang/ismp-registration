/**
 * Turns a Google Sheets tab into standardized sign-up rows, in the browser.
 *
 * Only name, nickname, gender, enrollment level and contact status leave this module; phone,
 * email, chat IDs and every other column are dropped here and never sent to the server.
 */

export type Gender = 'female' | 'male'
export type Level = 'undergrad' | 'grad'
export type ContactStatus = 'not_contacted' | 'awaiting_response' | 'confirmed' | 'no_response' | 'not_inviting'

export type FieldKey = 'name' | 'first_name' | 'last_name' | 'nickname' | 'gender' | 'level' | 'status' | 'timestamp'

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
  if (/undergrad|exchange|freshman|sophomore|junior|senior|bachelor/.test(t)) return 'undergrad'
  if (/master|\bms\b|\bma\b|mba|ph ?d|doctor|grad|visiting|scholar|postdoc/.test(t)) return 'grad'
  return ''
}

const STATUS_BY_TEXT: Record<string, ContactStatus> = {
  'not contacted': 'not_contacted',
  'awaiting response': 'awaiting_response',
  awaiting: 'awaiting_response',
  confirmed: 'confirmed',
  'no response': 'no_response',
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
  const usedColumns = new Set(Object.values(columns))
  const ignored = headers.filter((h, i) => h && !usedColumns.has(i))

  const cell = (row: string[], field: FieldKey) => (columns[field] === undefined ? '' : clean(row[columns[field]!]))
  const unrecognized = { gender: new Set<string>(), level: new Set<string>(), status: new Set<string>() }
  const missing = { gender: 0, level: 0 }
  const seenKeys = new Map<string, number>()
  const rows: SignupRow[] = []
  const headerName = normalize(columns.name !== undefined ? headers[columns.name] : headers[columns.first_name!])

  for (const row of values.slice(headerRow + 1)) {
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
    ignored,
    unrecognized: {
      gender: [...unrecognized.gender],
      level: [...unrecognized.level],
      status: [...unrecognized.status],
    },
    missing,
  }
}
