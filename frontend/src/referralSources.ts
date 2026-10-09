/**
 * "How did you hear about this event?" is a free-text question, so the same source comes in many
 * spellings ("iEvents", "UCSD's Events Calendar", "ievents.ucsd.edu"). Each answer is sorted into
 * one of a few sources by keyword, the way sheetParser.ts reads gender and level.
 */

/** In order: an answer goes to the first source it matches, so "iEvents via ISEO Email" is iEvents. */
export const REFERRAL_SOURCES: { label: string; pattern: RegExp }[] = [
  { label: 'iEvents', pattern: /\bi ?events?\b|calendar/ },
  { label: 'Tabling', pattern: /\btabl(e|ing)\b|library walk|on the square/ },
  { label: 'ISMP events', pattern: /welcome dinner|\b(last|some|previous|past) event\b|through ismp/ },
  { label: 'WeChat & Line', pattern: /wechat|weixin|微信|\bline\b|chat(ting)? group|group ?chat/ },
  { label: 'Instagram', pattern: /\binsta(gram)?\b|\big\b/ },
  { label: 'Friend or mentor', pattern: /friend|mentor|roommate|classmate|word of mouth/ },
  { label: 'Posters & flyers', pattern: /poster|flyer/ },
  { label: 'Email', pattern: /e-?mail|newsletter|listserv/ },
  { label: 'Website', pattern: /website|webpage|homepage|\bsite\b/ },
  { label: 'ChatGPT', pattern: /chat ?gpt|\bai\b/ },
  { label: 'Orientation', pattern: /orientation/ },
]
export const OTHER_SOURCE = 'Other'

/** The source of one answer, or Other. */
export function referralSourceOf(text: string): string {
  const t = text.toLowerCase()
  return REFERRAL_SOURCES.find((s) => s.pattern.test(t))?.label ?? OTHER_SOURCE
}

/**
 * The sources in someone's answer, none when it's blank. A "(Note: Tabling)" left in the cell says
 * where they really heard. Otherwise each part of a checkbox answer ("Friend, Instagram") counts.
 */
export function referralSourcesOf(text: string): string[] {
  const note = /\(\s*note:\s*([^)]*)\)/i.exec(text)
  if (note) return [referralSourceOf(note[1])]
  const parts = text.split(/,\s+/).map((a) => a.trim()).filter(Boolean)
  return [...new Set(parts.map(referralSourceOf))]
}
