/**
 * Texts through the Mac's Messages app, with AppleScript (osascript), for the web app's bulk texting
 * (frontend/src/components/BulkText.tsx).
 *
 * Every text goes out through Messages' SMS account, which only exists while an iPhone forwards its
 * texts to this Mac (iPhone: Settings → Apps → Messages → Text Message Forwarding). That pins the
 * sender to the iPhone's own number: never an Apple Account email, as iMessage could be. Recipients
 * must be phone numbers for the same reason.
 *
 * The scripts are fixed; the number and message reach them as arguments (`on run argv`), never as
 * script text, so nothing in a message can change what runs.
 */
const { execFile } = require('node:child_process')

// Accounts, one per line: service type, enabled, connection status, id, description.
const CHECK_SCRIPT = `on run argv
	set tb to character id 9
	set lf to character id 10
	set out to "messages" & lf
	tell application "Messages"
		repeat with a in accounts
			set kind to ""
			set isOn to ""
			set conn to ""
			set acctId to ""
			set descr to ""
			try
				set kind to (service type of a) as text
			end try
			try
				set isOn to (enabled of a) as text
			end try
			try
				set conn to (connection status of a) as text
			end try
			try
				set acctId to (id of a) as text
			end try
			try
				set descr to (description of a) as text
			end try
			set out to out & "account" & tb & kind & tb & isOn & tb & conn & tb & acctId & tb & descr & lf
		end repeat
	end tell
	return out
end run`

const NO_SMS = 9001

const SEND_SCRIPT = `on run argv
	set targetNumber to item 1 of argv
	set messageText to item 2 of argv
	tell application "Messages"
		set smsAccount to missing value
		repeat with a in accounts
			try
				if (service type of a) is SMS and (enabled of a) is true then
					set smsAccount to contents of a
					exit repeat
				end if
			end try
		end repeat
		if smsAccount is missing value then error "Messages has no SMS account: Text Message Forwarding is off." number ${NO_SMS}
		send messageText to participant targetNumber of smsAccount
	end tell
	return "sent"
end run`

const MAX_LENGTH = 1600
// Messages gets a moment between texts however fast the page asks.
const MIN_GAP_MS = 1500

class TextingError extends Error {
  constructor(message, reason) {
    super(message)
    this.reason = reason
  }
}

/** Digits with a leading + kept, or null when it isn't a phone number (an email never is). */
function phoneNumber(text) {
  if (typeof text !== 'string' || /[^\d\s()+.-]/.test(text)) return null
  const digits = text.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  return text.trim().startsWith('+') ? `+${digits}` : digits
}

/** The check script's output, as accounts. */
function parseAccounts(output) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('account\t'))
    .map((line) => {
      const [, service = '', enabled = '', status = '', id = '', description = ''] = line.split('\t')
      return { service, enabled: enabled === 'true', status, id, description }
    })
}

const isSms = (account) => /\bsms\b/i.test(account.service)

/** Why osascript failed, in words a volunteer can act on. */
function failure(stderr) {
  const text = String(stderr || '').trim()
  if (/-1743\b/.test(text)) {
    return new TextingError(
      'This app isn’t allowed to control Messages. Turn it on in System Settings → Privacy & Security → Automation → ISMP Registration → Messages.',
      'not-authorized',
    )
  }
  if (new RegExp(`\\(${NO_SMS}\\)`).test(text)) {
    return new TextingError(
      'Messages on this Mac can’t send texts. On your iPhone, turn on Settings → Apps → Messages → Text Message Forwarding for this Mac.',
      'no-sms',
    )
  }
  if (/-600\b|isn.t running/.test(text)) return new TextingError('Messages didn’t open. Open it once by hand, then try again.', 'failed')
  return new TextingError(`Messages couldn’t send it: ${text.replace(/^.*execution error:\s*/, '') || 'unknown error'}`, 'failed')
}

function runOsascript(script, args) {
  return new Promise((resolve, reject) => {
    // The script comes first, so osascript reads every argument after it as the script's (the number
    // goes first and never starts with "-").
    execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(failure(stderr || err.message))
      else resolve(stdout)
    })
  })
}

/**
 * `run(script, args)` runs AppleScript and resolves with what it returns (osascript; tests pass a
 * stand-in). `wait` is for the gap between texts.
 */
function createMessages({ run = runOsascript, platform = process.platform, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let queue = Promise.resolve()
  let lastSent = 0

  function onMac() {
    if (platform !== 'darwin') throw new TextingError('Texting through Messages only works on a Mac.', 'unsupported')
  }

  /** Whether Messages can text from this Mac: its accounts, and the SMS one if there is one. */
  async function check() {
    onMac()
    const accounts = parseAccounts(await run(CHECK_SCRIPT, []))
    const sms = accounts.find(isSms) ?? null
    return { accounts, sms }
  }

  /** Texts one phone number through the SMS account. One at a time, at least MIN_GAP_MS apart. */
  function send(to, body) {
    onMac()
    const number = phoneNumber(to)
    if (!number) return Promise.reject(new TextingError(`“${to}” isn’t a phone number.`, 'bad-number'))
    if (typeof body !== 'string' || !body.trim()) return Promise.reject(new TextingError('The message is empty.', 'bad-message'))
    if (body.length > MAX_LENGTH) return Promise.reject(new TextingError('The message is too long.', 'bad-message'))
    const sent = queue.then(async () => {
      const gap = lastSent + MIN_GAP_MS - Date.now()
      if (gap > 0) await wait(gap)
      try {
        await run(SEND_SCRIPT, [number, body])
      } finally {
        lastSent = Date.now()
      }
      return { to: number }
    })
    queue = sent.catch(() => {})
    return sent
  }

  return { check, send }
}

module.exports = { createMessages, parseAccounts, phoneNumber, failure, TextingError, CHECK_SCRIPT, SEND_SCRIPT }
