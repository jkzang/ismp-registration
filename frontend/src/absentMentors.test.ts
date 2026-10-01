import { describe, expect, it } from 'vitest'
import { searchMentors } from './absentMentors'
import type { Mentor } from './types'

const mentors: Mentor[] = [
  { id: 1, name: 'Mia Chen', gender: 'female' },
  { id: 2, name: 'Leo Park', gender: 'male' },
  { id: 3, name: 'Leon Wu', gender: 'male' },
  { id: 4, name: 'Mia Tran', gender: 'female' },
  { id: 5, name: 'José Ramírez', gender: 'male' },
]

const ids = (query: string) => searchMentors(query, mentors).map((m) => m.id)

describe('searchMentors', () => {
  it('matches the start of a name, whatever the case or spacing', () => {
    expect(ids('mia')).toEqual([1, 4])
    expect(ids('  LEO   PARK ')).toEqual([2])
    expect(ids('Mia T')[0]).toBe(4)
  })

  it('matches the start of a last name and the middle of a name', () => {
    expect(ids('park')).toEqual([2])
    // A near miss (“Ramírez”) still shows, below the real match.
    expect(ids('ran')).toEqual([4, 5])
  })

  it('puts closer matches first', () => {
    // “Ramírez” starts with “ra”; “Tran” only contains it.
    expect(ids('ch')).toEqual([1])
    expect(ids('le')).toEqual([2, 3])
    expect(ids('ra')).toEqual([5, 4])
  })

  it('forgives typos, missing letters and accents', () => {
    expect(ids('leom')).toEqual([2, 3])
    expect(ids('mia chn')).toEqual([1])
    expect(ids('jose ramirez')).toEqual([5])
    expect(ids('lpk')).toEqual([2])
  })

  it('finds nothing for a blank or unrelated query', () => {
    expect(ids('')).toEqual([])
    expect(ids('   ')).toEqual([])
    expect(ids('zzz')).toEqual([])
  })
})
