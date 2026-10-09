import { describe, expect, it } from 'vitest'
import { formatPhone, recipientsFor, textablePhone, unknownPlaceholders } from './bulkText'
import type { Contact } from './signupTracker'

const contact = (fields: Partial<Contact>) =>
  ({ key: fields.name, name: '', nickname: '', phone: '', email: '', status: 'not_contacted', gender: '', level: 'undergrad', ...fields }) as Contact

const options = { mentorNames: ['Pat Lee'], fromNumber: '(858) 555-0000', sent: {}, message: 0 }
const byName = (contacts: Contact[], opts = options) => Object.fromEntries(recipientsFor(contacts, opts).map((r) => [r.contact.name, r]))

describe('bulk text recipients', () => {
  it('ticks students with a phone number', () => {
    const r = byName([contact({ name: 'Amy', phone: '858-555-0101' })]).Amy
    expect(r).toMatchObject({ phone: '8585550101', blocked: false, byDefault: true, flags: [] })
  })

  it('never texts someone who is not a student or is a mentor', () => {
    const r = byName([
      contact({ name: 'Bo', level: 'other', phone: '858 555 0102' }),
      contact({ name: 'pat  lee', phone: '858 555 0103' }),
    ])
    expect(r.Bo).toMatchObject({ blocked: true, byDefault: false })
    expect(r.Bo.flags[0].text).toBe('Not a student')
    expect(r['pat  lee'].flags[0].text).toBe('On the mentor roster')
  })

  it('leaves out missing, short and email numbers, and the sender’s own', () => {
    const r = byName([
      contact({ name: 'A', phone: '' }),
      contact({ name: 'B', phone: '555-0101' }),
      contact({ name: 'C', phone: 'c@ucsd.edu' }),
      contact({ name: 'D', phone: '+1 858 555 0000' }),
    ])
    for (const name of ['A', 'B', 'C', 'D']) expect(r[name].blocked).toBe(true)
    expect(r.D.flags[0].text).toBe('That’s the number you’re sending from')
  })

  it('texts a shared number once', () => {
    const r = byName([contact({ name: 'Amy', phone: '8585550101' }), contact({ name: 'Ann', phone: '+1 (858) 555-0101' })])
    expect(r.Amy.blocked).toBe(false)
    expect(r.Ann).toMatchObject({ blocked: true, flags: [{ kind: 'blocked', text: 'Same number as Amy' }] })
  })

  it('starts unsure ones unticked', () => {
    const sent = { Cy: { '0': '2026-10-08T12:00:00Z' } }
    const r = byName([contact({ name: 'Bo', level: '', phone: '8585550102' }), contact({ name: 'Cy', phone: '8585550103' })], { ...options, sent })
    expect(r.Bo).toMatchObject({ blocked: false, byDefault: false })
    expect(r.Cy).toMatchObject({ blocked: false, byDefault: false })
    // A different message is fine.
    expect(byName([contact({ name: 'Cy', phone: '8585550103' })], { ...options, sent, message: 1 }).Cy.byDefault).toBe(true)
  })
})

describe('phone numbers', () => {
  it('only takes whole numbers', () => {
    expect(textablePhone('+44 20 7946 0958')).toBe('+442079460958')
    expect(textablePhone('858 555 0101 (cell)')).toBe('')
    expect(formatPhone('18585550101')).toBe('(858) 555-0101')
    expect(formatPhone('+442079460958')).toBe('+442079460958')
  })
})

it('finds placeholders nothing fills in', () => {
  expect(unknownPlaceholders('Hi {first}, {frist} and {event} {first}')).toEqual(['{frist}'])
})
