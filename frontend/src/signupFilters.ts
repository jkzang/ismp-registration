/**
 * The Sign-ups list's column headers: each one sorts the list, and most filter it. Within a column, the
 * ticked values add up (Girl or Guy); across columns they narrow (Girl and Grad). Rows come in as
 * the sheet has them, with any status still being saved already applied.
 */
import { CHAT_STAGES, chatStageOf, GROUP_CHAT_STATUSES, needsChat } from './signupColumns'
import { STATUS_GROUPS, type Contact } from './signupTracker'
import { CONTACT_STATUSES } from './types'

export type ColumnId = 'signedUp' | 'name' | 'gender' | 'level' | 'returning' | 'groupChat' | 'status'

export type FilterOption = { value: string; label: string; group?: string }
export type SortDir = 'asc' | 'desc'
export type Sort = { column: ColumnId; dir: SortDir }
export type Filters = Partial<Record<ColumnId, string[]>>

/** A row and where it is in the sheet, so ties keep the sheet's order. */
export type Row = { contact: Contact; index: number }

const DAY_MS = 24 * 60 * 60 * 1000
const NOT_GIVEN = { value: '', label: 'Not given' }
/** Confirmed, asked to join the group chats and not in them yet. */
export const TO_ADD = 'to-add'

type Column = {
  label: string
  /** In the header, where it's tight. */
  short?: string
  options: FilterOption[]
  /** What a row counts as for the filter; some rows count as more than one (a phone and an email). */
  values: (contact: Contact, now: number) => string[]
  /** Null sorts last either way. */
  sortKey: (row: Row) => number | string | null
  sortLabels: [asc: string, desc: string]
  /** The way a first click sorts. */
  firstDir?: SortDir
}

const rank = (order: string[], value: string) => (value ? order.indexOf(value) : -1)
const orNull = (n: number) => (n < 0 ? null : n)

function ageBucket(signedUp: string, now: number) {
  const time = new Date(signedUp).getTime()
  if (!signedUp || Number.isNaN(time)) return ''
  const days = (now - time) / DAY_MS
  return days < 1 ? 'day' : days < 3 ? '3days' : days < 7 ? 'week' : 'older'
}

const GENDERS = ['female', 'male']
const LEVELS = ['undergrad', 'grad', 'other']
const RETURNING = ['new', 'returning']
const STATUSES = CONTACT_STATUSES.map((s) => s.value as string)
const CHATS = GROUP_CHAT_STATUSES.map((s) => s.value as string)

export const COLUMNS: Record<ColumnId, Column> = {
  signedUp: {
    label: 'Signed up',
    options: [
      { value: 'day', label: 'Past day' },
      { value: '3days', label: '1–3 days ago' },
      { value: 'week', label: '3–7 days ago' },
      { value: 'older', label: 'Over a week ago' },
      { value: '', label: 'No date' },
    ],
    values: (c, now) => [ageBucket(c.signedUp, now)],
    // A date that can't be read goes last; ties keep the sheet's order, which the form adds to at the bottom.
    sortKey: (r) => {
      const time = new Date(r.contact.signedUp).getTime()
      return r.contact.signedUp && !Number.isNaN(time) ? time : null
    },
    sortLabels: ['Oldest first', 'Newest first'],
    firstDir: 'desc',
  },
  name: {
    label: 'Name',
    options: [],
    values: () => [],
    sortKey: (r) => r.contact.name.trim().toLowerCase() || null,
    sortLabels: ['A to Z', 'Z to A'],
  },
  gender: {
    label: 'Gender',
    options: [{ value: 'female', label: 'Girl' }, { value: 'male', label: 'Guy' }, NOT_GIVEN],
    values: (c) => [c.gender],
    sortKey: (r) => orNull(rank(GENDERS, r.contact.gender)),
    sortLabels: ['Girls first', 'Guys first'],
  },
  level: {
    label: 'Enrollment',
    options: [
      { value: 'undergrad', label: 'Undergrad' },
      { value: 'grad', label: 'Grad' },
      { value: 'other', label: 'Not a student' },
      NOT_GIVEN,
    ],
    values: (c) => [c.level],
    sortKey: (r) => orNull(rank(LEVELS, r.contact.level)),
    sortLabels: ['Undergrad first', 'Not a student first'],
  },
  returning: {
    label: 'New or returning',
    short: 'Returning',
    options: [{ value: 'new', label: 'New' }, { value: 'returning', label: 'Returning' }, NOT_GIVEN],
    values: (c) => [c.returning],
    sortKey: (r) => orNull(rank(RETURNING, r.contact.returning)),
    sortLabels: ['New first', 'Returning first'],
  },
  groupChat: {
    label: 'Group chat',
    options: [
      { value: TO_ADD, label: 'To add: confirmed, asked to join' },
      ...CHAT_STAGES.map((s) => ({ value: s.value as string, label: s.label })),
      { value: '', label: 'Not set' },
    ],
    values: (c) => [
      c.groupChat ? chatStageOf(c.groupChat) : '',
      ...(c.status === 'confirmed' && c.wantsChat && needsChat(c.groupChat) ? [TO_ADD] : []),
    ],
    sortKey: (r) => orNull(rank(CHATS, r.contact.groupChat ?? '')),
    sortLabels: ['To Do first', 'N/A first'],
  },
  status: {
    label: 'Contact status',
    // Under the headings the status tabs had, so a whole group can be ticked at once.
    options: STATUS_GROUPS.filter((g) => g.statuses).flatMap((g) =>
      g.statuses!.map((s) => ({ value: s, label: CONTACT_STATUSES.find((c) => c.value === s)!.label, group: g.label })),
    ),
    values: (c) => [c.status],
    sortKey: (r) => rank(STATUSES, r.contact.status),
    sortLabels: ['Not contacted first', 'Not inviting first'],
  },
}

export const DEFAULT_SORT: Sort = { column: 'signedUp', dir: 'desc' }

/** Whether a row passes every column's filter but `skip`'s (for that column's own counts). */
export function passes(contact: Contact, filters: Filters, now: number, skip?: ColumnId) {
  return (Object.keys(filters) as ColumnId[]).every((id) => {
    const picked = filters[id]
    if (id === skip || !picked?.length) return true
    return COLUMNS[id].values(contact, now).some((v) => picked.includes(v))
  })
}

/** How many rows have each of a column's values, among those the other columns let through. */
export function optionCounts(contacts: Contact[], filters: Filters, column: ColumnId, now: number) {
  const counts = new Map<string, number>()
  for (const c of contacts) {
    if (!passes(c, filters, now, column)) continue
    for (const v of new Set(COLUMNS[column].values(c, now))) counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  return counts
}

export function sortRows(rows: Row[], sort: Sort) {
  const key = COLUMNS[sort.column].sortKey
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = key(a)
    const y = key(b)
    if (x !== y) {
      if (x === null) return 1
      if (y === null) return -1
      const order = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)
      if (order) return order * sign
    }
    // Then newest first, as the sheet has them.
    return b.index - a.index
  })
}

export const isFiltered = (filters: Filters) => Object.values(filters).some((v) => v && v.length > 0)
