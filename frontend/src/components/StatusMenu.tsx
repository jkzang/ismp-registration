import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { CheckIcon, ChevronDownIcon } from './icons'

export type StatusOption<T extends string> = {
  value: T
  label: string
  /** The class that colors it, as on the pill. */
  tone: string
  /** Options sharing a group sit under its name. */
  group?: string
}

/** The nearest ancestor that scrolls up and down. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p
  }
  return null
}

/**
 * A colored pill that opens a menu of statuses below it, each shown in its own colors. The menu
 * always opens downward: near the bottom of the list, the list scrolls to make room for it.
 */
export function StatusMenu<T extends string>({ className, value, options, placeholder, label, title, disabled, onChange }: {
  /** Classes for the pill, its tone among them. */
  className: string
  value: T | null
  options: StatusOption<T>[]
  /** Shown on the pill when there's no value. */
  placeholder?: string
  /** Its accessible name. */
  label: string
  title?: string
  disabled?: boolean
  onChange: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    return () => document.removeEventListener('pointerdown', onPointer)
  }, [open])

  // Scroll the list just enough to show the whole menu, never so far that the pill leaves view,
  // then start on the current status.
  useLayoutEffect(() => {
    if (!open || !menu.current || !ref.current) return
    const scroller = scrollerOf(ref.current)
    if (scroller) {
      const box = scroller.getBoundingClientRect()
      const over = menu.current.getBoundingClientRect().bottom + 8 - box.bottom
      const room = ref.current.getBoundingClientRect().top - box.top
      // Measured on screen, scrolled in the page's own pixels, which the UI scale shrinks.
      const scale = scroller.offsetHeight / box.height || 1
      if (over > 0) scroller.scrollTop += Math.min(over, Math.max(room, 0)) * scale
    }
    const items = menu.current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    ;([...items].find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true })
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }

  const onMenuKey = (e: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const to =
      e.key === 'ArrowDown' ? (at + 1) % items.length
        : e.key === 'ArrowUp' ? (at - 1 + items.length) % items.length
          : e.key === 'Home' ? 0
            : e.key === 'End' ? items.length - 1
              : null
    if (to !== null) {
      e.preventDefault()
      items[to]?.focus()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const groups = [...new Set(options.map((o) => o.group))]

  return (
    <div className="status-menu-anchor" ref={ref}>
      <button
        type="button"
        ref={button}
        className={`status-select ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="status-select-label">{current?.label ?? placeholder}</span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="column-menu status-menu" role="menu" aria-label={label} ref={menu} onKeyDown={onMenuKey}>
          {groups.map((group) => (
            <div key={group ?? ''} className="status-menu-group" role="group" aria-label={group}>
              {group && <div className="status-menu-heading" aria-hidden="true">{group}</div>}
              {options.filter((o) => o.group === group).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className="column-option status-option"
                  role="menuitemradio"
                  aria-checked={o.value === value}
                  onClick={() => {
                    close()
                    if (o.value !== value) onChange(o.value)
                  }}
                >
                  <span className={`detail-chip ${o.tone}`}>{o.label}</span>
                  {o.value === value && <CheckIcon />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
