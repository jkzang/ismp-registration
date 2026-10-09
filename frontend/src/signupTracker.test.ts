import { describe, expect, it } from 'vitest'
import { parseSheet } from './sheetParser'
import { dialable, fillMessage, mailtoHref, readContacts, signedUpText, smsHref, statusText } from './signupTracker'

const values = [
  ['Timestamp', 'First & Last Name', 'Nickname', 'Phone Number', 'Email', 'Contact Status'],
  ['10/1/2026 9:00:00', 'Amy Lin', '', '(858) 555-0100', 'amy@ucsd.edu', 'Awaiting Response'],
  ['10/2/2026 9:00:00', 'Ben Wu', 'Benny', '+1 858 555 0101', '', ''],
]

describe('readContacts', () => {
  it('keeps phone, email and the timestamp, and finds columns an older import saved as none', () => {
    const { contacts, columns } = readContacts(values, { name: 'First & Last Name', phone: '', email: '', status: '' })
    expect(columns).toMatchObject({ status: true, phone: true, email: true })
    expect(contacts.map((c) => [c.name, c.row, c.phone, c.email, c.signedUp, c.status])).toEqual([
      ['Amy Lin', 1, '(858) 555-0100', 'amy@ucsd.edu', '10/1/2026 9:00:00', 'awaiting_response'],
      ['Ben Wu', 2, '+1 858 555 0101', '', '10/2/2026 9:00:00', 'not_contacted'],
    ])
  })

  it('says when there is no status column', () => {
    const { columns } = readContacts(values.map((r) => r.slice(0, 5)), {})
    expect(columns.status).toBe(false)
  })
})

describe('statusText', () => {
  const parsed = parseSheet(values)
  it('uses the sheet’s own spelling when it has one', () => {
    expect(statusText(values, parsed, 'awaiting_response')).toBe('Awaiting Response')
  })
  it('falls back to the app’s label, as its dropdown spells it', () => {
    expect(statusText(values, parsed, 'confirmed')).toBe('Confirmed')
    expect(statusText(values, parsed, 'no_response')).toBe('No Response')
  })
})

describe('contact links', () => {
  it('fills in the message', () => {
    expect(fillMessage('Hi {first} ({name}), see you at {event}!', { name: 'Ben Wu', nickname: 'Benny' }, 'Kickoff')).toBe(
      'Hi Benny (Ben Wu), see you at Kickoff!',
    )
    expect(fillMessage('Hi {first}', { name: 'Amy Lin', nickname: '' }, '')).toBe('Hi Amy')
  })

  it('makes dialable numbers', () => {
    expect(dialable('(858) 555-0100')).toBe('8585550100')
    expect(dialable('+1 858 555 0101')).toBe('+18585550101')
    expect(dialable('n/a')).toBe('')
  })

  it('builds sms and mailto links', () => {
    expect(smsHref('858-555-0100', 'Hi & bye')).toBe('sms:8585550100?&body=Hi%20%26%20bye')
    expect(mailtoHref('amy@ucsd.edu', 'Kickoff', 'Hi Amy')).toBe('mailto:amy@ucsd.edu?subject=Kickoff&body=Hi%20Amy')
  })
})

describe('answers', () => {
  it('keeps the other form answers, but not the columns shown elsewhere', () => {
    const { contacts } = readContacts(
      [
        ['Timestamp', 'Name', 'Phone Number', 'WeChat ID', 'How did you hear about us?', 'Major', 'Dietary restrictions'],
        ['10/1/2026 9:00:00', 'Amy Lin', '858', 'amylin', 'A friend', 'Biology', ''],
      ],
      { name: 'Name' },
    )
    expect(contacts[0].answers).toEqual([{ label: 'Major', value: 'Biology' }])
  })
})

describe('signedUpText', () => {
  it('reads as MM/dd/YYYY hh:mm AM/PM', () => {
    expect(signedUpText('10/8/2026 15:04:00')).toBe('10/08/2026 03:04 PM')
    expect(signedUpText('1/2/2026 0:30:00')).toBe('01/02/2026 12:30 AM')
    expect(signedUpText('sometime')).toBeNull()
  })
})
