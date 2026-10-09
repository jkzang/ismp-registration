import { useEffect, useRef, useState } from 'react'
import { formatPhone, phoneKey, recipientsFor, textablePhone, unknownPlaceholders, type Recipient, type SentLog } from '../bulkText'
import { desktop, type MessagesAccount } from '../desktop'
import { fillMessage, MESSAGE_LABELS, type Contact } from '../signupTracker'
import { CONTACT_STATUSES, type ContactStatus } from '../types'
import { Segmented } from './Segmented'
import { CheckIcon, WarningIcon } from './icons'

// The time between texts, so Messages, the iPhone and the carrier keep up and it doesn't look like spam.
const GAP_MS = 3000
const FROM_KEY = 'bulk-text-from'
const VERIFIED_KEY = 'bulk-text-verified'
const sentKey = (sheetId: number) => `bulk-texts-${sheetId}`

function load(key: string) {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function store(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // Only a convenience.
  }
}

function loadSent(sheetId: number): SentLog {
  try {
    return JSON.parse(localStorage.getItem(sentKey(sheetId)) ?? '{}') as SentLog
  } catch {
    return {}
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; ok: true; accounts: MessagesAccount[]; sms: MessagesAccount | null }
  | { state: 'done'; ok: false; error: string; reason?: string }

type Test = { state: 'idle' } | { state: 'sending' } | { state: 'sent'; to: string } | { state: 'failed'; error: string } | { state: 'wrong' }

type Item = { contact: Contact; phone: string; body: string; state: 'waiting' | 'sending' | 'sent' | 'failed' | 'skipped'; error?: string }

/** Whether Messages can text from this Mac, in the words the setup list shows. */
function readiness(check: Check) {
  if (check.state !== 'done') return null
  if (!check.ok) {
    return check.reason === 'not-authorized'
      ? { control: check.error, forwarding: null, connected: null }
      : { control: null, forwarding: check.error, connected: null }
  }
  const { sms } = check
  return {
    control: null,
    forwarding: !sms
      ? 'Messages on this Mac has no SMS account, so it can’t send texts. On the iPhone with your number: Settings → Apps → Messages → Text Message Forwarding → turn on this Mac. Messages on the Mac has to be signed in to the same Apple Account.'
      : !sms.enabled
        ? 'Texting is turned off in Messages on this Mac. Turn it on in Messages → Settings.'
        : null,
    // Not a blocker: Messages can still queue the texts.
    connected: sms && sms.enabled && !/^connected$/i.test(sms.status) ? `Messages says texting is “${sms.status || 'unknown'}”. Keep the iPhone on, nearby and on the same Wi-Fi.` : null,
  }
}

/**
 * Texts everyone in a group at once through Messages on this Mac (the Mac app only): pick who by
 * contact status or the Sign-ups list's filters, untick anyone, then confirm. Texts always go out as
 * SMS through the iPhone forwarding its texts, so they come from its number, which is set here and
 * checked with a test text first. See bulkText.ts for who's never texted.
 */
export function BulkText({ sheetId, contacts, shown, filtered, mentorNames, templates, event, onSent, onBusyChange }: {
  sheetId: number
  /** Everyone, with statuses still being saved applied. */
  contacts: Contact[]
  /** Who the Sign-ups list shows now. */
  shown: Contact[]
  filtered: boolean
  mentorNames: string[]
  templates: readonly string[]
  event: string
  /** After each text goes out (moves them to Awaiting response). */
  onSent: (contact: Contact) => void
  onBusyChange: (busy: boolean) => void
}) {
  const [source, setSource] = useState<'status' | 'list'>('status')
  const [statuses, setStatuses] = useState<ContactStatus[]>(['not_contacted'])
  const [message, setMessage] = useState(0)
  // Changes from each person's default, by contact key.
  const [unticked, setUnticked] = useState<Set<string>>(new Set())
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [from, setFrom] = useState(() => load(FROM_KEY))
  const [verified, setVerified] = useState(() => load(VERIFIED_KEY))
  const [check, setCheck] = useState<Check>({ state: 'idle' })
  const [testTo, setTestTo] = useState('')
  const [test, setTest] = useState<Test>({ state: 'idle' })
  const [sent, setSent] = useState<SentLog>(() => loadSent(sheetId))
  const [confirming, setConfirming] = useState(false)
  const [run, setRun] = useState<Item[] | null>(null)
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent

  useEffect(() => setSent(loadSent(sheetId)), [sheetId])
  useEffect(() => onBusyChange(running), [running, onBusyChange])

  const fromNumber = textablePhone(from)
  const fromProblem = !from.trim()
    ? 'Set the number texts go out from.'
    : from.includes('@')
      ? 'Texts can only go out from a phone number, not an email.'
      : !fromNumber
        ? 'That isn’t a full phone number.'
        : null
  const isVerified = !!fromNumber && verified === phoneKey(fromNumber)
  const ready = readiness(check)
  const messagesReady = check.state === 'done' && check.ok && !!ready && !ready.control && !ready.forwarding

  const pool = source === 'list' ? shown : contacts.filter((c) => statuses.includes(c.status))
  const recipients = recipientsFor(pool, { mentorNames, fromNumber, sent, message })
  const isTicked = (r: Recipient) => !r.blocked && (r.byDefault ? !unticked.has(r.contact.key) : ticked.has(r.contact.key))
  const allowed = recipients.filter((r) => !r.blocked)
  const left = recipients.filter((r) => r.blocked)
  const chosen = allowed.filter(isTicked)
  const template = templates[message] ?? ''
  const unknown = unknownPlaceholders(template)
  const statusCounts = new Map<ContactStatus, number>()
  for (const c of contacts) statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1)

  function toggle(r: Recipient, on: boolean) {
    const key = r.contact.key
    const edit = (set: Set<string>, add: boolean) => {
      const next = new Set(set)
      if (add) next.add(key)
      else next.delete(key)
      return next
    }
    if (r.byDefault) setUnticked((s) => edit(s, !on))
    else setTicked((s) => edit(s, on))
  }

  function tickAll(on: boolean) {
    for (const r of allowed) toggle(r, on)
  }

  function changeFrom(value: string) {
    setFrom(value)
    store(FROM_KEY, value.trim())
    setTest({ state: 'idle' })
  }

  async function runCheck() {
    if (!desktop?.checkTexting) return false
    setCheck({ state: 'checking' })
    const result = await desktop.checkTexting()
    const next: Check = result.ok
      ? { state: 'done', ok: true, accounts: result.accounts, sms: result.sms }
      : { state: 'done', ok: false, error: result.error, reason: result.reason }
    setCheck(next)
    const r = readiness(next)
    return next.state === 'done' && next.ok && !!r && !r.control && !r.forwarding
  }

  async function sendTest() {
    const to = textablePhone(testTo || from)
    if (!desktop?.sendText || !to || !fromNumber) return
    setTest({ state: 'sending' })
    const result = await desktop.sendText(
      to,
      `Test from ISMP Registration: if this came from ${formatPhone(fromNumber)}, bulk texting is set up on this Mac.`,
    )
    setTest(result.ok ? { state: 'sent', to } : { state: 'failed', error: result.error })
  }

  function confirmTest(rightNumber: boolean) {
    if (rightNumber && fromNumber) {
      setVerified(phoneKey(fromNumber))
      store(VERIFIED_KEY, phoneKey(fromNumber))
      setTest({ state: 'idle' })
    } else {
      setVerified('')
      store(VERIFIED_KEY, '')
      setTest({ state: 'wrong' })
    }
  }

  async function review() {
    // Messages could have changed since the last check (the iPhone left, forwarding turned off).
    if (await runCheck()) setConfirming(true)
  }

  async function sendAll() {
    if (!desktop?.sendText) return
    setConfirming(false)
    // Who and what, fixed now: a re-read of the sheet mid-way changes nothing.
    const items: Item[] = chosen.map((r) => ({ contact: r.contact, phone: r.phone, body: fillMessage(template, r.contact, event), state: 'waiting' }))
    stop.current = false
    setRun(items)
    setRunning(true)
    const update = (i: number, change: Partial<Item>) => setRun((list) => list && list.map((item, j) => (j === i ? { ...item, ...change } : item)))
    let log = loadSent(sheetId)
    for (let i = 0; i < items.length; i++) {
      if (stop.current) {
        for (let j = i; j < items.length; j++) update(j, { state: 'skipped' })
        break
      }
      update(i, { state: 'sending' })
      const result = await desktop.sendText(items[i].phone, items[i].body)
      if (result.ok) {
        update(i, { state: 'sent' })
        log = { ...log, [items[i].contact.key]: { ...log[items[i].contact.key], [String(message)]: new Date().toISOString() } }
        store(sentKey(sheetId), JSON.stringify(log))
        setSent(log)
        onSentRef.current(items[i].contact)
      } else {
        update(i, { state: 'failed', error: result.error })
        // Nothing else will go through either.
        if (result.reason === 'not-authorized' || result.reason === 'no-sms' || result.reason === 'unsupported') stop.current = true
      }
      if (i < items.length - 1 && !stop.current) await sleep(GAP_MS)
    }
    setRunning(false)
    setUnticked(new Set())
    setTicked(new Set())
  }

  if (!desktop?.sendText || !desktop.checkTexting) return null

  if (run) {
    const done = run.filter((i) => i.state === 'sent').length
    const failed = run.filter((i) => i.state === 'failed').length
    const skipped = run.filter((i) => i.state === 'skipped').length
    return (
      <div className="bulk-text">
        <div className="bulk-progress" role="status">
          <strong>
            {running ? `Texting… ${done} of ${run.length} sent` : `Sent ${done} of ${run.length}`}
          </strong>
          <span className="muted">
            {failed > 0 && `${failed} failed. `}
            {skipped > 0 && `${skipped} not sent (stopped). `}
            From {formatPhone(fromNumber)}. Messages shows a red “Not Delivered” on any that don’t arrive.
          </span>
          <progress max={run.length} value={done + failed + skipped} />
        </div>
        <ul className="bulk-list">
          {run.map((item) => (
            <li key={item.contact.key} className={`bulk-row is-${item.state}`}>
              <span className="bulk-name">{item.contact.name}</span>
              <span className="bulk-phone">{formatPhone(item.phone)}</span>
              <span className="bulk-state">
                {item.state === 'sent' ? <><CheckIcon /> Sent</> : item.state === 'sending' ? 'Sending…' : item.state === 'failed' ? 'Failed' : item.state === 'skipped' ? 'Not sent' : 'Waiting'}
              </span>
              {item.error && <span className="bulk-flag is-blocked">{item.error}</span>}
            </li>
          ))}
        </ul>
        <div className="bulk-actions">
          {running ? (
            <button type="button" className="danger" onClick={() => (stop.current = true)}>
              Stop after this one
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => setRun(null)}>
              Done
            </button>
          )}
        </div>
      </div>
    )
  }

  const blockers = [
    fromProblem,
    !fromProblem && !isVerified && 'Send a test text to confirm the number it comes from.',
    check.state !== 'done' && 'Check Messages on this Mac.',
    check.state === 'done' && !messagesReady && 'Messages on this Mac isn’t ready to send texts.',
    !template.trim() && 'The message is empty.',
    unknown.length > 0 && `The message has ${unknown.join(', ')}, which nothing fills in.`,
    chosen.length === 0 && 'No one is ticked.',
  ].filter((b): b is string => !!b)
  const setupDone = !fromProblem && isVerified && messagesReady
  const sample = chosen[0] ?? allowed[0]

  return (
    <div className="bulk-text">
      <details className="bulk-setup" open={!setupDone}>
        <summary>
          <span className={`bulk-check ${setupDone ? 'is-ok' : 'is-todo'}`}>{setupDone ? <CheckIcon /> : <WarningIcon />}</span>
          {setupDone ? (
            <span>
              Sending from <strong>{formatPhone(fromNumber)}</strong> as SMS through your iPhone
            </span>
          ) : (
            <span>Set up texting from this Mac</span>
          )}
        </summary>
        <div className="bulk-setup-body">
          <label className="message-event">
            <span>Send from</span>
            <input type="tel" value={from} placeholder="(555) 123-4567" autoComplete="tel" onChange={(e) => changeFrom(e.target.value)} />
            {fromProblem && from.trim() && <span className="error">{fromProblem}</span>}
          </label>
          <p className="muted bulk-hint">
            Every text goes out as SMS through the iPhone that forwards its texts to this Mac, so it’s always from that phone’s
            number, never an email. Put that iPhone’s number here; a test text confirms it.
          </p>
          <ul className="bulk-checks">
            <li>
              <SetupMark ok={check.state === 'done' && !ready?.control} pending={check.state !== 'done'} />
              <span>
                This app may control Messages
                {ready?.control && <span className="error">{ready.control}</span>}
              </span>
            </li>
            <li>
              <SetupMark ok={messagesReady} pending={check.state !== 'done' || !!ready?.control} />
              <span>
                Text Message Forwarding is on
                {ready?.forwarding && <span className="error">{ready.forwarding}</span>}
                {ready?.connected && <span className="bulk-warn">{ready.connected}</span>}
              </span>
            </li>
            <li>
              <SetupMark ok={isVerified} pending={false} />
              <span>
                A test text came from {fromNumber ? formatPhone(fromNumber) : 'your number'}
                {test.state === 'wrong' && (
                  <span className="error">
                    Then Messages is forwarding from a different iPhone. On the iPhone with {formatPhone(fromNumber)}: Settings → Apps →
                    Messages → Text Message Forwarding → this Mac (and turn it off on any other iPhone), then test again.
                  </span>
                )}
              </span>
            </li>
          </ul>
          <div className="bulk-setup-actions">
            <button type="button" onClick={runCheck} disabled={check.state === 'checking'}>
              {check.state === 'checking' ? 'Checking…' : check.state === 'done' ? 'Check again' : 'Check Messages'}
            </button>
          </div>
          {messagesReady && fromNumber && (
            <div className="bulk-test">
              <label className="message-event">
                <span>Test text to</span>
                <input type="tel" value={testTo} placeholder={`${formatPhone(fromNumber)} (your own number works)`} onChange={(e) => setTestTo(e.target.value)} />
              </label>
              {test.state === 'sent' ? (
                <div className="bulk-test-ask">
                  <span>
                    Sent to {formatPhone(test.to)}. Did it arrive from <strong>{formatPhone(fromNumber)}</strong>?
                  </span>
                  <button type="button" className="primary" onClick={() => confirmTest(true)}>
                    Yes, from that number
                  </button>
                  <button type="button" onClick={() => confirmTest(false)}>
                    No
                  </button>
                </div>
              ) : (
                <button type="button" onClick={sendTest} disabled={test.state === 'sending' || !textablePhone(testTo || from)}>
                  {test.state === 'sending' ? 'Sending…' : 'Send test text'}
                </button>
              )}
              {test.state === 'failed' && <span className="error">{test.error}</span>}
            </div>
          )}
        </div>
      </details>

      <div className="bulk-who">
        <Segmented
          label="Who to text"
          value={source}
          options={[
            { value: 'status', label: 'By contact status' },
            { value: 'list', label: filtered ? `As the list is filtered (${shown.length})` : `Everyone in the list (${shown.length})` },
          ]}
          onChange={setSource}
        />
        {source === 'status' && (
          <div className="bulk-statuses" role="group" aria-label="Contact statuses">
            {CONTACT_STATUSES.map((s) => {
              const on = statuses.includes(s.value)
              return (
                <button
                  key={s.value}
                  type="button"
                  aria-pressed={on}
                  className={`bulk-status status-${s.value}${on ? ' is-on' : ''}`}
                  onClick={() => setStatuses((list) => (on ? list.filter((v) => v !== s.value) : [...list, s.value]))}
                >
                  {on && <CheckIcon />}
                  {s.label} <span className="bulk-count">{statusCounts.get(s.value) ?? 0}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="bulk-message">
        <Segmented label="Message" value={String(message)} options={MESSAGE_LABELS.map((label, i) => ({ value: String(i), label }))} onChange={(v) => setMessage(Number(v))} />
        <p className="bulk-preview">
          {sample ? fillMessage(template, sample.contact, event) : template || <span className="muted">No message</span>}
        </p>
        {sample && <span className="muted bulk-hint">As {sample.contact.name} gets it. Edit the messages under Templates.</span>}
      </div>

      <div className="bulk-recipients">
        <div className="bulk-recipients-head">
          <strong>
            {chosen.length} of {allowed.length} ticked
          </strong>
          <button type="button" className="link-button" onClick={() => tickAll(true)} disabled={allowed.length === 0}>
            Tick all
          </button>
          <button type="button" className="link-button" onClick={() => tickAll(false)} disabled={chosen.length === 0}>
            Untick all
          </button>
        </div>
        <ul className="bulk-list">
          {allowed.map((r) => (
            <li key={r.contact.key} className="bulk-row">
              <label>
                <input type="checkbox" checked={isTicked(r)} onChange={(e) => toggle(r, e.target.checked)} />
                <span className="bulk-name">
                  {r.contact.name}
                  {r.contact.nickname && <span className="checkin-nickname">“{r.contact.nickname}”</span>}
                </span>
                <span className="bulk-phone">{formatPhone(r.phone)}</span>
              </label>
              {r.flags.map((f) => (
                <span key={f.text} className={`bulk-flag is-${f.kind}`}>
                  {f.text}
                </span>
              ))}
            </li>
          ))}
          {allowed.length === 0 && <li className="checkin-empty">No one to text</li>}
        </ul>
        {left.length > 0 && (
          <details className="bulk-left">
            <summary>
              {left.length} left out, never texted
            </summary>
            <ul className="bulk-list">
              {left.map((r) => (
                <li key={r.contact.key} className="bulk-row is-blocked">
                  <span className="bulk-name">{r.contact.name}</span>
                  {r.flags.map((f) => (
                    <span key={f.text} className={`bulk-flag is-${f.kind}`}>
                      {f.text}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="bulk-actions">
        {blockers.length > 0 && <span className="muted">{blockers[0]}</span>}
        <button type="button" className="primary" disabled={blockers.length > 0 || check.state === 'checking'} onClick={review}>
          Review and send {chosen.length > 0 ? `${chosen.length} text${chosen.length === 1 ? '' : 's'}` : ''}…
        </button>
      </div>

      <SendConfirm
        open={confirming}
        from={formatPhone(fromNumber)}
        recipients={chosen}
        message={sample ? fillMessage(template, sample.contact, event) : template}
        sampleName={sample?.contact.name ?? ''}
        onConfirm={sendAll}
        onClose={() => setConfirming(false)}
      />
    </div>
  )
}

function SetupMark({ ok, pending }: { ok: boolean; pending: boolean }) {
  if (pending) return <span className="bulk-check is-pending" aria-label="Not checked yet" />
  return ok ? (
    <span className="bulk-check is-ok" aria-label="Done">
      <CheckIcon />
    </span>
  ) : (
    <span className="bulk-check is-todo" aria-label="Not done">
      <WarningIcon />
    </span>
  )
}

/** The last step: who, from which number and what, with a box to tick before Send works. */
function SendConfirm({ open, from, recipients, message, sampleName, onConfirm, onClose }: {
  open: boolean
  from: string
  recipients: Recipient[]
  message: string
  sampleName: string
  onConfirm: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [sure, setSure] = useState(false)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      setSure(false)
      dialog.showModal()
    } else if (!open && dialog.open) dialog.close()
  }, [open])

  const count = recipients.length
  const unsure = recipients.filter((r) => r.flags.length > 0)

  return (
    <dialog
      ref={ref}
      className="confirm-dialog bulk-confirm"
      aria-labelledby="bulk-confirm-title"
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && ref.current?.close()}
    >
      <div className="confirm-body">
        <h2 id="bulk-confirm-title">
          Text {count} {count === 1 ? 'person' : 'people'}?
        </h2>
        <dl className="bulk-summary">
          <dt>From</dt>
          <dd>
            <strong>{from}</strong> <span className="muted">as SMS through your iPhone</span>
          </dd>
          <dt>To</dt>
          <dd>
            <ul className="bulk-confirm-names">
              {recipients.map((r) => (
                <li key={r.contact.key}>
                  {r.contact.name} <span className="muted">{formatPhone(r.phone)}</span>
                </li>
              ))}
            </ul>
          </dd>
          <dt>Message</dt>
          <dd>
            <p className="bulk-preview">{message}</p>
            <span className="muted">As {sampleName} gets it; each person gets their own name.</span>
          </dd>
        </dl>
        {unsure.length > 0 && (
          <p className="bulk-warn">
            <WarningIcon /> You ticked {unsure.length} by hand that the app wasn’t sure about:{' '}
            {unsure.map((r) => `${r.contact.name} (${r.flags.map((f) => f.text.toLowerCase()).join('; ')})`).join(', ')}.
          </p>
        )}
        <label className="bulk-sure">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          <span>
            I’ve checked who’s getting this and the number it’s from. {count === 1 ? 'It goes' : 'They go'} out one by one as soon as I
            click Send, about {Math.max(1, Math.round((count * GAP_MS) / 60000))} min in all, and can’t be unsent.
          </span>
        </label>
      </div>
      <footer className="dialog-foot">
        <button type="button" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!sure} onClick={onConfirm}>
          Send {count} text{count === 1 ? '' : 's'} from {from}
        </button>
      </footer>
    </dialog>
  )
}
