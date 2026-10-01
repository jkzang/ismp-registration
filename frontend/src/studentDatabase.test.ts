import { describe, expect, it } from 'vitest'
import { parseSheet } from './sheetParser'
import { fillFromDatabase, isDatabaseTab, parseWithDatabase } from './studentDatabase'

const SIGNUP_HEADER = ['Timestamp', 'First & Last Name', 'Nickname (if any)', 'Cell Phone Number', 'Email Address', 'Gender', 'Enrollment Status']
const DATABASE = [
  ['Name', 'Nickname', 'Phone', 'Email', 'Gender', 'Enrollment Status'],
  ['Amy Lin', 'Ames', '(858) 555-0100', 'amy@ucsd.edu', 'Female', 'Masters'],
  ['Ben Wu', '', '858-555-0111', 'ben@ucsd.edu', 'Male', 'Undergrad'],
  ['Cara Diaz', 'CD', '', 'cara@ucsd.edu', 'Female', 'PhD'],
  ['Dev Rao', '', '', '', 'Male', 'Undergrad'],
  ['Dev Rao', '', '', '', 'Male', 'Masters'],
  ['Eve Park', 'Evie', '', '', 'Female', 'Undergrad'],
]

function fill(rows: string[][]) {
  const values = [SIGNUP_HEADER, ...rows]
  return fillFromDatabase(values, parseSheet(values), DATABASE)
}

describe('Student Database', () => {
  it('recognizes the tab', () => {
    expect(isDatabaseTab('Student Database')).toBe(true)
    expect(isDatabaseTab('student_database')).toBe(true)
    expect(isDatabaseTab('Form Responses 1')).toBe(false)
  })

  it('matches by phone first, whatever the formatting, even under another name', () => {
    const { fills } = fill([['9/1', 'Amy L.', '', '+1 858 555 0100', '', '', '']])
    expect(fills.map((f) => [f.field, f.text])).toEqual([['gender', 'Female'], ['level', 'Masters'], ['nickname', 'Ames']])
  })

  it('matches by email, ignoring case', () => {
    const { fills } = fill([['9/1', 'Cara', '', '', 'CARA@ucsd.edu ', '', '']])
    expect(fills.map((f) => f.text)).toEqual(['Female', 'PhD', 'CD'])
  })

  it('matches by name only when the name is unique', () => {
    expect(fill([['9/1', 'eve park', '', '', '', '', '']]).fills.map((f) => f.text)).toEqual(['Female', 'Undergrad', 'Evie'])
    expect(fill([['9/1', 'Dev Rao', '', '', '', '', '']]).fills).toEqual([])
  })

  it('fills only blank cells and puts them in the right place', () => {
    const { fills, values } = fill([['9/1', 'Ben Wu', 'Benny', '858-555-0111', '', '', 'Grad']])
    expect(fills).toEqual([{ row: 1, column: 5, field: 'gender', text: 'Male' }])
    expect(values[1]).toEqual(['9/1', 'Ben Wu', 'Benny', '858-555-0111', '', 'Male', 'Grad'])
  })

  it('leaves unmatched people alone', () => {
    expect(fill([['9/1', 'Zed Stranger', '', '000-000-0000', 'zed@x.com', '', '']]).fills).toEqual([])
  })

  it('imports the filled values, with the same row keys', () => {
    const values = [SIGNUP_HEADER, ['9/1', 'Amy Lin', '', '858-555-0100', '', '', '']]
    const plain = parseSheet(values)
    const { parsed } = parseWithDatabase(values, DATABASE)
    expect(parsed.rows[0]).toMatchObject({ gender: 'female', level: 'grad', nickname: 'Ames', key: plain.rows[0].key })
    expect(JSON.stringify(parsed.rows)).not.toMatch(/858|ucsd/)
  })
})
