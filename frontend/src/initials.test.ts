import { describe, expect, it } from 'vitest'
import { initials } from './initials'

describe('initials', () => {
  it('uses the first and last names', () => {
    expect(initials('Jack Zhang')).toBe('JZ')
    expect(initials('Mary Ann Lee')).toBe('ML')
    expect(initials('cher')).toBe('C')
  })

  it('ignores anything in parentheses', () => {
    expect(initials('Jack Zhang (San Diego)')).toBe('JZ')
    expect(initials('Jack (JZ) Zhang')).toBe('JZ')
    expect(initials('(Staff) Jack Zhang (UCSD (Fall))')).toBe('JZ')
    expect(initials('Jack Zhang（圣地亚哥）')).toBe('JZ')
  })

  it('falls back to a question mark', () => {
    expect(initials('')).toBe('?')
    expect(initials('(San Diego)')).toBe('?')
  })
})
