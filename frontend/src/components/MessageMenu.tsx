import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A Text or Email button that asks which message to start with: each choice is a link that opens
 * the phone's messages or the mail app with it filled in. `end` opens the menu leftward.
 */
export function MessageMenu({ className, label, title, children, items, end, onPick }: {
  className: string
  /** Its accessible name. */
  label: string
  title?: string
  children: ReactNode
  items: { label: string; href: string; preview: string }[]
  end?: boolean
  onPick: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="message-menu-anchor" ref={ref}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div className={`column-menu message-menu${end ? ' is-end' : ''}`} role="menu" aria-label={label}>
          {items.map((item) => (
            <a
              key={item.label}
              className="column-option message-option"
              role="menuitem"
              href={item.href}
              onClick={() => {
                setOpen(false)
                onPick()
              }}
            >
              <span className="message-option-label">{item.label}</span>
              <span className="message-option-preview">{item.preview}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
