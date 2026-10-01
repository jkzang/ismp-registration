/**
 * Mirrors check-ins into the Google Sheet's attendance checkboxes as they happen.
 *
 * Writes go straight from this browser to Google (like re-sync), in the background: a check-in
 * never waits on the sheet. Each write also ticks anyone checked in whose box isn't ticked yet, so a
 * write that failed earlier, or one from another volunteer's device, is caught up by the next one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAccessToken,
  NeedsSignInError,
  NoAccessError,
  NoAttendanceColumnError,
  pickSpreadsheet,
  writeAttendance,
} from './google'
import { errorMessage } from './api'
import type { AppConfig, SeatingPlan, Sheet } from './types'

export type AttendanceStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  /** This device needs Google sign-in, or to pick the file once; Connect fixes it. */
  | { kind: 'needs-access' }
  | { kind: 'no-column'; message: string }
  | { kind: 'error'; message: string }

// Check-ins in quick succession go out as one write.
const BATCH_MS = 400

export function useAttendanceSync(config: AppConfig, sheet: Sheet | null, plan: SeatingPlan | null) {
  const [status, setStatusState] = useState<AttendanceStatus>({ kind: 'idle' })
  // Read by the callbacks, which shouldn't wait for a render to see the latest status.
  const statusRef = useRef(status)
  const setStatus = useCallback((next: AttendanceStatus) => {
    statusRef.current = next
    setStatusState(next)
  }, [])
  const sheetRef = useRef(sheet)
  const planRef = useRef(plan)
  sheetRef.current = sheet
  planRef.current = plan
  // Undone check-ins from this device, still to be unticked.
  const untick = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = useRef(false)
  const again = useRef(false)

  // A different sheet, or a re-sync that may have added the column: start over.
  const sheetId = sheet?.id
  const attendanceColumn = sheet?.field_map.attendance
  useEffect(() => {
    untick.current.clear()
    setStatus({ kind: 'idle' })
  }, [sheetId, attendanceColumn, setStatus])

  const flush = useCallback(
    async (interactive: boolean) => {
      const current = sheetRef.current
      const currentPlan = planRef.current
      if (!current || !currentPlan) return
      if (running.current) {
        again.current = true
        return
      }
      running.current = true
      setStatus({ kind: 'saving' })
      try {
        await getAccessToken(config, { interactive })
      } catch {
        running.current = false
        setStatus({ kind: 'needs-access' })
        return
      }
      const tick = new Set(currentPlan.students.filter((s) => s.checked_in).map((s) => s.key))
      const clearing = new Set([...untick.current].filter((key) => !tick.has(key)))
      try {
        await writeAttendance(config, current, tick, clearing)
        for (const key of clearing) untick.current.delete(key)
        setStatus({ kind: 'saved' })
      } catch (err) {
        if (err instanceof NoAccessError || err instanceof NeedsSignInError) setStatus({ kind: 'needs-access' })
        else if (err instanceof NoAttendanceColumnError) setStatus({ kind: 'no-column', message: err.message })
        else setStatus({ kind: 'error', message: errorMessage(err, 'Couldn’t write attendance to the sheet.') })
      } finally {
        running.current = false
      }
      if (again.current) {
        again.current = false
        flush(false)
      }
    },
    [config, setStatus],
  )

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  /** Call after a check-in or an undone one. Runs from a click, so Google's popup may open if needed. */
  const record = useCallback(
    (key: string, checkedIn: boolean) => {
      if (checkedIn) untick.current.delete(key)
      else untick.current.add(key)
      // Without the column there's nothing to write, until a re-sync finds one.
      if (statusRef.current.kind === 'no-column') return
      setStatus({ kind: 'saving' })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        flush(true)
      }, BATCH_MS)
    },
    [flush, setStatus],
  )

  /** From a click: sign in, pick the file if this device hasn't yet, then write. */
  const connect = useCallback(async () => {
    const current = sheetRef.current
    if (!current) return
    try {
      const accessToken = await getAccessToken(config)
      await flush(false)
      // Signed in but still no access: someone else imported it, so this device picks the file once.
      if (statusRef.current.kind === 'needs-access') {
        const picked = await pickSpreadsheet(config, accessToken, current.spreadsheet_id)
        if (picked) await flush(false)
      }
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err, 'Couldn’t connect to Google.') })
    }
  }, [config, flush, setStatus])

  return { status, record, connect, retry: () => flush(true) }
}
