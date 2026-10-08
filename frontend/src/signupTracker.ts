/**
 * The Sign-ups page's view of the sign-up tab: everyone with their contact status, phone and email,
 * read in the browser. Phone and email stay in this tab's memory and are never sent to the server.
 */
import { parseSheet, statusOf, type ContactStatus, type FieldMap, type ParseResult, type SignupRow } from './sheetParser'
import { CONTACT_STATUSES } from './types'

export type Contact = SignupRow & {
  /** 0-based row in the tab. */
  row: number
  phone: string
  email: string
  /** The timestamp cell as the sheet shows it. */
  signedUp: string
}

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
  const contacts: Contact[] = parsed.rows.map((row, i) => {
    const index = parsed.rowIndexes[i]
    return {
      ...row,
      row: index,
      phone: cellOf(values, index, columns.phone),
      email: cellOf(values, index, columns.email),
      signedUp: cellOf(values, index, columns.timestamp),
    }
  })
  return {
    contacts,
    columns: {
      status: columns.status !== undefined,
      phone: columns.phone !== undefined,
      email: columns.email !== undefined,
    },
  }
}

/** How the sheet already spells `status` (its dropdown may say "Awaiting Response"), else the app's label. */
export function statusText(values: string[][], parsed: ParseResult, status: ContactStatus) {
  const column = parsed.columns.status
  if (column !== undefined) {
    for (const row of parsed.rowIndexes) {
      const text = cellOf(values, row, column)
      if (text && statusOf(text) === status) return text
    }
  }
  return CONTACT_STATUSES.find((s) => s.value === status)!.label
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
