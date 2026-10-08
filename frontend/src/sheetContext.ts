import { createContext, useContext, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { useAttendanceSync } from './attendanceSync'
import type { readContacts } from './signupTracker'
import type { SeatingPlan, Sheet } from './types'

/** The sign-up tab as last read in this browser, for the Sign-ups page. */
export type SheetRead = ReturnType<typeof readContacts>

/**
 * What a sheet's Check-in and Sign-ups pages share, from SheetLayout: the sheet, its plan, the tab as
 * last read, and the one background sync that keeps them all in step with the sheet. Switching
 * between the pages keeps all of it; nothing is loaded again.
 */
export type SheetContextValue = {
  sheet: Sheet
  setSheet: (sheet: Sheet) => void
  plan: SeatingPlan
  setPlan: Dispatch<SetStateAction<SeatingPlan | null>>
  /** Null until the tab has been read in this browser. */
  read: SheetRead | null
  setRead: Dispatch<SetStateAction<SheetRead | null>>
  access: 'checking' | 'needs-access' | 'ok'
  /** Why the sheet's status columns and statistics couldn't be updated, e.g. it's view-only. */
  tendError: string | null
  /** Reads the tab and sends any change on to check-in; with `interactive`, from a click, so it may open Google's popups. */
  readSheet: (interactive: boolean) => Promise<void>
  /** Writes to the sheet from the Sign-ups page go one at a time; a read overlapping one is dropped, as it may predate it. */
  queue: MutableRefObject<Promise<unknown>>
  writes: MutableRefObject<{ running: number; done: number }>
  setError: (message: string | null) => void
  signupsChanged: boolean
  onReplanAnswered: () => void
  attendance: ReturnType<typeof useAttendanceSync>
}

export const SheetContext = createContext<SheetContextValue | null>(null)

export function useSheet() {
  const value = useContext(SheetContext)
  if (!value) throw new Error('useSheet outside SheetLayout')
  return value
}
