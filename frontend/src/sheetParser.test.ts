import { describe, expect, it } from 'vitest'
import { findHeaderRow, genderOf, levelOf, parseSheet, SheetFormatError, statusOf } from './sheetParser'

const HEADER = [
  'Mentor', 'Contact Status', 'Student Status', 'Attendance', 'Timestamp', 'First & Last Name', 'Nickname (if any)',
  'Cell Phone Number', 'Email Address (Please provide your UCSD email)', 'Gender', 'Enrollment Status',
  'Are you already part of our WeChat/Line group chat?',
  'WeChat or Line ID (if you would like to be added to our group chat!)', 'How did you hear about this event? ',
  'Are you interested in any of these offerings?', 'Questions/Comments:', '', '', '',
]

function person(name: string, gender: string, enrollment: string, contact = 'Confirmed', nickname = '', timestamp = '9/1/2026 10:00:00') {
  return ['Jack', contact, 'New', '', timestamp, name, nickname, '858-555-0100', 'x@ucsd.edu', gender, enrollment, 'No', 'wx_id', 'Friend', '', '']
}

// Sign-up sheets carry ~16 rows of notes and counts above the real header.
const INTRO = Array.from({ length: 16 }, (_, i) => (i === 3 ? ['Total signed up', '42'] : i === 5 ? ['Name of event', 'Fall Kickoff'] : []))

const SHEET = [
  ...INTRO,
  HEADER,
  person('Amy Lin', 'Female', 'Masters', 'Confirmed', 'Ames'),
  person('Ben Wu', 'Male', 'Undergrad', 'Awaiting response'),
  person('Cara Diaz', 'female', 'PhD', 'No Response', 'N/A'),
  person('Dev Rao', 'male', 'Exchange', 'Not inviting'),
  person('Eve Park', 'Female', 'Visiting Scholar', ''),
  [],
  person('  Fay   Ho ', 'Female', 'Undergrad', 'not contacted'),
]

describe('parseSheet', () => {
  it('finds the header under intro rows', () => {
    expect(findHeaderRow(SHEET)).toBe(16)
  })

  it('maps the standard columns and ignores the rest', () => {
    const result = parseSheet(SHEET)
    expect(result.fieldMap).toMatchObject({
      name: 'First & Last Name', nickname: 'Nickname (if any)', gender: 'Gender',
      level: 'Enrollment Status', status: 'Contact Status', timestamp: 'Timestamp',
    })
    expect(result.ignored).toContain('Cell Phone Number')
    expect(result.ignored).toContain('Email Address (Please provide your UCSD email)')
    expect(result.ignored).toContain('WeChat or Line ID (if you would like to be added to our group chat!)')
    expect(result.ignored).toContain('Student Status')
  })

  it('standardizes values and keeps no contact details', () => {
    const { rows } = parseSheet(SHEET)
    expect(rows.map(({ key: _key, ...r }) => r)).toEqual([
      { name: 'Amy Lin', nickname: 'Ames', gender: 'female', level: 'grad', status: 'confirmed' },
      { name: 'Ben Wu', nickname: '', gender: 'male', level: 'undergrad', status: 'awaiting_response' },
      { name: 'Cara Diaz', nickname: '', gender: 'female', level: 'grad', status: 'no_response' },
      { name: 'Dev Rao', nickname: '', gender: 'male', level: 'undergrad', status: 'not_inviting' },
      { name: 'Eve Park', nickname: '', gender: 'female', level: 'grad', status: 'not_contacted' },
      { name: 'Fay Ho', nickname: '', gender: 'female', level: 'undergrad', status: 'not_contacted' },
    ])
    expect(JSON.stringify(rows)).not.toMatch(/ucsd|858|wx_id/)
  })

  it('survives reordered and renamed columns', () => {
    const values = [
      ['Your Name', 'Sex', 'Year in school', 'Phone'],
      ['Gus Kim', 'M', 'PhD student', '555'],
    ]
    const [row] = parseSheet(values).rows
    expect(row).toMatchObject({ name: 'Gus Kim', gender: 'male', level: 'grad', status: 'not_contacted' })
  })

  it('joins separate first and last name columns', () => {
    const values = [['First Name', 'Last Name', 'Gender'], ['Ann', 'Lee', 'Female']]
    expect(parseSheet(values).rows[0].name).toBe('Ann Lee')
  })

  it('reports values it does not recognize', () => {
    const values = [['Name', 'Gender', 'Enrollment Status', 'Contact Status'], ['Hal', 'Other', 'Alumni', 'Maybe']]
    const result = parseSheet(values)
    expect(result.unrecognized).toEqual({ gender: ['Other'], level: ['Alumni'], status: ['Maybe'] })
    expect(result.rows[0]).toMatchObject({ gender: '', level: '', status: 'not_contacted' })
    expect(result.missing).toEqual({ gender: 1, level: 1 })
  })

  it('gives rows stable keys and tells duplicates apart', () => {
    const values = [['Timestamp', 'Name', 'Gender'], ['t1', 'Ivy', 'F'], ['t1', 'Ivy', 'F'], ['t2', 'Ivy', 'F']]
    const keys = parseSheet(values).rows.map((r) => r.key)
    expect(new Set(keys).size).toBe(3)
    expect(parseSheet(values).rows.map((r) => r.key)).toEqual(keys)
  })

  it('follows a saved field map on re-sync, even if columns moved', () => {
    const values = [['Gender', 'Preferred', 'Student', 'Level'], ['Female', 'Jo', 'Joanna Smith', 'Undergrad']]
    const result = parseSheet(values, { fieldMap: { name: 'Student', nickname: 'Preferred', level: 'Level' } })
    expect(result.rows[0]).toMatchObject({ name: 'Joanna Smith', nickname: 'Jo', level: 'undergrad', gender: 'female' })
  })

  it('lets a column be switched off', () => {
    const result = parseSheet(SHEET, { fieldMap: { nickname: '' } })
    expect(result.rows[0].nickname).toBe('')
    expect(result.ignored).toContain('Nickname (if any)')
  })

  it('fails clearly when there is no header', () => {
    expect(() => parseSheet([['a', 'b'], ['1', '2']])).toThrow(SheetFormatError)
  })
})

describe('value normalizers', () => {
  it('maps enrollment statuses to levels', () => {
    expect(['Masters', 'Undergrad', 'PhD', 'Exchange', 'Visiting Scholar'].map(levelOf)).toEqual([
      'grad', 'undergrad', 'grad', 'undergrad', 'grad',
    ])
  })

  it('maps genders and statuses', () => {
    expect(['male', 'Female', 'x'].map(genderOf)).toEqual(['male', 'female', ''])
    expect(['Confirmed', ' awaiting  response ', '', 'nope'].map(statusOf)).toEqual([
      'confirmed', 'awaiting_response', 'not_contacted', null,
    ])
  })
})
