import { describe, expect, it } from 'vitest'
import { planTending, STATS_ROWS, STATS_TITLE, statsRowsIn } from './sheetTending'
import { chatAnswerOf, readContacts } from './signupTracker'

const NOW = new Date(2026, 9, 8, 12, 0).getTime()
const HEADER = ['Timestamp', 'Name', 'Phone', 'Gender', 'Enrollment Status', 'Would you like to join our group chats?', 'LINE ID']
const DATABASE = [
  ['Name', 'Phone'],
  ['Amy Lin', '858-555-0100'],
]

describe('the group chat question', () => {
  it('reads the form’s three answers', () => {
    expect(chatAnswerOf('Yes!')).toBe('in')
    expect(chatAnswerOf('No - Please help me join!')).toBe('add')
    expect(chatAnswerOf('No thank you, I don’t want to be added')).toBe('declined')
    expect(chatAnswerOf("No thank you, I don't want to be added")).toBe('declined')
    expect(chatAnswerOf('')).toBe('')
  })
})

describe('planTending on a fresh form tab', () => {
  const values = [
    HEADER,
    ['10/1/2026 9:00:00', 'Amy Lin', '(858) 555-0100', 'Female', 'Undergrad', 'Yes!', 'amy_line'],
    ['10/2/2026 9:00:00', 'Ben Wu', '', 'Male', 'Grad', 'No thank you, I don’t want to be added', ''],
    ['10/8/2026 9:00:00', 'Cat Ho', '', 'Female', 'Grad', 'No - Please help me join!', ''],
  ]
  const plan = planTending(values, {}, DATABASE, NOW)!

  it('puts Contact Status, New or Returning and Group Chat Status in A to C, and Contacted At last', () => {
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 0, count: STATS_ROWS })
    expect(plan.columnOps).toEqual([{ kind: 'insert', at: 0 }, { kind: 'insert', at: 1 }, { kind: 'insert', at: 2 }])
    expect(plan.headerRow).toBe(STATS_ROWS)
    expect(plan.values[STATS_ROWS]).toEqual(['Contact Status', 'New or Returning', 'Group Chat Status', ...HEADER, 'Contacted At'])
    expect(plan.newColumns.map((c) => c.column)).toEqual([0, 1, 2, 10])
    expect(plan.dropdowns.map((c) => c.column)).toEqual([0, 1, 2])
  })

  it('fills the columns, the group chats from the form’s answers', () => {
    const { contacts } = readContacts(plan.values, {})
    expect(contacts.map((c) => [c.name, c.status, c.returning, c.groupChat, c.wantsChat])).toEqual([
      ['Amy Lin', 'not_contacted', 'returning', 'already_in', false],
      ['Ben Wu', 'not_contacted', 'new', 'declined', false],
      ['Cat Ho', 'not_contacted', 'new', 'not_invited', true],
    ])
    expect(plan.values[STATS_ROWS + 1].slice(0, 3)).toEqual(['Not Contacted', 'Returning', 'Already In Group'])
    expect(plan.cells).toContainEqual({ row: STATS_ROWS + 2, column: 2, text: "Doesn't Want To Join" })
  })

  it('puts the statistics on top as side-by-side tables, with an empty row before the header', () => {
    expect(plan.values[0][0].startsWith(STATS_TITLE)).toBe(true)
    expect(plan.values[1]).toEqual([])
    // Each table takes two columns: its name, then a name and a number on each row.
    expect(plan.values[2]).toEqual(['Overview', '', 'Contact status', '', 'Group chats', '', 'Gender & level', '', 'New vs returning', '', 'Signed up', ''])
    const table = (t: number) => plan.values.slice(3, 12).map((r) => r.slice(t * 2, t * 2 + 2)).filter((r) => r.some(Boolean))
    expect(table(0)).toEqual([
      ['Signed up', '3'],
      ['Confirmed', '0  ·  0%'],
      ['Awaiting response', '0  ·  0%'],
      ['Not contacted yet', '3  ·  100%'],
      ['No response', '0  ·  0%'],
      ['Not coming', '0  ·  0%'],
      ['New', '2  ·  67%'],
      ['Returning', '1  ·  33%'],
      ['To add to chats', '0'],
    ])
    expect(table(1)[0]).toEqual(['Not Contacted', '3  ·  100%'])
    expect(table(2).map((r) => r[0])).toEqual([
      'Not Invited', 'WeChat Friend Request Sent', 'Line QR Shared', 'WeChat Group Invite Sent',
      'Added To WeChat', 'Added To Line', 'Already In Group', "Doesn't Want To Join",
    ])
    expect(table(2)[6]).toEqual(['Already In Group', '1  ·  33%'])
    expect(table(3)).toEqual([
      ['Girls', '2  ·  67%'],
      ['Guys', '1  ·  33%'],
      ['Undergrad', '1  ·  33%'],
      ['Grad', '2  ·  67%'],
      ['Not a student', '0  ·  0%'],
    ])
    expect(table(4)[0]).toEqual(['New', '2  ·  67%'])
    expect(table(5)[0]).toEqual(['Past 24 hours', '1  ·  33%'])
    expect(plan.values[STATS_ROWS - 1]).toEqual([])
    expect(statsRowsIn(plan.values, plan.headerRow)).toBe(STATS_ROWS)
  })

  it('leaves a tended tab alone', () => {
    const again = planTending(plan.values, {}, DATABASE, NOW)!
    expect(again).toMatchObject({ rowOp: null, columnOps: [], changed: false, newColumns: [], dropdowns: [], cells: [], stats: null })
  })
})

describe('a tab tended by the earlier version', () => {
  // Six rows of stats, and the columns at the end.
  const values = [
    [`${STATS_TITLE}  ·  kept up to date`],
    ['Sign-ups', '1 signed up'],
    ['New or returning', '1 new'],
    ['Contact status', '1 confirmed'],
    ['Group chats', '1 to do'],
    [],
    ['Timestamp', 'Name', 'Contact Status', 'New or Returning', 'Group Chat Status', 'Contacted At'],
    ['10/1/2026 9:00:00', 'Amy', 'Confirmed', 'New', 'Not Invited', ''],
  ]
  const plan = planTending(values, {}, null, NOW)!

  it('grows the stats block and moves the columns to A to C', () => {
    expect(statsRowsIn(values, 6)).toBe(6)
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 6, count: STATS_ROWS - 6 })
    expect(plan.columnOps).toEqual([
      { kind: 'move', from: 2, to: 0 },
      { kind: 'move', from: 3, to: 1 },
      { kind: 'move', from: 4, to: 2 },
    ])
    expect(plan.values[STATS_ROWS]).toEqual(['Contact Status', 'New or Returning', 'Group Chat Status', 'Timestamp', 'Name', 'Contacted At'])
    expect(plan.values[STATS_ROWS + 1]).toEqual(['Confirmed', 'New', 'Not Invited', '10/1/2026 9:00:00', 'Amy'])
    expect(plan.newColumns).toEqual([])
    expect(plan.cells).toEqual([])
  })
})

describe('a tab tended with the ten-row stats', () => {
  it('grows the block to the tables', () => {
    const values = [
      [`${STATS_TITLE}  ·  kept up to date`],
      ['3'], ['signed up'], ['Gender & level'], ['New vs returning'], ['Contact status'], ['Group chats'], ['Group chat status'],
      ['When they signed up', 'Past 24 hours  1'],
      [],
      ['Contact Status', 'New or Returning', 'Group Chat Status', 'Timestamp', 'Name', 'Contacted At'],
      ['Confirmed', 'New', 'Not Invited', '10/1/2026 9:00:00', 'Amy'],
    ]
    expect(statsRowsIn(values, 10)).toBe(10)
    const plan = planTending(values, {}, null, NOW)!
    expect(plan.rowOp).toEqual({ kind: 'insert', at: 10, count: STATS_ROWS - 10 })
    expect(plan.columnOps).toEqual([])
    // The columns get the chip look the new version gives them.
    expect(plan.dropdowns.map((d) => d.column)).toEqual([0, 1, 2])
    expect(plan.values[STATS_ROWS]).toEqual(values[10])
  })
})

describe('No Response after 48 hours', () => {
  const header = ['Contact Status', 'New or Returning', 'Group Chat Status', ...HEADER, 'Contacted At']
  const row = (name: string, status: string, contacted: string) =>
    [status, 'New', 'Not Invited', '10/1/2026 9:00:00', name, '', 'Female', 'Undergrad', '', '', contacted]
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
    expect(plan.columnOps).toEqual([])
    expect(contacts.map((c) => c.status)).toEqual(['no_response', 'awaiting_response', 'awaiting_response', 'confirmed'])
    expect(plan.values[STATS_ROWS + 1][0]).toBe('No Response')
  })

  it('starts the clock for someone awaiting with no time', () => {
    expect(contacts[2].contactedAt).toBe('2026-10-08 12:00')
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
    expect(plan.values[STATS_ROWS + 1]).toEqual(['Confirmed', '', 'Line QR Shared', '1', 'Amy'])
    expect(plan.cells.filter((c) => c.row > STATS_ROWS)).toEqual([])
  })
})
