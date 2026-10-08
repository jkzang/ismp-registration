import { useState } from 'react'
import { api } from '../api'
import { CheckInPanel } from '../components/CheckInPanel'
import { TablesBoard } from '../components/TablesBoard'
import { useSheet } from '../sheetContext'

/** The check-in list and the tables board side by side (one at a time on a phone), under SheetLayout's header. */
export function SheetPage() {
  const { sheet, setSheet, plan, setPlan, attendance, signupsChanged, onReplanAnswered } = useSheet()
  // Narrow screens show one panel at a time.
  const [panel, setPanel] = useState<'checkin' | 'tables'>('checkin')

  return (
    <div className={`sheet-view shows-${panel}`}>
      <div className="panel-switch segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={panel === 'checkin'} className={panel === 'checkin' ? 'is-on' : ''} onClick={() => setPanel('checkin')}>
          Check-in
        </button>
        <button type="button" role="tab" aria-selected={panel === 'tables'} className={panel === 'tables' ? 'is-on' : ''} onClick={() => setPanel('tables')}>
          Tables
        </button>
      </div>

      <div className="sheet-layout">
        <CheckInPanel
          sheet={sheet}
          plan={plan}
          onChange={(update) => setPlan((p) => (p ? update(p) : p))}
          onReload={() => api.getPlan(sheet.id).then(setPlan).catch(() => {})}
          onAttendance={attendance.record}
          onSheetChange={setSheet}
        />
        <TablesBoard
          sheetId={sheet.id}
          plan={plan}
          setPlan={setPlan}
          signupsChanged={signupsChanged}
          onReplanAnswered={onReplanAnswered}
        />
      </div>
    </div>
  )
}
