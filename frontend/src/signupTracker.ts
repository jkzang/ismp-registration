/**
 * The Sign-ups page's view of the sign-up tab: everyone with their contact status, phone, email,
 * social media IDs, how they heard about the event and whether they're in the group chats, read in
 * the browser. None of those leave this tab's memory or reach the server.
 */
import { parseSheet, statusOf, type ContactStatus, type FieldMap, type ParseResult, type SignupRow } from './sheetParser'
import { addedColumns, groupChatOf, returningOf, titleCase, type GroupChatStatus, type Returning } from './signupColumns'
import { CONTACT_STATUSES } from './types'

export type Contact = SignupRow & {
  /** 0-based row in the tab. */
  row: number
  phone: string
  email: string
  /** The timestamp cell as the sheet shows it. */
  signedUp: string
  /** Social media IDs they gave, labeled by their column's header. */
  socials: { label: string; id: string }[]
  /** Said they'd like to join the group chats (or, without that question, gave an ID). */
  wantsChat: boolean
  /** Answered no to joining the group chats. */
  declinedChat: boolean
  /** Ticked in an older sheet's "Added to Group Chat" checkbox column. */
  chatTicked: boolean
  /** The Group Chat Status column; null when blank or unrecognized. */
  groupChat: GroupChatStatus | null
  /** The New or Returning column. */
  returning: Returning | ''
  /** The Contacted At cell as the sheet shows it. */
  contactedAt: string
  /** How they heard about the event, as answered. */
  referral: string
  /** Their other answers on the form, labeled by header, for the person view. */
  answers: { label: string; value: string }[]
}

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Found by header, like phone and email; none of these is ever imported.
const CHAT_ADDED = /\badded\b.*\b(group|chats?)\b|\b(group|chats?)\b.*\badded\b/
const JOIN_CHAT = /\b(join|want|like|interested)\b.*\b(group|chats?|community)\b|\bgroup ?chats?\b/
const REFERRAL = /\b(hear|heard|find out|found out|learn about|learned about|referr\w*|referral)\b/
const SOCIAL = /\b(wechat|we chat|instagram|insta|ig|line|whatsapp|kakao\w*|telegram|discord|facebook|messenger|snapchat|social)\b/

/**
 * Columns of the extra questions, by header, and the columns the app adds to the tab (see
 * signupColumns.ts). Used columns (name, phone and so on) are skipped.
 */
export function extraColumns(headers: string[], used: Set<number>) {
  const find = (pattern: RegExp, taken: Set<number>) => {
    const index = headers.findIndex((h, i) => !taken.has(i) && pattern.test(words(h)))
    return index === -1 ? undefined : index
  }
  const added = addedColumns(headers)
  // "Group Chat Status" would pass for the join question otherwise.
  const taken = new Set([...used, ...Object.values(added).filter((i) => i !== undefined)])
  const chatAdded = find(CHAT_ADDED, taken)
  if (chatAdded !== undefined) taken.add(chatAdded)
  const referral = find(REFERRAL, taken)
  if (referral !== undefined) taken.add(referral)
  // An ID column's header can mention the group too ("WeChat ID (to add you to our group)"), so the
  // join question is the one that isn't asking for an ID.
  const joinChat = headers.findIndex((h, i) => !taken.has(i) && JOIN_CHAT.test(words(h)) && !/\b(id|username|handle)\b/.test(words(h)))
  if (joinChat !== -1) taken.add(joinChat)
  const social = headers.flatMap((h, i) => (!taken.has(i) && SOCIAL.test(words(h)) ? [i] : []))
  return { ...added, chatAdded, referral, joinChat: joinChat === -1 ? undefined : joinChat, social }
}

const NO_ANSWER = /^(n ?a|none|no|nil|null|nope|-+|\.)?$/
const YES = /^(y|yes|yeah|yep|sure|ok|okay|definitely|of course|absolutely)\b/
const NO = /^(n|no|nope|nah|not|no thanks?)\b/
/** A checkbox (or a typed yes) in an older sheet's "Added to Group Chat" column. */
export const isTicked = (text: string) => /^(true|yes|y|added|done|x|✓|✔)$/i.test(text.trim())

/** The saved columns, but looking again for the ones only located (an import may predate them). */
export function locateFieldMap(fieldMap: FieldMap): FieldMap {
  const located = { ...fieldMap }
  for (const field of ['status', 'phone', 'email', 'attendance'] as const) {
    if (!located[field]) delete located[field]
  }
  return located
}

const cellOf = (values: string[][], row: number, column: number | undefined) =>
  column === undefined ? '' : (values[row]?.[column] ?? '').trim()

export function readContacts(values: string[][], fieldMap: FieldMap) {
  const parsed = parseSheet(values, { fieldMap: locateFieldMap(fieldMap) })
  const { columns } = parsed
  const extra = extraColumns(parsed.headers, new Set(Object.values(columns)))
  // Everything not shown some other way.
  const shownColumns = new Set([
    ...Object.values(columns),
    extra.chatAdded,
    extra.referral,
    extra.joinChat,
    extra.returning,
    extra.groupChat,
    extra.contactedAt,
    ...extra.social,
  ])
  const answerColumns = parsed.headers.flatMap((h, i) => (h.trim() && !shownColumns.has(i) ? [i] : []))
  const contacts: Contact[] = parsed.rows.map((row, i) => {
    const index = parsed.rowIndexes[i]
    const socials = extra.social.flatMap((column) => {
      const id = cellOf(values, index, column)
      return NO_ANSWER.test(words(id)) ? [] : [{ label: parsed.headers[column], id }]
    })
    const join = words(cellOf(values, index, extra.joinChat))
    return {
      ...row,
      row: index,
      phone: cellOf(values, index, columns.phone),
      email: cellOf(values, index, columns.email),
      signedUp: cellOf(values, index, columns.timestamp),
      socials,
      wantsChat: extra.joinChat !== undefined ? YES.test(join) : socials.length > 0,
      declinedChat: extra.joinChat !== undefined && NO.test(join),
      chatTicked: isTicked(cellOf(values, index, extra.chatAdded)),
      groupChat: groupChatOf(cellOf(values, index, extra.groupChat)),
      returning: returningOf(cellOf(values, index, extra.returning)),
      contactedAt: cellOf(values, index, extra.contactedAt),
      referral: cellOf(values, index, extra.referral),
      answers: answerColumns.flatMap((column) => {
        const value = cellOf(values, index, column)
        return value ? [{ label: parsed.headers[column].trim(), value }] : []
      }),
    }
  })
  return {
    contacts,
    columns: {
      status: columns.status !== undefined,
      phone: columns.phone !== undefined,
      email: columns.email !== undefined,
      groupChat: extra.groupChat !== undefined,
      returning: extra.returning !== undefined,
      // Some way to tell who wants to join.
      chat: extra.joinChat !== undefined || extra.social.length > 0,
      referral: extra.referral !== undefined,
    },
  }
}

/** How the sheet already spells `status` (its dropdown may say "Awaiting Response"), else as the app's dropdown does. */
export function statusText(values: string[][], parsed: ParseResult, status: ContactStatus) {
  const column = parsed.columns.status
  if (column !== undefined) {
    for (const row of parsed.rowIndexes) {
      const text = cellOf(values, row, column)
      if (text && statusOf(text) === status) return text
    }
  }
  return titleCase(CONTACT_STATUSES.find((s) => s.value === status)!.label)
}

/** Who's left to reach, who's been reached, who's coming, and who isn't. */
export const STATUS_GROUPS: { value: string; label: string; statuses: ContactStatus[] | null }[] = [
  { value: 'all', label: 'All', statuses: null },
  { value: 'to-contact', label: 'To contact', statuses: ['not_contacted', 'waiting_to_contact'] },
  { value: 'awaiting', label: 'Awaiting', statuses: ['awaiting_response', 'no_response'] },
  { value: 'confirmed', label: 'Confirmed', statuses: ['confirmed'] },
  { value: 'not-coming', label: 'Not coming', statuses: ['not_coming', 'no_room', 'no_space', 'not_inviting'] },
]

/** Reaching out to someone in these moves them to Awaiting response. */
export const BEFORE_CONTACT: ContactStatus[] = ['not_contacted', 'waiting_to_contact']

/** Their nickname, else their first name. */
export const firstName = (contact: Pick<Contact, 'name' | 'nickname'>) => contact.nickname || contact.name.split(' ')[0]

export const DEFAULT_MESSAGE = 'Hi {first}! Thanks for signing up for {event}. Are you still able to make it?'

/** The message with {first}, {name} and {event} filled in. */
export function fillMessage(template: string, contact: Pick<Contact, 'name' | 'nickname'>, event: string) {
  return template.replace(/\{(first|name|event)\}/g, (_, key: string) =>
    key === 'first' ? firstName(contact) : key === 'name' ? contact.name : event,
  )
}

/** Digits, with a leading + kept, for tel: and sms: links. Empty when it's too short to be a number. */
export function dialable(phone: string) {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 7) return ''
  return phone.trim().startsWith('+') ? `+${digits}` : digits
}

// "?&body=" works on both iOS and Android.
export const smsHref = (phone: string, body: string) => `sms:${dialable(phone)}?&body=${encodeURIComponent(body)}`
export const telHref = (phone: string) => `tel:${dialable(phone)}`
export const mailtoHref = (email: string, subject: string, body: string) =>
  `mailto:${email.replace(/[\s?&#]/g, '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

/** "Oct 3, 2:15 PM" when the sheet's timestamp reads as a date, otherwise its own text. */
export function shortTimestamp(text: string) {
  if (!text) return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const DAY_MS = 24 * 60 * 60 * 1000

/** When they signed up, for the Sign-ups page's time filter. The value is a range in days. */
export const SIGNED_UP_RANGES: { value: string; label: string; days: [number, number] | null }[] = [
  { value: 'any', label: 'Any time', days: null },
  { value: 'day', label: 'Past day', days: [0, 1] },
  { value: '3days', label: 'Past 3 days', days: [0, 3] },
  { value: 'week', label: 'Past week', days: [0, 7] },
  { value: 'older', label: 'Over a week ago', days: [7, Infinity] },
]

/** Whether they signed up in the range. A timestamp that can't be read only matches "Any time". */
export function signedUpWithin(signedUp: string, range: string, now = Date.now()) {
  const days = SIGNED_UP_RANGES.find((r) => r.value === range)?.days
  if (!days) return true
  const time = new Date(signedUp).getTime()
  if (Number.isNaN(time)) return false
  const age = (now - time) / DAY_MS
  return age >= days[0] && age < days[1]
}

/** The timestamp as a date and a time, for the Sign-ups list's own column. Null when it can't be read. */
export function signedUpParts(text: string) {
  const date = new Date(text)
  if (!text || Number.isNaN(date.getTime())) return null
  return {
    date: date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    time: date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  }
}

/** "WeChat ID" → "WeChat": the header, less the words that only say it's an ID. */
export const socialLabel = (header: string) =>
  header.replace(/\(.*?\)/g, '').replace(/\b(your|id|username|user name|handle|account)\b/gi, '').replace(/[?:]/g, '').replace(/\s+/g, ' ').trim() || header
