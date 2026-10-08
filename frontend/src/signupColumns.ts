/**
 * The columns the app adds to every imported sign-up tab (Contact Status, New or Returning, Group
 * Chat Status and Contacted At), their values and colors, and the statistics block above the header.
 * Like phone numbers, none of this is sent to the server: it lives in the sheet. sheetTending.ts
 * works out what to write; google.ts writes it.
 */
import type { ContactStatus } from './types'

export const COLUMN_HEADERS = {
  status: 'Contact Status',
  returning: 'New or Returning',
  groupChat: 'Group Chat Status',
  contactedAt: 'Contacted At',
} as const
export type AddedColumn = keyof typeof COLUMN_HEADERS

const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// "Student Status" was this column's first name; a sheet may still have it.
const RETURNING = /^(new or returning|new returning|returning|returning student|new or returning student|student status)$/
const GROUP_CHAT = /\bgroup ?chats? status\b/
const CONTACTED_AT = /^(contacted|contacted at|contacted on|date contacted|first contacted|last contacted)$/

/** The added columns (other than Contact Status, which the parser finds) by header. */
export function addedColumns(headers: string[]) {
  const find = (pattern: RegExp) => {
    const index = headers.findIndex((h) => pattern.test(words(h)))
    return index === -1 ? undefined : index
  }
  return { returning: find(RETURNING), groupChat: find(GROUP_CHAT), contactedAt: find(CONTACTED_AT) }
}

export type Returning = 'new' | 'returning'
export const RETURNING_LABELS: Record<Returning, string> = { new: 'New', returning: 'Returning' }

export function returningOf(text: string): Returning | '' {
  const t = words(text)
  if (/^(new|first time|no)$/.test(t)) return 'new'
  if (/^(returning|return|yes)$/.test(t)) return 'returning'
  return ''
}

/** Where someone is with the group chats: still to do, waiting on them, done, or not wanted. */
export type ChatStage = 'todo' | 'pending' | 'complete' | 'na'
export type GroupChatStatus =
  | 'not_invited'
  | 'wechat_request_sent'
  | 'line_qr_shared'
  | 'wechat_invite_sent'
  | 'added_wechat'
  | 'added_line'
  | 'already_in'
  | 'declined'

export const CHAT_STAGES: { value: ChatStage; label: string }[] = [
  { value: 'todo', label: 'To Do' },
  { value: 'pending', label: 'Pending' },
  { value: 'complete', label: 'Complete' },
  { value: 'na', label: 'N/A' },
]

export const GROUP_CHAT_STATUSES: { value: GroupChatStatus; label: string; stage: ChatStage }[] = [
  { value: 'not_invited', label: 'Not Invited', stage: 'todo' },
  { value: 'wechat_request_sent', label: 'WeChat Friend Request Sent', stage: 'pending' },
  { value: 'line_qr_shared', label: 'Line QR Shared', stage: 'pending' },
  { value: 'wechat_invite_sent', label: 'WeChat Group Invite Sent', stage: 'pending' },
  { value: 'added_wechat', label: 'Added To WeChat', stage: 'complete' },
  { value: 'added_line', label: 'Added To Line', stage: 'complete' },
  // Answered "Yes!" on the form: already in our group chats.
  { value: 'already_in', label: 'Already In Group', stage: 'complete' },
  { value: 'declined', label: "Doesn't Want To Join", stage: 'na' },
]

const GROUP_CHAT_BY_TEXT = new Map(GROUP_CHAT_STATUSES.map((s) => [words(s.label), s.value]))

/** Null when blank or not one of the statuses. */
export const groupChatOf = (text: string): GroupChatStatus | null => GROUP_CHAT_BY_TEXT.get(words(text)) ?? null
export const groupChatLabel = (status: GroupChatStatus) => GROUP_CHAT_STATUSES.find((s) => s.value === status)!.label
export const chatStageOf = (status: GroupChatStatus) => GROUP_CHAT_STATUSES.find((s) => s.value === status)!.stage
/** Not in the chats yet, and hasn't said they don't want to be. */
export const needsChat = (status: GroupChatStatus | null) => status === null || ['todo', 'pending'].includes(chatStageOf(status))

/** "Not contacted" → "Not Contacted", how the app spells a status in a column it added. */
export const titleCase = (label: string) => label.replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** Awaiting response this long after being contacted turns into No response. */
export const NO_RESPONSE_AFTER_MS = 48 * 60 * 60 * 1000

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-10-08 15:04", local time: sorts as text, and Sheets reads it as a date. */
export const formatStamp = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`

/** The time in a Contacted At cell, written by the app or typed. Null when it can't be read. */
export function parseStamp(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  // Safari can't read "2026-10-08 15:04" itself.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  const time = m
    ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).getTime()
    : new Date(t).getTime()
  return Number.isNaN(time) ? null : time
}

export type Color = { red: number; green: number; blue: number }
const rgb = (hex: string): Color => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
})
/** A cell's background and text. */
export type Swatch = { background: Color; text: Color }
const swatch = (background: string, text: string): Swatch => ({ background: rgb(background), text: rgb(text) })

// The same colors as the app's chips.
const RED = swatch('#fee2e2', '#991b1b')
const AMBER = swatch('#fef3c7', '#92400e')
const GREEN = swatch('#dcfce7', '#166534')
const GREY = swatch('#e5e7eb', '#4b5563')
const SLATE = swatch('#f1f5f9', '#334155')
const BLUE = swatch('#dbeafe', '#1e40af')
const ORANGE = swatch('#ffedd5', '#9a3412')

export const STAGE_COLORS: Record<ChatStage, Swatch> = { todo: RED, pending: AMBER, complete: GREEN, na: GREY }

export const STATUS_COLORS: Record<ContactStatus, Swatch> = {
  not_contacted: SLATE,
  waiting_to_contact: BLUE,
  awaiting_response: AMBER,
  confirmed: GREEN,
  no_response: GREY,
  not_coming: RED,
  no_room: RED,
  no_space: RED,
  not_inviting: RED,
}

export const RETURNING_COLORS: Record<Returning, Swatch> = { new: BLUE, returning: ORANGE }
