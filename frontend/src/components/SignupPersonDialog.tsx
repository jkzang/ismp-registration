import { useEffect, useRef, type ReactNode } from 'react'
import { dialable, mailtoHref, shortTimestamp, smsHref, socialLabel, telHref, type Contact } from '../signupTracker'
import { CONTACT_STATUSES, type ContactStatus } from '../types'
import { CloseIcon, MailIcon, MessageIcon, PhoneIcon } from './icons'

export const GENDER_LABELS = { female: 'Girl', male: 'Guy' } as const
export const LEVEL_LABELS = { undergrad: 'Undergrad', grad: 'Grad', other: 'Not a student' } as const

/** Gender and enrollment as colored chips. */
export function DetailChips({ contact }: { contact: Pick<Contact, 'gender' | 'level'> }) {
  return (
    <>
      {contact.gender && <span className={`detail-chip gender-${contact.gender}`}>{GENDER_LABELS[contact.gender]}</span>}
      {contact.level && <span className={`detail-chip level-${contact.level}`}>{LEVEL_LABELS[contact.level]}</span>}
    </>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="person-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * Everything someone put on the form, opened from their name on the Sign-ups page. Texting,
 * calling or emailing from here counts as reaching out, as it does from the list.
 */
export function SignupPersonDialog({ contact, status, chatAdded, event, message, onContacted, onClose }: {
  contact: Contact | null
  status: ContactStatus
  chatAdded: boolean
  event: string
  message: string
  onContacted: (contact: Contact) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const open = contact !== null

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  const phone = contact ? dialable(contact.phone) : ''

  return (
    <dialog
      ref={ref}
      className="person-dialog"
      aria-labelledby="person-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      {contact && (
        <>
          <header className="dialog-head">
            <div className="person-heading">
              <h2 id="person-title">
                {contact.name}
                {contact.nickname && <span className="checkin-nickname">“{contact.nickname}”</span>}
              </h2>
              <div className="person-chips">
                <DetailChips contact={contact} />
                <span className={`detail-chip status-${status}`}>{CONTACT_STATUSES.find((s) => s.value === status)?.label}</span>
              </div>
            </div>
            <button type="button" className="chip-icon" aria-label="Close" onClick={() => ref.current?.close()}>
              <CloseIcon />
            </button>
          </header>
          <div className="dialog-body">
            {(phone || contact.email.includes('@')) && (
              <div className="person-actions">
                {phone && (
                  <a className="person-action" href={smsHref(contact.phone, message)} onClick={() => onContacted(contact)}>
                    <MessageIcon /> Text
                  </a>
                )}
                {phone && (
                  <a className="person-action" href={telHref(contact.phone)} onClick={() => onContacted(contact)}>
                    <PhoneIcon /> Call
                  </a>
                )}
                {contact.email.includes('@') && (
                  <a className="person-action" href={mailtoHref(contact.email, event, message)} onClick={() => onContacted(contact)}>
                    <MailIcon /> Email
                  </a>
                )}
              </div>
            )}
            <dl className="person-fields">
              {contact.signedUp && <Field label="Signed up">{shortTimestamp(contact.signedUp)}</Field>}
              {contact.phone && <Field label="Phone">{contact.phone}</Field>}
              {contact.email && <Field label="Email">{contact.email}</Field>}
              {contact.socials.map((s) => (
                <Field key={s.label} label={socialLabel(s.label)}>
                  {s.id}
                </Field>
              ))}
              {(contact.wantsChat || chatAdded) && (
                <Field label="Group chats">{chatAdded ? 'Added' : 'Wants to join'}</Field>
              )}
              {contact.referral && <Field label="Heard about it">{contact.referral}</Field>}
              {contact.answers.map((a) => (
                <Field key={a.label} label={a.label}>
                  {a.value}
                </Field>
              ))}
            </dl>
          </div>
        </>
      )}
    </dialog>
  )
}
