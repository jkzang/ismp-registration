import { useEffect, useRef } from 'react'
import { DEFAULT_MESSAGES, MESSAGE_LABELS } from '../signupTracker'
import { CloseIcon } from './icons'

/** The two messages Text and Email start with, edited in a dialog from the Sign-ups page. */
export function MessagesDialog({ open, event, templates, onChange, onClose }: {
  open: boolean
  /** What {event} becomes. */
  event: string
  templates: readonly string[]
  onChange: (index: number, text: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="person-dialog messages-dialog"
      aria-labelledby="messages-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <header className="dialog-head">
        <h2 id="messages-title">Messages</h2>
        <button type="button" className="chip-icon" aria-label="Close" onClick={() => ref.current?.close()}>
          <CloseIcon />
        </button>
      </header>
      <div className="dialog-body">
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
          <code>{'{event}'}</code> this sheet’s name, “{event}”: the name at the top of the page, which is the Google Sheets tab’s
          title unless renamed with the pencil. Kept on this device only.
        </p>
      </div>
      <footer className="dialog-foot">
        <button type="button" className="primary" onClick={() => ref.current?.close()}>
          Done
        </button>
      </footer>
    </dialog>
  )
}
