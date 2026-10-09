/**
 * Who a bulk text from the Mac app goes to (components/BulkText.tsx), and who it never does: anyone
 * not a student (Enrollment "Not a student", or a name on the mentor roster), anyone without a
 * usable phone number, the sender's own number, and a number already in the batch. People whose
 * enrollment isn't given, or who were already sent the same text from this device, start unticked.
 */
import type { Contact } from './signupTracker'

export type Flag = { kind: 'blocked' | 'warn'; text: string }

export type Recipient = {
  contact: Contact
  /** Digits, with a leading + kept; empty when there's no usable number. */
  phone: string
  flags: Flag[]
  /** Can't be ticked. */
  blocked: boolean
  /** Ticked until someone unticks them. */
  byDefault: boolean
}

/** Who was sent which message (by its index) from this device, and when (ISO), by contact key. */
export type SentLog = Record<string, Record<string, string>>

/** A number the Mac app will text: 10 to 15 digits and nothing but phone punctuation. Else ''. */
export function textablePhone(text: string) {
  if (!text || /[^\d\s()+.-]/.test(text)) return ''
  const digits = text.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return ''
  return text.trim().startsWith('+') ? `+${digits}` : digits
}

/** For comparing numbers written differently: the last 10 digits. */
export const phoneKey = (phone: string) => phone.replace(/\D/g, '').slice(-10)

export const samePhone = (a: string, b: string) => !!a && !!b && phoneKey(a) === phoneKey(b)

/** "(555) 123-4567" for a US number, else as given. */
export function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  const us = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 ? digits : ''
  return us ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : phone
}

const normalName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const sentDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })

export function recipientsFor(
  contacts: Contact[],
  { mentorNames, fromNumber, sent, message }: { mentorNames: string[]; fromNumber: string; sent: SentLog; message: number },
): Recipient[] {
  const mentors = new Set(mentorNames.map(normalName).filter(Boolean))
  const taken = new Map<string, string>()
  const sorted = [...contacts].sort((a, b) => a.name.localeCompare(b.name))
  return sorted.map((contact) => {
    const phone = textablePhone(contact.phone)
    const flags: Flag[] = []
    const block = (text: string) => flags.push({ kind: 'blocked', text })
    const warn = (text: string) => flags.push({ kind: 'warn', text })
    if (contact.level === 'other') block('Not a student')
    if (mentors.has(normalName(contact.name))) block('On the mentor roster')
    if (!contact.phone.trim()) block('No phone number')
    else if (!phone) block(`“${contact.phone}” isn’t a full phone number`)
    else if (samePhone(phone, fromNumber)) block('That’s the number you’re sending from')
    else if (taken.has(phoneKey(phone))) block(`Same number as ${taken.get(phoneKey(phone))}`)
    const blocked = flags.length > 0
    if (!blocked) taken.set(phoneKey(phone), contact.name)
    if (!contact.level) warn('Enrollment not given: check they’re a student')
    const before = sent[contact.key]?.[String(message)]
    if (before) warn(`Already sent this text ${sentDate(before)}`)
    return { contact, phone, flags, blocked, byDefault: !blocked && flags.length === 0 }
  })
}

/** Placeholders a message has that nothing fills in, like {frist}. */
export function unknownPlaceholders(template: string) {
  return [...new Set([...template.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]))].filter((p) => !/^\{(first|name|event)\}$/.test(p))
}
