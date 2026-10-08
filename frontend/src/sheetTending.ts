/**
 * What the app writes into a sign-up tab whenever it reads it (at import, on the sheet's pages, and
 * when the app opens):
 *
 * - The Contact Status, New or Returning, Group Chat Status and Contacted At columns, added after
 *   the last column when missing, as dropdowns colored like the app's chips.
 * - Blank cells in them filled: Not Contacted; New or Returning by looking each person up in the
 *   spreadsheet's Student Database tab; Doesn't Want To Join for whoever said no to the group chats,
 *   Not Invited for everyone else.
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
import { extraColumns, locateFieldMap, readContacts, statusText } from './signupTracker'
import { databaseMatcher } from './studentDatabase'
import { CONTACT_STATUSES, type ContactStatus } from './types'

export const STATS_TITLE = 'Sign-up statistics'
/** The title, four lines of numbers and a blank line before the header. */
export const STATS_ROWS = 6

export type StatCell = { text: string; swatch?: Swatch; bold?: boolean }

export type NewColumn = { column: number; header: string; options: { label: string; swatch: Swatch }[] }

/** Rows and columns are 0-based, and where they'll be once the stats block is in. */
export type Tending = {
  /** The stats block isn't in the tab yet, so STATS_ROWS rows go in at the top first. */
  insertStats: boolean
  headerRow: number
  newColumns: NewColumn[]
  cells: { row: number; column: number; text: string }[]
  /** The whole stats block, when it's new or its numbers changed. */
  stats: StatCell[][] | null
  /** Columns the tab needs for all of it. */
  columnCount: number
  /** The tab's values with all of it in. */
  values: string[][]
  changed: boolean
}

const clean = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim()
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const OPTIONS: Record<AddedColumn, NewColumn['options']> = {
  status: CONTACT_STATUSES.map((s) => ({ label: titleCase(s.label), swatch: STATUS_COLORS[s.value] })),
  returning: (['new', 'returning'] as const).map((r) => ({ label: RETURNING_LABELS[r], swatch: RETURNING_COLORS[r] })),
  groupChat: GROUP_CHAT_STATUSES.map((s) => ({ label: s.label, swatch: STAGE_COLORS[s.stage] })),
  contactedAt: [],
}

/** Their group chat status when the cell is blank. */
function startingChat(contact: { declinedChat: boolean; chatTicked: boolean; socials: { label: string }[] }): GroupChatStatus {
  if (contact.declinedChat) return 'declined'
  if (!contact.chatTicked) return 'not_invited'
  // An older sheet's ticked "Added to Group Chat" box: LINE if that's the only ID they gave.
  const line = contact.socials.some((s) => /\bline\b/i.test(s.label))
  const wechat = contact.socials.some((s) => /we ?chat/i.test(s.label))
  return line && !wechat ? 'added_line' : 'added_wechat'
}

type Person = { gender: string; level: string; status: ContactStatus; returning: Returning | ''; groupChat: GroupChatStatus | null }

/** The block above the header. Row 0 is the title; the rest only change with the numbers. */
export function statsBlock(people: Person[], hasDatabase: boolean, updated: string): StatCell[][] {
  const count = (test: (p: Person) => boolean) => people.filter(test).length
  const label = (text: string): StatCell => ({ text, bold: true })
  const returning = count((p) => p.returning === 'returning')
  const fresh = count((p) => p.returning === 'new')
  const unknown = people.length - returning - fresh
  return [
    [{ text: `${STATS_TITLE}  ·  kept up to date by ISMP Registration, updated ${updated}`, bold: true }],
    [
      label('Sign-ups'),
      { text: `${people.length} signed up`, bold: true },
      { text: plural(count((p) => p.gender === 'female'), 'girl') },
      { text: plural(count((p) => p.gender === 'male'), 'guy') },
      { text: `${count((p) => p.level === 'undergrad')} undergrad` },
      { text: `${count((p) => p.level === 'grad')} grad` },
      { text: `${count((p) => p.level === 'other')} not a student` },
    ],
    [
      label('New or returning'),
      ...(hasDatabase
        ? [
            { text: `${fresh} new`, swatch: RETURNING_COLORS.new },
            { text: `${returning} returning`, swatch: RETURNING_COLORS.returning },
            ...(unknown ? [{ text: `${unknown} blank` }] : []),
          ]
        : [{ text: 'Add a “Student Database” tab to tell' }]),
    ],
    [
      label('Contact status'),
      ...CONTACT_STATUSES.flatMap((s) => {
        const n = count((p) => p.status === s.value)
        return n ? [{ text: `${n} ${s.label.toLowerCase()}`, swatch: STATUS_COLORS[s.value] }] : []
      }),
    ],
    [
      label('Group chats'),
      ...CHAT_STAGES.map((stage) => ({
        text: `${count((p) => p.groupChat !== null && chatStageOf(p.groupChat) === stage.value)} ${stage.label === 'N/A' ? 'N/A' : stage.label.toLowerCase()}`,
        swatch: STAGE_COLORS[stage.value],
      })),
    ],
    [],
  ]
}

const rowTexts = (row: (StatCell | string | undefined)[]) => {
  const texts = row.map((c) => clean(typeof c === 'string' ? c : c?.text))
  while (texts.length && !texts.at(-1)) texts.pop()
  return texts.join('\u0000')
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
  const hasStats = clean(values[0]?.[0]).startsWith(STATS_TITLE)
  const offset = hasStats ? 0 : STATS_ROWS
  const out = values.map((r) => [...r])
  const cells: Tending['cells'] = []
  const set = (row: number, column: number, text: string) => {
    const r = (out[row] ??= [])
    while (r.length <= column) r.push('')
    r[column] = text
    cells.push({ row: row + offset, column, text })
  }
  const cell = (row: number, column: number) => clean(out[row]?.[column])

  // Missing columns go after the last one in use from the header down.
  let next = Math.max(...out.slice(parsed.headerRow).map((r) => r.length), 0)
  const extra = extraColumns(parsed.headers, new Set(Object.values(parsed.columns)))
  const columns: Record<AddedColumn, number | undefined> = {
    status: parsed.columns.status,
    returning: extra.returning,
    groupChat: extra.groupChat,
    contactedAt: extra.contactedAt,
  }
  const newColumns: NewColumn[] = []
  for (const key of Object.keys(COLUMN_HEADERS) as AddedColumn[]) {
    if (columns[key] !== undefined) continue
    columns[key] = next++
    newColumns.push({ column: columns[key], header: COLUMN_HEADERS[key], options: OPTIONS[key] })
    set(parsed.headerRow, columns[key], COLUMN_HEADERS[key])
  }
  const col = columns as Record<AddedColumn, number>

  const { contacts } = readContacts(values, fieldMap)
  const matchOf = database ? databaseMatcher(values, parsed, database) : null
  const people: Person[] = contacts.map((c, i) => {
    const row = c.row
    let status = c.status
    if (!cell(row, col.status)) set(row, col.status, statusText(values, parsed, 'not_contacted'))
    if (status === 'awaiting_response') {
      const contacted = parseStamp(c.contactedAt)
      if (!c.contactedAt) set(row, col.contactedAt, formatStamp(new Date(now)))
      else if (contacted !== null && now - contacted >= NO_RESPONSE_AFTER_MS) {
        status = 'no_response'
        set(row, col.status, statusText(values, parsed, 'no_response'))
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
    return { gender: c.gender, level: c.level, status, returning, groupChat }
  })

  const updated = new Date(now).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  const block = statsBlock(people, database !== null, updated)
  const statsChanged = !hasStats || block.slice(1).some((row, i) => rowTexts(row) !== rowTexts(out[i + 1] ?? []))
  const blockValues = block.map((row) => row.map((c) => c.text))
  const final = hasStats
    ? statsChanged ? [...blockValues, ...out.slice(STATS_ROWS)] : out
    : [...blockValues, ...out]

  return {
    insertStats: !hasStats,
    headerRow: parsed.headerRow + offset,
    newColumns,
    cells,
    stats: statsChanged ? block : null,
    columnCount: Math.max(next, ...block.map((r) => r.length)),
    values: final,
    changed: !hasStats || statsChanged || cells.length > 0,
  }
}
