import { describe, expect, it } from 'vitest'
import { referralSourcesOf } from './referralSources'

describe('referralSourcesOf', () => {
  it('sorts the answers people actually wrote', () => {
    const cases: [string, string[]][] = [
      ['Searching for ISMP events on UCSD calendars', ['iEvents']],
      ['iEvent Calendar', ['iEvents']],
      ['On the website: ievents.ucsd.edu', ['iEvents']],
      ['iEvents via ChatGPT', ['iEvents']],
      ['iEvents via ISEO Email', ['iEvents']],
      ['Calendar event (Note: iEvents)', ['iEvents']],
      ['UCSD’s Events Calendar and posters (Note: iEvents)', ['iEvents']],
      ['On the square. (Note: Tabling)', ['Tabling']],
      ['Tabling @ Library Walk', ['Tabling']],
      ['Table', ['Tabling']],
      ['Ismp Website', ['Website']],
      ['ISEO webpage', ['Website']],
      ['ucsd website', ['Website']],
      ['homepage', ['Website']],
      ['from mentor', ['Friend or mentor']],
      ['Friend', ['Friend or mentor']],
      ['in Instagram', ['Instagram']],
      ['Insta', ['Instagram']],
      ['ChatGPT', ['ChatGPT']],
      ['In chatting group', ['WeChat & Line']],
      ['WeChat invitation ', ['WeChat & Line']],
      ['From last event & line group', ['ISMP events']],
      ['ISMP Welcome Dinner', ['ISMP events']],
      ['Through ISMP', ['ISMP events']],
      ['Some event', ['ISMP events']],
      ['Poster', ['Posters & flyers']],
      ['Email', ['Email']],
      ['Orientation ', ['Orientation']],
      ['I am omniscient :)', ['Other']],
      ['Enlin', ['Other']],
      ['Other', ['Other']],
    ]
    for (const [answer, sources] of cases) expect([answer, referralSourcesOf(answer)]).toEqual([answer, sources])
  })

  it('counts each part of a checkbox answer once, and nothing for a blank', () => {
    expect(referralSourcesOf('Friend, Instagram')).toEqual(['Friend or mentor', 'Instagram'])
    expect(referralSourcesOf('Friend, a friend')).toEqual(['Friend or mentor'])
    expect(referralSourcesOf('  ')).toEqual([])
  })
})
