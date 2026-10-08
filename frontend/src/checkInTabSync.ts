/**
 * Keeps the sheet's "[tab] - Check In" tab in step with the saved plan: check-ins, re-plans, seats
 * handed out at the door, people moved by hand, and other volunteers' changes as the page refreshes.
 *
 * Like attendance, writes go straight from this browser to Google, in the background, and only when
 * what the tab shows has changed. It never opens Google's popup itself: without a token it waits
 * for one (the attendance chip's Connect, or the next click that signs in) and catches up then.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from './api'
import { checkInLayout } from './checkInTab'
import { getAccessToken, NeedsSignInError, NoAccessError, writeCheckInTab } from './google'
import type { AppConfig, SeatingPlan, Sheet } from './types'

export type CheckInTabStatus =
  | { kind: 'idle' }
  | { kind: 'needs-access' }
  | { kind: 'error'; message: string }

// Changes in quick succession (a drag, then the save coming back) go out as one write.
const BATCH_MS = 1000

const updatedAt = () => new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function useCheckInTabSync(config: AppConfig, sheet: Sheet | null, plan: SeatingPlan | null) {
  const [status, setStatus] = useState<CheckInTabStatus>({ kind: 'idle' })
  const latest = useRef({ sheet, plan })
  latest.current = { sheet, plan }
  // What the tab was last written with, so an unchanged refresh writes nothing.
  const written = useRef<string | null>(null)
  const running = useRef(false)
  const again = useRef(false)

  const flush = useCallback(async () => {
    if (running.current) {
      again.current = true
      return
    }
    const { sheet, plan } = latest.current
    if (!sheet || !plan) return
    // What the tab shows, less the time it was written.
    const key = JSON.stringify([sheet.id, sheet.tab_id, sheet.tab_title, checkInLayout(plan, '').rows])
    if (key === written.current) return
    running.current = true
    try {
      await getAccessToken(config, { interactive: false })
      await writeCheckInTab(config, sheet, (title) => checkInLayout(plan, title, updatedAt()))
      written.current = key
      setStatus({ kind: 'idle' })
    } catch (err) {
      if (err instanceof NeedsSignInError || err instanceof NoAccessError) setStatus({ kind: 'needs-access' })
      else setStatus({ kind: 'error', message: errorMessage(err, 'Couldn’t update the check-in tab.') })
    } finally {
      running.current = false
    }
    if (again.current) {
      again.current = false
      flush()
    }
  }, [config])

  // A different sheet starts over. The page reloads the plan every 20 seconds, which also retries a
  // write that failed.
  const sheetId = sheet?.id
  useEffect(() => {
    written.current = null
    setStatus({ kind: 'idle' })
  }, [sheetId])

  useEffect(() => {
    if (!sheet || !plan) return
    const timer = setTimeout(flush, BATCH_MS)
    return () => clearTimeout(timer)
  }, [sheet, plan, flush])

  return { status, retry: flush }
}
