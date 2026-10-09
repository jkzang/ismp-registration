const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createMessages, failure, parseAccounts, phoneNumber, SEND_SCRIPT } = require('../src/imessage')

const CHECK_OUTPUT = 'messages\naccount\tiMessage\ttrue\tconnected\tABC\tme@example.com\naccount\tSMS\ttrue\tconnected\tDEF\tSMS\n'

function fakeMessages(respond = () => CHECK_OUTPUT) {
  const calls = []
  const run = async (script, args) => {
    calls.push({ script, args })
    return respond(script, args)
  }
  return { calls, messages: createMessages({ run, platform: 'darwin', wait: async () => {} }) }
}

test('phone numbers keep a leading + and refuse emails and short numbers', () => {
  assert.equal(phoneNumber('(555) 123-4567'), '5551234567')
  assert.equal(phoneNumber('+1 555 123 4567'), '+15551234567')
  assert.equal(phoneNumber('me@example.com'), null)
  assert.equal(phoneNumber('123-4567'), null)
  assert.equal(phoneNumber('555 123 4567 ext 2'), null)
  assert.equal(phoneNumber(undefined), null)
})

test('reads the accounts and finds the SMS one', async () => {
  const { messages } = fakeMessages()
  const { accounts, sms } = await messages.check()
  assert.equal(accounts.length, 2)
  assert.deepEqual(sms, { service: 'SMS', enabled: true, status: 'connected', id: 'DEF', description: 'SMS' })
})

test('no SMS account when texts are not forwarded', () => {
  const accounts = parseAccounts('messages\naccount\tiMessage\ttrue\tconnected\tABC\tme@example.com\n')
  assert.equal(accounts.find((a) => /sms/i.test(a.service)), undefined)
})

test('sends the number and message as arguments, never in the script', async () => {
  const { calls, messages } = fakeMessages(() => 'sent')
  const body = 'Hi "Sam" & co -- end tell'
  await messages.send('+1 (555) 123-4567', body)
  assert.equal(calls[0].script, SEND_SCRIPT)
  assert.deepEqual(calls[0].args, ['+15551234567', body])
  assert.ok(!SEND_SCRIPT.includes(body))
})

test('refuses emails, bad numbers and empty messages without running anything', async () => {
  const { calls, messages } = fakeMessages()
  await assert.rejects(messages.send('me@example.com', 'hi'), { reason: 'bad-number' })
  await assert.rejects(messages.send('5551234567', '  '), { reason: 'bad-message' })
  await assert.rejects(messages.send('5551234567', 'x'.repeat(2000)), { reason: 'bad-message' })
  assert.equal(calls.length, 0)
})

test('only on a Mac', async () => {
  const messages = createMessages({ run: async () => '', platform: 'linux' })
  await assert.rejects(messages.check(), { reason: 'unsupported' })
})

test('sends one at a time', async () => {
  let running = 0
  let most = 0
  const messages = createMessages({
    platform: 'darwin',
    wait: async () => {},
    run: async () => {
      running++
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return 'sent'
    },
  })
  await Promise.all([messages.send('5551234567', 'a'), messages.send('5551234568', 'b'), messages.send('5551234569', 'c')])
  assert.equal(most, 1)
})

test('explains the failures a volunteer can fix', () => {
  assert.equal(failure('execution error: Not authorized to send Apple events to Messages. (-1743)').reason, 'not-authorized')
  assert.equal(failure('execution error: Messages has no SMS account: Text Message Forwarding is off. (9001)').reason, 'no-sms')
  assert.equal(failure('execution error: Something else. (-1728)').reason, 'failed')
})
