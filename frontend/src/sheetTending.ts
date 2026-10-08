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
  CHAT_STAGES,
  chatStageOf,
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
import { CONTACT_STATUSES, type ContactStatus } from './types'

export const STATS_TITLE = 'Sign-up statistics'
/** The title, the headline numbers and their labels, six lines of detail, and a blank line before the header. */
export const STATS_ROWS = 10

/** In columns A, B and C, in this order. Contacted At goes after the last column. */
export const FRONT_COLUMNS: AddedColumn[] = ['status', 'returning', 'groupChat']

export type StatCell = {
  text: string
  /** heading: the dark title bar; label: a section's name; big: a headline number; small: its label. */
  style?: 'heading' | 'label' | 'big' | 'small'
  swatch?: Swatch
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
   * Columns whose dropdown and colors are (re)set, replacing the app's earlier ones: all of them
   * whenever a column is added or moved, so a sheet tended before an option was added gets it.
   */
  dropdowns: NewColumn[]
  cells: { row: number; column: number; text: string }[]
  /** The whole stats block, when it's new, moved or its numbers changed. */
  stats: StatCell[][] | null
  /** Columns the tab needs for all of it. */
  columnCount: number
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
  gender: string
  level: string
  status: ContactStatus
  returning: Returning | ''
  groupChat: GroupChatStatus | null
  wantsChat: boolean
  signedUp: string
}

// Section names down column A. The last is what tells where the block ends; an older, shorter
// block ended at "Group chats".
const SECTIONS = {
  who: 'Gender & level',
  returning: 'New vs returning',
  status: 'Contact status',
  stages: 'Group chats',
  chats: 'Group chat status',
  when: 'When they signed up',
}
const LAST_SECTIONS = [SECTIONS.when, 'Group chats']

const GREY = { background: { red: 0.95, green: 0.96, blue: 0.97 }, text: { red: 0.2, green: 0.25, blue: 0.33 } }

/** The block above the header. Row 0 is the title; the rest only change with the numbers. */
export function statsBlock(people: Person[], hasDatabase: boolean, updated: string, now = Date.now()): StatCell[][] {
  const total = people.length
  const count = (test: (p: Person) => boolean) => people.filter(test).length
  const status = (s: ContactStatus) => count((p) => p.status === s)
  const notComing = count((p) => ['not_coming', 'no_room', 'no_space', 'not_inviting'].includes(p.status))
  const fresh = count((p) => p.returning === 'new')
  const returning = count((p) => p.returning === 'returning')
  const toAdd = count((p) => p.wantsChat && needsChat(p.groupChat) && p.status === 'confirmed')
  const section = (text: string): StatCell => ({ text, style: 'label' })
  const item = (label: string, n: number, swatch?: Swatch, of = total): StatCell => ({
    text: `${label}  ${n}${of ? ` (${percent(n, of)})` : ''}`,
    swatch,
  })

  const headline: [string, number, Swatch | undefined][] = [
    ['signed up', total, GREY],
    ['confirmed', status('confirmed'), STATUS_COLORS.confirmed],
    ['awaiting response', status('awaiting_response'), STATUS_COLORS.awaiting_response],
    ['not contacted yet', status('not_contacted') + status('waiting_to_contact'), STATUS_COLORS.not_contacted],
    ['no response', status('no_response'), STATUS_COLORS.no_response],
    ['not coming', notComing, STATUS_COLORS.not_coming],
    ['new', fresh, RETURNING_COLORS.new],
    ['returning', returning, RETURNING_COLORS.returning],
    ['to add to chats', toAdd, STAGE_COLORS.todo],
  ]

  const ofGender = (g: string) => people.filter((p) => p.gender === g)
  const levels = (list: Person[]) =>
    [
      ['UG', list.filter((p) => p.level === 'undergrad').length],
      ['grad', list.filter((p) => p.level === 'grad').length],
      ['other', list.filter((p) => p.level === 'other').length],
    ]
      .filter(([, n]) => n)
      .map(([l, n]) => `${n} ${l}`)
      .join(', ')
  const gender = (label: string, g: string): StatCell[] => {
    const list = ofGender(g)
    return list.length || g ? [{ text: `${label}  ${list.length}${list.length ? `  ·  ${levels(list)}` : ''}` }] : []
  }
  const confirmed = people.filter((p) => p.status === 'confirmed')

  const day = (from: number, to: number) => count((p) => {
    const age = (now - new Date(p.signedUp).getTime()) / 86_400_000
    return age >= from && age < to
  })
  const latest = people.map((p) => new Date(p.signedUp).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => b - a)[0]

  return [
    [{ text: `${STATS_TITLE}  ·  kept up to date by ISMP Registration  ·  updated ${updated}`, style: 'heading' }],
    headline.map(([, n, swatch]) => ({ text: String(n), style: 'big', swatch })),
    headline.map(([label, , swatch]) => ({ text: label, style: 'small', swatch })),
    [
      section(SECTIONS.who),
      ...gender('Girls', 'female'),
      ...gender('Guys', 'male'),
      ...(ofGender('').length ? gender('No gender', '') : []),
      item('Undergrad', count((p) => p.level === 'undergrad')),
      item('Grad', count((p) => p.level === 'grad')),
      item('Not a student', count((p) => p.level === 'other')),
    ],
    [
      section(SECTIONS.returning),
      ...(hasDatabase
        ? [
            item('New', fresh, RETURNING_COLORS.new),
            item('Returning', returning, RETURNING_COLORS.returning),
            {
              text: `Confirmed: ${confirmed.filter((p) => p.returning === 'new').length} new, ${confirmed.filter((p) => p.returning === 'returning').length} returning`,
            },
            ...(total - fresh - returning ? [{ text: `${total - fresh - returning} blank` }] : []),
          ]
        : [{ text: 'Add a “Student Database” tab to the spreadsheet to tell' }]),
    ],
    [
      section(SECTIONS.status),
      ...CONTACT_STATUSES.flatMap((s) => {
        const n = status(s.value)
        return n ? [item(s.label, n, STATUS_COLORS[s.value])] : []
      }),
    ],
    [
      section(SECTIONS.stages),
      ...CHAT_STAGES.map((stage) =>
        item(stage.label, count((p) => p.groupChat !== null && chatStageOf(p.groupChat) === stage.value), STAGE_COLORS[stage.value]),
      ),
      { text: `${toAdd} confirmed and asked to be added` },
    ],
    [
      section(SECTIONS.chats),
      ...GROUP_CHAT_STATUSES.flatMap((s) => {
        const n = count((p) => p.groupChat === s.value)
        return n ? [{ text: `${s.label}  ${n}`, swatch: STAGE_COLORS[s.stage] }] : []
      }),
    ],
    [
      section(SECTIONS.when),
      item('Past 24 hours', day(0, 1)),
      item('1–3 days ago', day(1, 3)),
      item('3–7 days ago', day(3, 7)),
      item('Over a week ago', day(7, Infinity)),
      ...(latest ? [{ text: `Latest: ${new Date(latest).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` }] : []),
    ],
    [],
  ]
}

const rowTexts = (row: (StatCell | string | undefined)[]) => {
  const texts = row.map((c) => clean(typeof c === 'string' ? c : c?.text))
  while (texts.length && !texts.at(-1)) texts.pop()
  return texts.join('\u0000')
}

/** How many rows the app's stats block takes at the top of the tab, its blank line included; 0 when there isn't one. */
export function statsRowsIn(values: string[][], headerRow: number) {
  if (!clean(values[0]?.[0]).startsWith(STATS_TITLE)) return 0
  let last = 0
  for (let r = 1; r < headerRow; r++) if (LAST_SECTIONS.includes(clean(values[r]?.[0]))) last = r
  return Math.min(last + 2, headerRow)
}

/** Null when the tab can't be read as sign-ups (no header row). */
export function planTending(
  values: string[][],
  fieldMap: FieldMap,
  database: string[][] | null,
  now = Date.now(),
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
  FRONT_COLUMNS.forEach((key, at) => {
    const original = found[key]
    if (original === undefined) {
      columnOps.push({ kind: 'insert', at })
      order.splice(at, 0, key)
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
    let groupChat = c.groupChat
    if (!cell(row, col.groupChat)) {
      groupChat = startingChat(c)
      set(row, col.groupChat, groupChatLabel(groupChat))
    }
    return { gender: c.gender, level: c.level, status, returning, groupChat, wantsChat: c.wantsChat, signedUp: c.signedUp }
  })

  // The stats block, made STATS_ROWS tall.
  const shift = STATS_ROWS - blockRows
  const rowOp: Tending['rowOp'] =
    shift > 0 ? { kind: 'insert', at: blockRows, count: shift } : shift < 0 ? { kind: 'delete', at: STATS_ROWS, count: -shift } : null
  const updated = new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const block = statsBlock(people, database !== null, updated, now)
  const statsChanged =
    rowOp !== null || columnOps.length > 0 || block.slice(1).some((row, i) => rowTexts(row) !== rowTexts(out[i + 1] ?? []))
  const rest = out.slice(blockRows)
  const final = statsChanged ? [...block.map((row) => row.map((c) => c.text)), ...rest] : out

  return {
    rowOp,
    columnOps,
    headerRow: parsed.headerRow + shift,
    newColumns,
    dropdowns:
      columnOps.length || newColumns.length
        ? FRONT_COLUMNS.map((key) => ({ column: col[key], header: COLUMN_HEADERS[key], options: OPTIONS[key] }))
        : [],
    cells: cells.map((c) => ({ ...c, row: c.row + shift })),
    stats: statsChanged ? block : null,
    columnCount: Math.max(order.length, ...block.map((r) => r.length)),
    values: final,
    changed: statsChanged || cells.length > 0,
  }
}
