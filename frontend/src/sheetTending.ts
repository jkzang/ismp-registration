/**
 * What the app writes into a sign-up tab whenever it reads it (at import, on the sheet's pages, and
 * when the app opens):
 *
 * - Contact Status, New or Returning and Group Chat Status in columns A, B and C (added there, or
 *   moved there from wherever they were), and Contacted At after the last column, as dropdowns
 *   colored like the app's chips.
 * - Blank cells in them filled: Not Contacted; New or Returning by looking each person up in the
 *   spreadsheet's Student Database tab; the group chat status from their answer on the form
 *   ("Yes!" is Already In Group, "No - Please help me join!" is Not Invited, "No thank you" is
 *   Doesn't Want To Join).
 * - Awaiting response starts a 48-hour clock in Contacted At (when it's blank), and at the end of it
 *   they're moved to No Response.
 * - A block of sign-up statistics above the header, rewritten when the numbers change.
 *
 * Only blank cells are filled, so anything typed in the sheet stays. Nothing here reaches the
 * server. This file only works it out; google.ts writes it.
 */
import { parseSheet, type FieldMap, type ParseResult } from './sheetParser'
import {
  COLUMN_HEADERS,
  formatStamp,
  GROUP_CHAT_STATUSES,
  groupChatLabel,
  needsChat,
  NO_RESPONSE_AFTER_MS,
  parseStamp,
  RETURNING_COLORS,
  RETURNING_LABELS,
  STAGE_COLORS,
  STATUS_COLORS,
  titleCase,
  type AddedColumn,
  type GroupChatStatus,
  type Returning,
  type Swatch,
} from './signupColumns'
import { extraColumns, locateFieldMap, readContacts, statusText, type Contact } from './signupTracker'
import { databaseMatcher } from './studentDatabase'
import { CONTACT_STATUSES, type ContactStatus, type SeatingPlan } from './types'

export const STATS_TITLE = 'Sign-up statistics'
/**
 * The title, a gap, six side-by-side tables (a header and up to nine rows each), and two empty rows
 * between them and the sheet's own header.
 */
export const STATS_ROWS = 14
const TABLE_TOP = 2
const TABLE_ROWS = 9

/** Right after the timestamp (in A), in this order. Contacted At goes after the last column. */
export const FRONT_COLUMNS: AddedColumn[] = ['status', 'returning', 'groupChat']

/** What the expected attendance is worked out from, as the tables are planned (see signupOverview.ts). */
export type Turnout = Pick<SeatingPlan, 'show_up_rates' | 'walk_in_rate'> & {
  /** Keys of the sign-ups already checked in. */
  checkedIn: Set<string>
  capacity: number | null
}

/**
 * Bumped when a new version of the app has to redo what an earlier one wrote: the columns' dropdowns
 * and colors and the stats are set again. The version a tab was last tended with is kept in the tab's
 * developer metadata (invisible). 2 corrected the first version's group chat statuses; 3 made the
 * stats collapsible; 4 puts back the dropdowns 3 erased trying to make them chips.
 */
export const TEND_VERSION = 4

export type StatCell = {
  text: string
  /** heading: the title bar; head: a table's name; name: a row's name; value: its number; big: the headline number. */
  style?: 'heading' | 'head' | 'name' | 'value' | 'big'
  /** A name colored like its chip in the sheet. */
  swatch?: Swatch
  /** The table's last row, which closes its box. */
  last?: boolean
}

export type NewColumn = { column: number; header: string; options: { label: string; swatch: Swatch }[] }

/** Column changes, in order; each index is as the columns stand after the ones before. */
export type ColumnOp = { kind: 'insert'; at: number } | { kind: 'move'; from: number; to: number }

/**
 * Rows and columns are 0-based. `rowOp` and then `columnOps` go first; every other row and column
 * is where it'll be after them.
 */
export type Tending = {
  /** Rows added at (or removed from) `at` so the stats block is STATS_ROWS tall. */
  rowOp: { kind: 'insert' | 'delete'; at: number; count: number } | null
  columnOps: ColumnOp[]
  headerRow: number
  newColumns: NewColumn[]
  /**
   * Columns whose dropdown, colors and look are (re)set, replacing the app's earlier ones: all of
   * them whenever a column is added or moved, the stats block changes shape, or the tab was tended
   * by an earlier version.
   */
  dropdowns: NewColumn[]
  cells: { row: number; column: number; text: string }[]
  /** The whole stats block, when it's new, moved or its numbers changed. */
  stats: StatCell[][] | null
  /** Columns the tab needs for all of it. */
  columnCount: number
  /** Rows the tab needs: the empty ones below go. */
  rowCount: number
  /** The tab was tended by an earlier version: TEND_VERSION goes into its metadata. */
  setVersion: boolean
  /** The tab's values with all of it in. */
  values: string[][]
  changed: boolean
}

const clean = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
const percent = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%')

const OPTIONS: Record<AddedColumn, NewColumn['options']> = {
  status: CONTACT_STATUSES.map((s) => ({ label: titleCase(s.label), swatch: STATUS_COLORS[s.value] })),
  returning: (['new', 'returning'] as const).map((r) => ({ label: RETURNING_LABELS[r], swatch: RETURNING_COLORS[r] })),
  groupChat: GROUP_CHAT_STATUSES.map((s) => ({ label: s.label, swatch: STAGE_COLORS[s.stage] })),
  contactedAt: [],
}

/** Their group chat status when the cell is blank. */
function startingChat(contact: Pick<Contact, 'chatAnswer' | 'chatTicked' | 'socials'>): GroupChatStatus {
  if (contact.chatAnswer === 'declined') return 'declined'
  if (contact.chatAnswer === 'in') return 'already_in'
  if (!contact.chatTicked) return 'not_invited'
  // An older sheet's ticked "Added to Group Chat" box: LINE if that's the only ID they gave.
  const line = contact.socials.some((s) => /\bline\b/i.test(s.label))
  const wechat = contact.socials.some((s) => /we ?chat/i.test(s.label))
  return line && !wechat ? 'added_line' : 'added_wechat'
}

type Person = {
  key: string
  gender: string
  level: string
  status: ContactStatus
  returning: Returning | ''
  groupChat: GroupChatStatus | null
  wantsChat: boolean
  signedUp: string
}

/** Expected attendance: each sign-up's chance from their status, plus walk-ins. Null without a plan to go by. */
export function expectedTurnout(people: Pick<Person, 'key' | 'level' | 'status'>[], turnout: Turnout | null) {
  if (!turnout) return null
  const checkedIn = people.filter((p) => turnout.checkedIn.has(p.key)).length
  const likely = Math.round(
    people.reduce(
      (sum, p) => sum + (turnout.checkedIn.has(p.key) ? 1 : p.level === 'other' ? 0 : (turnout.show_up_rates[p.status] ?? 0)),
      0,
    ),
  )
  const walkIns = Math.round(turnout.walk_in_rate * likely)
  return { likely, walkIns, total: likely + walkIns, checkedIn }
}


/** The tables in the block, left to right, two columns each. */
function statsTables(people: Person[], hasDatabase: boolean, turnout: Turnout | null) {
  const total = people.length
  const count = (test: (p: Person) => boolean) => people.filter(test).length
  const status = (s: ContactStatus) => count((p) => p.status === s)
  const share = (n: number, of = total) => `${n}  ·  ${percent(n, of)}`
  type Row = [name: string, value: string, swatch?: Swatch]

  const fresh = count((p) => p.returning === 'new')
  const returning = count((p) => p.returning === 'returning')
  const toAdd = count((p) => p.wantsChat && needsChat(p.groupChat) && p.status === 'confirmed')
  const confirmed = people.filter((p) => p.status === 'confirmed')
  const expected = expectedTurnout(people, turnout)
  const capacity = turnout?.capacity ?? null

  const tables: { name: string; rows: Row[]; big?: boolean }[] = [
    {
      name: 'Expected attendance',
      big: true,
      rows: expected
        ? [
            ['Expected', String(expected.total)],
            ['From sign-ups', String(expected.likely)],
            [`Walk-ins (+${percent(turnout!.walk_in_rate, 1)})`, String(expected.walkIns)],
            ['Capacity', capacity === null ? '—' : String(capacity)],
            ...(capacity === null
              ? []
              : expected.total > capacity
                ? [['Over capacity', String(expected.total - capacity), STATUS_COLORS.not_coming] as Row]
                : [['Room left', String(capacity - expected.total), STATUS_COLORS.confirmed] as Row]),
            ...(expected.checkedIn ? [['Checked in', String(expected.checkedIn)] as Row] : []),
          ]
        : [['Expected', '—'], ['Open the sheet in the app', '']],
    },
    {
      name: 'Overview',
      rows: [
        ['Signed up', String(total)],
        ['Confirmed', share(status('confirmed')), STATUS_COLORS.confirmed],
        ['Awaiting response', share(status('awaiting_response')), STATUS_COLORS.awaiting_response],
        ['Not contacted yet', share(status('not_contacted') + status('waiting_to_contact')), STATUS_COLORS.not_contacted],
        ['No response', share(status('no_response')), STATUS_COLORS.no_response],
        ['Not coming', share(count((p) => ['not_coming', 'no_room', 'no_space', 'not_inviting'].includes(p.status))), STATUS_COLORS.not_coming],
        ['New', share(fresh), RETURNING_COLORS.new],
        ['Returning', share(returning), RETURNING_COLORS.returning],
        ['To add to chats', String(toAdd), STAGE_COLORS.todo],
      ],
    },
    {
      name: 'Contact status',
      rows: CONTACT_STATUSES.map((s) => [titleCase(s.label), share(status(s.value)), STATUS_COLORS[s.value]]),
    },
    {
      name: 'Group chats',
      rows: GROUP_CHAT_STATUSES.map((s) => [s.label, share(count((p) => p.groupChat === s.value)), STAGE_COLORS[s.stage]]),
    },
    {
      name: 'Gender & level',
      rows: [
        ['Girls', share(count((p) => p.gender === 'female'))],
        ['Guys', share(count((p) => p.gender === 'male'))],
        ...(count((p) => !p.gender) ? [['No gender', share(count((p) => !p.gender))] as Row] : []),
        ['Undergrad', share(count((p) => p.level === 'undergrad'))],
        ['Grad', share(count((p) => p.level === 'grad'))],
        ['Not a student', share(count((p) => p.level === 'other'))],
        ...(count((p) => !p.level) ? [['No level', share(count((p) => !p.level))] as Row] : []),
      ],
    },
    {
      name: 'New vs returning',
      rows: hasDatabase
        ? [
            ['New', share(fresh), RETURNING_COLORS.new],
            ['Returning', share(returning), RETURNING_COLORS.returning],
            ...(total - fresh - returning ? [['Not looked up', share(total - fresh - returning)] as Row] : []),
            ['Confirmed, new', share(confirmed.filter((p) => p.returning === 'new').length, confirmed.length)],
            ['Confirmed, returning', share(confirmed.filter((p) => p.returning === 'returning').length, confirmed.length)],
          ]
        : [['Add a “Student Database” tab', '—']],
    },
  ]
  return { tables, expected }
}

/** The block above the header: the title, then each table in two columns, side by side. */
export function statsBlock(people: Person[], hasDatabase: boolean, updated: string, turnout: Turnout | null = null): StatCell[][] {
  const { tables, expected } = statsTables(people, hasDatabase, turnout)
  const block: StatCell[][] = Array.from({ length: STATS_ROWS }, () => [])
  block[0] = [
    {
      text: `${STATS_TITLE}  ·  expected attendance ${expected ? expected.total : '—'}  ·  ${people.length} signed up  ·  updated ${updated} by ISMP Registration  ·  − / + on the left hides or shows these`,
      style: 'heading',
    },
  ]
  tables.forEach((table, t) => {
    const column = t * 2
    const put = (row: number, cells: StatCell[]) => {
      const line = block[row]
      while (line.length < column) line.push({ text: '' })
      line.splice(column, 2, ...cells)
    }
    put(TABLE_TOP, [{ text: table.name, style: 'head' }, { text: 'Count', style: 'head' }])
    table.rows.slice(0, TABLE_ROWS).forEach(([name, value, swatch], i) => {
      const last = i === Math.min(table.rows.length, TABLE_ROWS) - 1
      const big = table.big && i === 0
      put(TABLE_TOP + 1 + i, [
        { text: name, style: big ? 'big' : 'name', swatch, last },
        { text: value, style: big ? 'big' : 'value', last },
      ])
    })
  })
  return block
}

const rowTexts = (row: (StatCell | string | undefined)[]) => {
  const texts = row.map((c) => clean(typeof c === 'string' ? c : c?.text))
  while (texts.length && !texts.at(-1)) texts.pop()
  return texts.join('\u0000')
}

/**
 * How many rows the app's stats block takes at the top of the tab, its empty rows included; 0 when
 * there isn't one. Every layout so far is the title, maybe an empty row, rows of numbers, then empty
 * rows before the header.
 */
export function statsRowsIn(values: string[][], headerRow: number) {
  if (!clean(values[0]?.[0]).startsWith(STATS_TITLE)) return 0
  const empty = (r: number) => !(values[r] ?? []).some((c) => clean(c))
  let r = 1
  while (r < headerRow && empty(r)) r++
  while (r < headerRow && !empty(r)) r++
  while (r < headerRow && empty(r)) r++
  return r
}

/**
 * Null when the tab can't be read as sign-ups (no header row). `turnout` (from the sheet's plan)
 * gives the expected attendance; without it the stats show a dash.
 */
export function planTending(
  values: string[][],
  fieldMap: FieldMap,
  database: string[][] | null,
  {
    now = Date.now(),
    turnout = null,
    version = TEND_VERSION,
  }: { now?: number; turnout?: Turnout | null; /** The version the tab was last tended with; 0 if never. */ version?: number } = {},
): Tending | null {
  let parsed: ParseResult
  try {
    parsed = parseSheet(values, { fieldMap: locateFieldMap(fieldMap) })
  } catch {
    return null
  }
  const blockRows = statsRowsIn(values, parsed.headerRow)

  // Columns first: each original column by its index, and the new ones by name.
  const width = Math.max(0, ...values.map((r) => r.length))
  const order: (number | AddedColumn)[] = Array.from({ length: width }, (_, i) => i)
  const extra = extraColumns(parsed.headers, new Set(Object.values(parsed.columns)))
  const found: Record<AddedColumn, number | undefined> = {
    status: parsed.columns.status,
    returning: extra.returning,
    groupChat: extra.groupChat,
    contactedAt: extra.contactedAt,
  }
  const columnOps: ColumnOp[] = []
  // The timestamp in A, then the three status columns.
  const timestamp = parsed.columns.timestamp
  const front: (AddedColumn | 'timestamp')[] = [...(timestamp !== undefined ? ['timestamp' as const] : []), ...FRONT_COLUMNS]
  front.forEach((key, at) => {
    const original = key === 'timestamp' ? timestamp : found[key]
    if (original === undefined) {
      columnOps.push({ kind: 'insert', at })
      order.splice(at, 0, key as AddedColumn)
      return
    }
    const from = order.indexOf(original)
    if (from === at) return
    columnOps.push({ kind: 'move', from, to: at })
    order.splice(from, 1)
    order.splice(at, 0, original)
  })
  if (found.contactedAt === undefined) order.push('contactedAt')
  const out = values.map((r) => {
    const row = order.map((c) => (typeof c === 'number' ? r[c] ?? '' : ''))
    while (row.length && !row.at(-1)) row.pop()
    return row
  })
  const col = Object.fromEntries(
    (Object.keys(COLUMN_HEADERS) as AddedColumn[]).map((key) => [key, order.indexOf(found[key] ?? key)]),
  ) as Record<AddedColumn, number>

  // Then the cells, in the rows as they are now; they're shifted for the stats block at the end.
  const cells: Tending['cells'] = []
  const set = (row: number, column: number, text: string) => {
    const r = (out[row] ??= [])
    while (r.length <= column) r.push('')
    r[column] = text
    cells.push({ row, column, text })
  }
  const cell = (row: number, column: number) => clean(out[row]?.[column])
  const newColumns: NewColumn[] = []
  for (const key of Object.keys(COLUMN_HEADERS) as AddedColumn[]) {
    if (found[key] !== undefined) continue
    newColumns.push({ column: col[key], header: COLUMN_HEADERS[key], options: OPTIONS[key] })
    set(parsed.headerRow, col[key], COLUMN_HEADERS[key])
  }

  const upgrading = version < TEND_VERSION
  const reparsed = parseSheet(out, { headerRow: parsed.headerRow, fieldMap: locateFieldMap(fieldMap) })
  const { contacts } = readContacts(out, fieldMap)
  const matchOf = database ? databaseMatcher(out, reparsed, database) : null
  const people: Person[] = contacts.map((c, i) => {
    const row = c.row
    let status = c.status
    if (!cell(row, col.status)) set(row, col.status, statusText(out, reparsed, 'not_contacted'))
    if (status === 'awaiting_response') {
      const contacted = parseStamp(c.contactedAt)
      if (!c.contactedAt) set(row, col.contactedAt, formatStamp(new Date(now)))
      else if (contacted !== null && now - contacted >= NO_RESPONSE_AFTER_MS) {
        status = 'no_response'
        set(row, col.status, statusText(out, reparsed, 'no_response'))
      }
    }
    let returning = c.returning
    if (!cell(row, col.returning) && matchOf) {
      returning = matchOf(i) ? 'returning' : 'new'
      set(row, col.returning, RETURNING_LABELS[returning])
    }
    // The first version read "No - Please help me join!" as Doesn't Want To Join and "Yes" as Not
    // Invited; once, on catching up from it, those are put right.
    let groupChat = c.groupChat
    const starting = startingChat(c)
    const firstVersionGuess =
      version < 2 &&
      ((c.chatAnswer === 'add' && groupChat === 'declined') || (c.chatAnswer !== 'add' && groupChat === 'not_invited' && starting !== 'not_invited'))
    if (!cell(row, col.groupChat) || firstVersionGuess) {
      groupChat = starting
      set(row, col.groupChat, groupChatLabel(groupChat))
    }
    return { key: c.key, gender: c.gender, level: c.level, status, returning, groupChat, wantsChat: c.wantsChat, signedUp: c.signedUp }
  })

  // The stats block, made STATS_ROWS tall.
  const shift = STATS_ROWS - blockRows
  const rowOp: Tending['rowOp'] =
    shift > 0 ? { kind: 'insert', at: blockRows, count: shift } : shift < 0 ? { kind: 'delete', at: STATS_ROWS, count: -shift } : null
  const updated = new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const block = statsBlock(people, database !== null, updated, turnout)
  const statsChanged =
    rowOp !== null || columnOps.length > 0 || upgrading || block.slice(1).some((row, i) => rowTexts(row) !== rowTexts(out[i + 1] ?? []))
  const rest = out.slice(blockRows)
  const final = statsChanged ? [...block.map((row) => row.map((c) => c.text)), ...rest] : out
  const headerRow = parsed.headerRow + shift
  // Sheets keeps a row under the frozen header, even with no sign-ups yet.
  const lastRow = Math.max(headerRow + 2, final.length)

  return {
    rowOp,
    columnOps,
    headerRow,
    newColumns,
    dropdowns:
      // A new layout or a new version comes with the columns' dropdowns and colors set again.
      columnOps.length || newColumns.length || rowOp || upgrading
        ? FRONT_COLUMNS.map((key) => ({ column: col[key], header: COLUMN_HEADERS[key], options: OPTIONS[key] }))
        : [],
    cells: cells.map((c) => ({ ...c, row: c.row + shift })),
    stats: statsChanged ? block : null,
    columnCount: Math.max(order.length, ...block.map((r) => r.length)),
    rowCount: lastRow,
    setVersion: upgrading,
    values: final,
    changed: statsChanged || cells.length > 0 || upgrading,
  }
}
