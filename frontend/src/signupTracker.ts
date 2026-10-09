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
  /** Their answer to the group chat question: already in them, asking to be added, or not wanting to be. */
  chatAnswer: ChatAnswer
  /** Asked to be added to the group chats (or, without that question, gave an ID). */
  wantsChat: boolean
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

/**
 * The form asks "Yes!" (already in our group chats), "No - Please help me join!" (to be added) or
 * "No thank you, I don't want to be added" (leave them be).
 */
export type ChatAnswer = 'in' | 'add' | 'declined' | ''

export function chatAnswerOf(text: string): ChatAnswer {
  const t = words(text)
  const declines = /\b(no thank|no thanks|don t want|do not want|not interested|rather not)\b/.test(t)
  if (!declines && /\b(help|add me|please add|want to join|like to join)\b/.test(t)) return 'add'
  if (declines || /^(n|no|nope|nah)$/.test(t)) return 'declined'
  if (YES.test(t)) return 'in'
  return ''
}

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
    const chatAnswer = chatAnswerOf(cellOf(values, index, extra.joinChat))
    return {
      ...row,
      row: index,
      phone: cellOf(values, index, columns.phone),
      email: cellOf(values, index, columns.email),
      signedUp: cellOf(values, index, columns.timestamp),
      socials,
      chatAnswer,
      wantsChat: extra.joinChat !== undefined ? chatAnswer === 'add' : socials.length > 0,
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

/** The two texts sent before the event: the first confirmation, then a second one closer to it. */
export const MESSAGE_LABELS = ['Confirmation text', 'Second confirmation text'] as const

export const DEFAULT_MESSAGES: readonly string[] = [
  'Hi {first}! Thanks for signing up for {event}. Are you still able to make it?',
  'Hi {first}! Just checking in again about {event}. Are you still planning to come? Let us know either way so we can save your spot.',
]

/** The message with {first}, {name} and {event} filled in. */
export function fillMessage(template: string, contact: Pick<Contact, 'name' | 'nickname'>, event: string) {
  return template.replace(/\{(first|name|event)\}/g, (_, key: string) =>
    key === 'first' ? firstName(contact) : key === 'name' ? contact.name : event,
  )
}

/** The filled-in messages as a Text or Email menu's choices, each with its link. */
export const messageItems = (messages: string[], href: (message: string) => string) =>
  messages.map((message, i) => ({ label: MESSAGE_LABELS[i], href: href(message), preview: message }))

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


/** When they signed up, for the Sign-ups page's time filter. The value is a range in days. */
/** "10/08/2026 03:15 PM", for the Sign-ups list's own column. Null when the timestamp can't be read. */
export function signedUpText(text: string) {
  const date = new Date(text)
  if (!text || Number.isNaN(date.getTime())) return null
  const pad = (n: number) => String(n).padStart(2, '0')
  const hour = date.getHours() % 12 || 12
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(hour)}:${pad(date.getMinutes())} ${date.getHours() < 12 ? 'AM' : 'PM'}`
}

/** "WeChat ID" → "WeChat": the header, less the words that only say it's an ID. */
export const socialLabel = (header: string) =>
  header.replace(/\(.*?\)/g, '').replace(/\b(your|id|username|user name|handle|account)\b/gi, '').replace(/[?:]/g, '').replace(/\s+/g, ' ').trim() || header
