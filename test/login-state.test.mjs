/**
 * The QR sign-in state machine against the live CNB web origin.
 *
 * This never completes a login (no phone), so it asserts the parts that must
 * work before a human scans: a ticket is issued, the ticket URL is a CNB page,
 * the poll answers in the documented shape, an unknown state is refused, and
 * every response's Set-Cookie is merged into the attempt's jar — the cookie the
 * confirmation later sets is what the token mint authenticates with.
 */
import assert from 'node:assert/strict'
import { LoginAttempt } from '../lib/cnb-client.js'

const attempt = new LoginAttempt({ web: 'https://cnb.cool' })
const view = await attempt.start()

assert.match(view.ticketUrl, /^https:\/\/cnb\.cool\/login\/wx\/jump\?ticket=/)
assert.equal(view.state, attempt.state)
assert.match(attempt.uuid, /^[0-9a-f-]{36}$/)
assert.ok(attempt.jar.size >= 1, 'starting an attempt must hold a cookie session')

// The ticket page is a real CNB page, not an error.
const page = await fetch(view.ticketUrl, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' } })
assert.equal(page.ok, true, `ticket page answered ${page.status}`)
const html = await page.text()
// The 404 shell is titled "Page not found · CNB"; the ticket page is not.
const title = /<title[^>]*>([^<]*)<\/title>/.exec(html)?.[1]?.trim() ?? ''
assert.ok(title !== '' && !title.startsWith('Page not found'), `ticket page title was ${JSON.stringify(title)}`)

const first = await attempt.poll()
assert.equal(typeof first.confirmed, 'boolean')
assert.equal(typeof first.expired, 'boolean')
assert.equal(typeof first.nickName, 'string')

// A poll without the right uuid must be refused, not answered as pending.
const forged = new LoginAttempt({ web: 'https://cnb.cool' })
forged.state = attempt.state
forged.uuid = '00000000-0000-0000-0000-000000000000'
await assert.rejects(() => forged.poll(), /state is invalid/)

// And an unanswered attempt expires only by CNB's own verdict, never locally.
assert.equal(attempt.lastStatus.confirmed, false)
assert.ok(attempt.jar.has('csrftoken'), 'the csrftoken the token mint needs must be in the jar')

console.log('login state machine OK · ticket issued, poll shape correct, forged uuid refused')
