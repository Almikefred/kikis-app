import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolvePaymentMode } from '../detectPaymentMode.js'
import type { PaymentMode } from '../../../types.js'

/** Builds a HeaderReader over a plain record (case-insensitive). */
function headers(record: Record<string, string>): (name: string) => string | undefined {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(record)) lower[k.toLowerCase()] = v
  return (name) => lower[name.toLowerCase()]
}

/** mppx wire-format Payment credential: `Payment <base64url JSON>`. */
function paymentCredential(credential: object): string {
  return `Payment ${Buffer.from(JSON.stringify(credential)).toString('base64url')}`
}

const ALL: ReadonlySet<PaymentMode> = new Set<PaymentMode>([
  'x402',
  'mpp-charge',
  'mpp-session',
  'mpp-session-ws',
])
const DUAL: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['mpp-session', 'mpp-charge'])
const CHARGE_ONLY: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['mpp-charge'])
const SESSION_ONLY: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['mpp-session'])

describe('resolvePaymentMode — explicit override', () => {
  it('honors x-preferred-mode when the provider offers it', () => {
    assert.equal(
      resolvePaymentMode(headers({ 'x-preferred-mode': 'mpp-charge' }), ALL),
      'mpp-charge',
    )
    assert.equal(resolvePaymentMode(headers({ 'x-preferred-mode': 'x402' }), ALL), 'x402')
  })

  it('ignores x-preferred-mode for modes the provider does not offer', () => {
    assert.equal(
      resolvePaymentMode(headers({ 'x-preferred-mode': 'mpp-charge' }), SESSION_ONLY),
      'mpp-session', // default challenge
    )
    assert.equal(
      resolvePaymentMode(headers({ 'x-preferred-mode': 'bogus' }), ALL),
      'mpp-session', // unknown value — default challenge
    )
  })
})

describe('resolvePaymentMode — x402 headers', () => {
  it('routes payment-signature / x-payment to x402', () => {
    assert.equal(resolvePaymentMode(headers({ 'payment-signature': 'SIG' }), ALL), 'x402')
    assert.equal(resolvePaymentMode(headers({ 'x-payment': 'PAY' }), ALL), 'x402')
  })

  it('falls back to the default when x402 is not offered', () => {
    assert.equal(
      resolvePaymentMode(headers({ 'payment-signature': 'SIG' }), DUAL),
      'mpp-session',
    )
  })
})

describe('resolvePaymentMode — mpp Payment credentials', () => {
  it('routes an mppx charge credential (challenge.intent=charge) to mpp-charge (#43)', () => {
    const auth = paymentCredential({
      challenge: { id: 'c', realm: 'r', method: 'stellar', intent: 'charge', request: {} },
      payload: { type: 'hash', hash: 'ab' },
    })
    assert.equal(resolvePaymentMode(headers({ authorization: auth }), ALL), 'mpp-charge')
  })

  it('routes an mppx channel credential (challenge.intent=channel) to the session handler', () => {
    const auth = paymentCredential({
      challenge: { id: 'c', realm: 'r', method: 'stellar', intent: 'channel', request: {} },
      payload: { action: 'voucher', amount: '1', signature: 'ab' },
    })
    assert.equal(resolvePaymentMode(headers({ authorization: auth }), ALL), 'mpp-session')
  })

  it('routes a legacy payload {action} credential to the session handler', () => {
    for (const action of ['open', 'voucher', 'close']) {
      const auth = paymentCredential({ payload: { action } })
      assert.equal(resolvePaymentMode(headers({ authorization: auth }), ALL), 'mpp-session')
    }
  })

  it('routes a legacy payload {type} credential to mpp-charge', () => {
    for (const type of ['hash', 'transaction']) {
      const auth = paymentCredential({ payload: { type } })
      assert.equal(resolvePaymentMode(headers({ authorization: auth }), ALL), 'mpp-charge')
    }
  })

  it('routes the legacy comma-separated credential= format', () => {
    const chargeCred = Buffer.from(JSON.stringify({ sender: 'G...', payload: { type: 'hash' } })).toString('base64')
    assert.equal(
      resolvePaymentMode(
        headers({ authorization: `Payment credential="${chargeCred}",signature="00"` }),
        ALL,
      ),
      'mpp-charge',
    )
    const sessionCred = Buffer.from(JSON.stringify({ payload: { action: 'voucher' } })).toString('base64')
    assert.equal(
      resolvePaymentMode(headers({ authorization: `Payment credential=${sessionCred},signature=00` }), ALL),
      'mpp-session',
    )
  })

  it('falls back to the default for undecodable Payment blobs', () => {
    assert.equal(
      resolvePaymentMode(headers({ authorization: 'Payment test-credential' }), ALL),
      'mpp-session',
    )
  })

  it('falls back to the default when the credential names an unoffered mode', () => {
    const auth = paymentCredential({ payload: { type: 'hash' } })
    assert.equal(
      resolvePaymentMode(headers({ authorization: auth }), SESSION_ONLY),
      'mpp-session',
    )
  })

  it('prefers x402 headers over an mpp credential when both are present', () => {
    const auth = paymentCredential({ payload: { type: 'hash' } })
    assert.equal(
      resolvePaymentMode(headers({ authorization: auth, 'payment-signature': 'SIG' }), ALL),
      'x402',
    )
  })
})

describe('resolvePaymentMode — defaults', () => {
  it('prefers the session challenge, then charge, then x402', () => {
    assert.equal(resolvePaymentMode(headers({}), ALL), 'mpp-session')
    assert.equal(resolvePaymentMode(headers({}), DUAL), 'mpp-session')
    assert.equal(resolvePaymentMode(headers({}), CHARGE_ONLY), 'mpp-charge')
    const x402Only: ReadonlySet<PaymentMode> = new Set<PaymentMode>(['x402'])
    assert.equal(resolvePaymentMode(headers({}), x402Only), 'x402')
    assert.equal(resolvePaymentMode(headers({}), new Set<PaymentMode>()), undefined)
  })

  it('routes WebSocket upgrades to mpp-session-ws when offered', () => {
    assert.equal(
      resolvePaymentMode(headers({}), ALL, { isWebSocketUpgrade: true }),
      'mpp-session-ws',
    )
    // Session credentials on an upgrade also prefer ws when it is offered …
    const auth = paymentCredential({ payload: { action: 'voucher' } })
    assert.equal(
      resolvePaymentMode(headers({ authorization: auth }), ALL, { isWebSocketUpgrade: true }),
      'mpp-session-ws',
    )
    assert.equal(
      resolvePaymentMode(headers({ authorization: auth }), DUAL, { isWebSocketUpgrade: true }),
      'mpp-session', // … but fall back when only the SSE session handler exists
    )
  })
})
