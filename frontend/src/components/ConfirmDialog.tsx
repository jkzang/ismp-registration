import { useEffect, useId, useRef } from 'react'

/** An in-app replacement for window.confirm. Escape, Cancel or a click on the backdrop calls onClose.
 *  `danger` marks a confirm that deletes something. */
export function ConfirmDialog({ open, title, children, confirmLabel, danger = false, onConfirm, onClose }: {
  open: boolean
  title: string
  children: React.ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="confirm-body">
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-message">{children}</div>
      </div>
      <footer className="dialog-foot">
        <button type="button" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} autoFocus onClick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </dialog>
  )
}
