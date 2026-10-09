import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react'
import { api } from '../api'
import { desktop } from '../desktop'
import { DEFAULT_MESSAGES, MESSAGE_LABELS } from '../signupTracker'
import { eventName, sheetName, type Sheet } from '../types'
import { useUndo } from '../undo'
import { BulkText } from './BulkText'
import { CloseIcon } from './icons'
import { Segmented } from './Segmented'

type BulkProps = Omit<ComponentProps<typeof BulkText>, 'templates' | 'onBusyChange'>

/** What {event} becomes, saved on the sheet for everyone. Cleared, it falls back to the sheet's name. */
function EventNameField({ sheet, onSaved }: { sheet: Sheet; onSaved: (sheet: Sheet) => void }) {
  const { push } = useUndo()
  const [value, setValue] = useState(sheet.event_name)
  const [error, setError] = useState(false)
  useEffect(() => setValue(sheet.event_name), [sheet.event_name])

  async function save() {
    const name = value.trim()
    if (name === sheet.event_name) return setValue(name)
    const before = sheet.event_name
    const setName = (event_name: string) => async () => onSaved(await api.updateSheet(sheet.id, { event_name }))
    try {
      await setName(name)()
      push({ label: 'the event name change', undo: setName(before), redo: setName(name) })
      setError(false)
    } catch {
      setError(true)
    }
  }

  return (
    <label className={`message-event${error ? ' has-error' : ''}`}>
      <span>Event name</span>
      <input
        type="text"
        value={value}
        maxLength={200}
        placeholder={sheetName(sheet)}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {error && <span className="error">Couldn’t save the event name.</span>}
    </label>
  )
}

/**
 * The two messages Text and Email start with, edited in a dialog from the Sign-ups page. In the Mac
 * app it also texts them to a group at once (BulkText); it can't be closed while that's sending.
 */
export function MessagesDialog({ open, sheet, onSheetSaved, templates, onChange, onClose, bulk }: {
  open: boolean
  sheet: Sheet
  onSheetSaved: (sheet: Sheet) => void
  templates: readonly string[]
  onChange: (index: number, text: string) => void
  onClose: () => void
  bulk: BulkProps
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const canBulk = !!desktop?.sendText && !!desktop.checkTexting
  const [tab, setTab] = useState<'templates' | 'bulk'>('templates')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const onBusyChange = useCallback((b: boolean) => {
    busyRef.current = b
    setBusy(b)
  }, [])
  const close = () => !busyRef.current && ref.current?.close()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`person-dialog messages-dialog${tab === 'bulk' ? ' is-wide' : ''}`}
      aria-labelledby="messages-title"
      // React passes a dialog's close and cancel up from the send confirmation inside it.
      onClose={(e) => e.target === e.currentTarget && onClose()}
      onCancel={(e) => e.target === e.currentTarget && busyRef.current && e.preventDefault()}
      onClick={(e) => e.target === e.currentTarget && close()}
    >
      <header className="dialog-head">
        <h2 id="messages-title">Messages</h2>
        <button type="button" className="chip-icon" aria-label="Close" disabled={busy} onClick={close}>
          <CloseIcon />
        </button>
      </header>
      <div className="dialog-body">
        {canBulk && (
          <Segmented
            label="Messages"
            value={tab}
            options={[
              { value: 'templates', label: 'Templates' },
              { value: 'bulk', label: 'Bulk text' },
            ]}
            onChange={(t) => !busy && setTab(t)}
          />
        )}
        {canBulk && tab === 'bulk' ? (
          <BulkText {...bulk} templates={templates} onBusyChange={onBusyChange} />
        ) : (
          <>
            <EventNameField sheet={sheet} onSaved={onSheetSaved} />
            {MESSAGE_LABELS.map((label, i) => (
              <div key={label} className="message-editor">
                <label>
                  <span>{label}</span>
                  <textarea rows={4} value={templates[i]} onChange={(e) => onChange(i, e.target.value)} />
                </label>
                {templates[i] !== DEFAULT_MESSAGES[i] && (
                  <button type="button" className="link-button message-reset" onClick={() => onChange(i, DEFAULT_MESSAGES[i])}>
                    Reset
                  </button>
                )}
              </div>
            ))}
            <p className="muted message-help">
              <code>{'{first}'}</code> is their nickname or first name, <code>{'{name}'}</code> their full name and{' '}
              <code>{'{event}'}</code> the event name above, “{eventName(sheet)}”, which is also the emails’ subject. The event
              name is saved for everyone; the messages are kept on this device only.
            </p>
          </>
        )}
      </div>
      {tab !== 'bulk' && (
        <footer className="dialog-foot">
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </footer>
      )}
    </dialog>
  )
}
