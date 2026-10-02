/**
 * Who can come in at the door, given the sheet's capacity.
 *
 * Confirmed sign-ups (they answered the confirmation text) have a reserved spot until
 * RESERVE_MINUTES after the event starts, or until the door volunteer releases the reserved spots
 * early. After that, a confirmed person who hasn't come is treated like anyone else.
 *
 * Everyone else takes a free spot: one that isn't reserved and isn't owed to someone already
 * waiting. With no free spot they join the waitlist, which has no cap. The waitlist gets in
 * strictly in order, as spots open up (usually when reserved spots are released).
 */
import type { PlanStudent, Sheet } from './types'

export const RESERVE_MINUTES = 20

export type DoorAction = 'check-in' | 'checked-in' | 'waitlist' | 'waitlisted' | 'no-room'

type Person = Pick<PlanStudent, 'status' | 'checked_in' | 'waitlisted_at'>

/** When confirmed people's reserved spots run out on their own; null without a start time. */
export function reservedUntil(sheet: Pick<Sheet, 'starts_at'>): Date | null {
  return sheet.starts_at ? new Date(new Date(sheet.starts_at).getTime() + RESERVE_MINUTES * 60_000) : null
}

/** Whether confirmed people have lost their reserved spots: released early, or the time ran out. */
export function isReleased(sheet: Pick<Sheet, 'starts_at' | 'reserved_released_at'>, now: number): boolean {
  const until = reservedUntil(sheet)
  return !!sheet.reserved_released_at || (until !== null && now >= until.getTime())
}

/** "No space" sign-ups are only listed by name: they're left out of every count unless they check in. */
export const isCounted = (p: Pick<Person, 'status' | 'checked_in'>) => p.checked_in || p.status !== 'no_space'

const isConfirmed = (p: Person) => p.status === 'confirmed'

/** Until the release, a confirmed person never waits: their spot is reserved. */
export const isWaitlisted = (p: Person, released: boolean) =>
  !!p.waitlisted_at && !p.checked_in && (released || !isConfirmed(p))

/** The waitlist in the order people joined it. */
export const waitlistOf = <P extends Person>(people: P[], released: boolean) =>
  people.filter((p) => isWaitlisted(p, released)).sort((a, b) => a.waitlisted_at!.localeCompare(b.waitlisted_at!))

export function doorCounts<P extends Person>(people: P[], capacity: number | null, released: boolean) {
  const count = (pred: (p: P) => boolean) => people.filter(pred).length
  const checkedIn = count((p) => p.checked_in)
  const confirmed = count(isConfirmed)
  const confirmedIn = count((p) => isConfirmed(p) && p.checked_in)
  const waitlisted = count((p) => isWaitlisted(p, released))
  const reserved = released ? 0 : confirmed - confirmedIn
  // Spots not taken by anyone here; null without a capacity.
  const room = capacity === null ? null : capacity - checkedIn
  return {
    checkedIn,
    confirmed,
    confirmedIn,
    unconfirmedIn: checkedIn - confirmedIn,
    /** Confirmed people not here yet, whose spots are held for them. */
    reserved,
    waitlisted,
    room,
    /** Checked in up to capacity: nobody else, confirmed or not, can come in. */
    full: room !== null && room <= 0,
    /** How many from the front of the waitlist can come in now. */
    forWaitlist: room === null ? waitlisted : Math.min(waitlisted, Math.max(0, room - reserved)),
    /** Spots a newcomer can take without jumping the waitlist; null without a capacity. */
    free: room === null ? null : Math.max(0, room - reserved - waitlisted),
  }
}

export type DoorCounts = ReturnType<typeof doorCounts>

/** `place` is their 0-based place on the waitlist, if they're on it. */
export function doorAction(person: Person, counts: DoorCounts, released: boolean, place = -1): DoorAction {
  if (person.checked_in) return 'checked-in'
  if (place >= 0) return place < counts.forWaitlist ? 'check-in' : 'waitlisted'
  if (isConfirmed(person) && !released) return counts.full ? 'no-room' : 'check-in'
  if (counts.free === null || counts.free > 0) return 'check-in'
  return counts.full ? 'no-room' : 'waitlist'
}

/**
 * What a waitlisted person can expect, by their 0-based place: up now, in if enough confirmed
 * people don't come, or not likely.
 */
export function waitlistChance(place: number, counts: DoorCounts): string {
  if (place < counts.forWaitlist) return 'Can come in now'
  if (counts.room === null) return 'Can come in now'
  const noShows = place + 1 - Math.max(0, counts.room - counts.reserved)
  if (noShows <= counts.reserved) return `In if ${noShows} confirmed ${noShows === 1 ? 'person doesn’t' : 'people don’t'} come`
  return 'Unlikely to get in'
}
