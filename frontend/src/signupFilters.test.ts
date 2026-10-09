import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT, optionCounts, passes, sortRows, TO_ADD, type Filters } from './signupFilters'
import type { Contact } from './signupTracker'

const now = new Date('2026-10-09T12:00:00').getTime()
const contact = (fields: Partial<Contact>) =>
  ({
    key: fields.name, name: '', nickname: '', phone: '', email: '', signedUp: '', status: 'not_contacted',
    gender: '', level: '', returning: '', groupChat: null, wantsChat: false, ...fields,
  }) as Contact

const amy = contact({ name: 'Amy', gender: 'female', level: 'grad', status: 'confirmed', wantsChat: true, groupChat: 'not_invited', signedUp: '2026-10-09T08:00:00', phone: '858 555 0101' })
const bo = contact({ name: 'Bo', gender: 'male', level: 'undergrad', status: 'awaiting_response', signedUp: '2026-10-07T08:00:00', email: 'bo@ucsd.edu' })
const cy = contact({ name: 'Cy', gender: 'female', level: 'undergrad', status: 'not_coming', returning: 'returning', groupChat: 'added_wechat', signedUp: '2026-09-20T08:00:00' })
const dee = contact({ name: 'dee', status: 'confirmed', phone: '858 555 0102', email: 'dee@ucsd.edu' })
const all = [amy, bo, cy, dee]
const names = (filters: Filters) => all.filter((c) => passes(c, filters, now)).map((c) => c.name)

describe('column filters', () => {
  it('adds up the values ticked in one column', () => {
    expect(names({ level: ['grad', 'undergrad'] })).toEqual(['Amy', 'Bo', 'Cy'])
    expect(names({ level: [''] })).toEqual(['dee'])
  })

  it('narrows across columns', () => {
    expect(names({ gender: ['female'], level: ['undergrad'] })).toEqual(['Cy'])
    expect(names({ gender: ['female'], status: ['confirmed', 'not_coming'] })).toEqual(['Amy', 'Cy'])
  })

  it('buckets when they signed up', () => {
    expect(names({ signedUp: ['day'] })).toEqual(['Amy'])
    expect(names({ signedUp: ['3days', 'older'] })).toEqual(['Bo', 'Cy'])
    expect(names({ signedUp: [''] })).toEqual(['dee'])
  })

  it('finds who to add to the group chats, and who can be reached how', () => {
    expect(names({ groupChat: [TO_ADD] })).toEqual(['Amy'])
    expect(names({ groupChat: ['complete'] })).toEqual(['Cy'])
    expect(names({ reach: ['email'] })).toEqual(['Bo', 'dee'])
    expect(names({ reach: ['none'] })).toEqual(['Cy'])
  })

  it('counts each value among who the other columns let through', () => {
    const counts = optionCounts(all, { gender: ['female'], level: ['grad'] }, 'level', now)
    expect(Object.fromEntries(counts)).toEqual({ grad: 1, undergrad: 1 })
  })
})

describe('sortRows', () => {
  const rows = all.map((contact, index) => ({ contact, index }))
  const order = (column: Parameters<typeof sortRows>[1]['column'], dir: 'asc' | 'desc') =>
    sortRows(rows, { column, dir }).map((r) => r.contact.name)

  it('puts the newest sign-ups first by default, and no date last', () => {
    expect(sortRows(rows, DEFAULT_SORT).map((r) => r.contact.name)).toEqual(['Amy', 'Bo', 'Cy', 'dee'])
    expect(order('signedUp', 'asc')).toEqual(['Cy', 'Bo', 'Amy', 'dee'])
  })

  it('sorts by name either way, ignoring case', () => {
    expect(order('name', 'asc')).toEqual(['Amy', 'Bo', 'Cy', 'dee'])
    expect(order('name', 'desc')).toEqual(['dee', 'Cy', 'Bo', 'Amy'])
  })

  it('keeps blanks last either way, then the newest first', () => {
    expect(order('level', 'asc')).toEqual(['Cy', 'Bo', 'Amy', 'dee'])
    expect(order('level', 'desc')).toEqual(['Amy', 'Cy', 'Bo', 'dee'])
  })

  it('sorts statuses in the dropdown’s order', () => {
    expect(order('status', 'asc')).toEqual(['Bo', 'dee', 'Amy', 'Cy'])
  })
})
