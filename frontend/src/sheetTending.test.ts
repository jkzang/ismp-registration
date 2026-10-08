import { describe, expect, it } from 'vitest'
import { planTending, STATS_ROWS, STATS_TITLE } from './sheetTending'
import { readContacts } from './signupTracker'

const NOW = new Date(2026, 9, 8, 12, 0).getTime()
const HEADER = ['Timestamp', 'Name', 'Phone', 'Gender', 'Enrollment Status', 'Would you like to join our group chats?', 'LINE ID']
const DATABASE = [
  ['Name', 'Phone'],
  ['Amy Lin', '858-555-0100'],
]

describe('planTending on a fresh form tab', () => {
  const values = [
    HEADER,
    ['10/1/2026 9:00:00', 'Amy Lin', '(858) 555-0100', 'Female', 'Undergrad', 'Yes', 'amy_line'],
    ['10/2/2026 9:00:00', 'Ben Wu', '', 'Male', 'Grad', 'No thanks', ''],
  ]
  const plan = planTending(values, {}, DATABASE, NOW)!

  it('adds the four columns after the last one, under the stats block', () => {
    expect(plan.insertStats).toBe(true)
    expect(plan.headerRow).toBe(STATS_ROWS)
    expect(plan.newColumns.map((c) => [c.column, c.header])).toEqual([
      [7, 'Contact Status'],
      [8, 'New or Returning'],
      [9, 'Group Chat Status'],
      [10, 'Contacted At'],
    ])
    expect(plan.values[STATS_ROWS].slice(7)).toEqual(['Contact Status', 'New or Returning', 'Group Chat Status', 'Contacted At'])
  })

  it('fills Not Contacted, New or Returning from the database, and the group chats', () => {
    const { contacts } = readContacts(plan.values, {})
    expect(contacts.map((c) => [c.name, c.status, c.returning, c.groupChat])).toEqual([
      ['Amy Lin', 'not_contacted', 'returning', 'not_invited'],
      ['Ben Wu', 'not_contacted', 'new', 'declined'],
    ])
    expect(plan.values[STATS_ROWS + 1][7]).toBe('Not Contacted')
    expect(plan.values[STATS_ROWS + 2][9]).toBe("Doesn't Want To Join")
    // Cells are where they'll be once the stats rows are in.
    expect(plan.cells).toContainEqual({ row: STATS_ROWS + 1, column: 8, text: 'Returning' })
  })

  it('puts the statistics on top', () => {
    expect(plan.values[0][0].startsWith(STATS_TITLE)).toBe(true)
    expect(plan.values[1]).toEqual(['Sign-ups', '2 signed up', '1 girl', '1 guy', '1 undergrad', '1 grad', '0 not a student'])
    expect(plan.values[2]).toEqual(['New or returning', '1 new', '1 returning'])
    expect(plan.values[3]).toEqual(['Contact status', '2 not contacted'])
    expect(plan.values[4]).toEqual(['Group chats', '1 to do', '0 pending', '0 complete', '1 N/A'])
  })

  it('leaves a tended tab alone', () => {
    const again = planTending(plan.values, {}, DATABASE, NOW)!
    expect(again).toMatchObject({ insertStats: false, changed: false, newColumns: [], cells: [], stats: null })
  })
})

describe('No Response after 48 hours', () => {
  const header = [...HEADER, 'Contact Status', 'New or Returning', 'Group Chat Status', 'Contacted At']
  const row = (name: string, status: string, contacted: string) =>
    ['10/1/2026 9:00:00', name, '', 'Female', 'Undergrad', '', '', status, 'New', 'Not Invited', contacted]
  const values = [
    header,
    row('Old', 'Awaiting Response', '2026-10-06 11:59'),
    row('Recent', 'Awaiting Response', '2026-10-07 09:00'),
    row('Unstamped', 'Awaiting Response', ''),
    row('Confirmed', 'Confirmed', '2026-10-01 09:00'),
  ]
  const plan = planTending(values, {}, null, NOW)!
  const { contacts } = readContacts(plan.values, {})

  it('moves people awaiting a response for 48 hours to No Response', () => {
    expect(contacts.map((c) => c.status)).toEqual(['no_response', 'awaiting_response', 'awaiting_response', 'confirmed'])
    expect(plan.values[STATS_ROWS + 1][7]).toBe('No Response')
  })

  it('starts the clock for someone awaiting with no time', () => {
    expect(contacts[2].contactedAt).toBe('2026-10-08 12:00')
  })

  it('doesn’t look people up without a Student Database tab', () => {
    expect(plan.values[2]).toEqual(['New or returning', 'Add a “Student Database” tab to tell'])
  })
})

describe('older sheets', () => {
  it('turns a ticked “Added to Group Chat” box into Added To Line or WeChat', () => {
    const values = [
      ['Timestamp', 'Name', 'LINE ID', 'WeChat ID', 'Added to Group Chat'],
      ['1', 'Amy', 'amy_line', '', 'TRUE'],
      ['2', 'Ben', '', 'ben_wx', 'TRUE'],
      ['3', 'Cal', '', '', 'FALSE'],
    ]
    const { contacts } = readContacts(planTending(values, {}, null, NOW)!.values, {})
    expect(contacts.map((c) => c.groupChat)).toEqual(['added_line', 'added_wechat', 'not_invited'])
  })

  it('keeps what was typed', () => {
    const values = [
      ['Timestamp', 'Name', 'Contact Status', 'Group Chat Status'],
      ['1', 'Amy', 'Confirmed', 'Line QR Shared'],
    ]
    const plan = planTending(values, {}, null, NOW)!
    expect(plan.newColumns.map((c) => c.header)).toEqual(['New or Returning', 'Contacted At'])
    expect(plan.cells.filter((c) => c.row > STATS_ROWS)).toEqual([])
  })
})
