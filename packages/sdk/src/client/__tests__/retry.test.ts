import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { X402Client } from '../x402Client.js'
import type { KikisAppManifest } from '../../types.js'
import {
  KikisAppFacilitatorError,
  parseRetryAfterMs,
  httpStatusToError,
} from '../../errors.js'
import { withRetry } from '../../internal/retry.js'

const keypair = Keypair.random()
const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Retry Test Service',
  description: 'Test retry and Retry-After delay',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: keypair.publicKey(),
  pricing: {
    x402: {
      amount: '0.01',
      per: 'request',
      facilitator: 'https://facilitator.test',
    },
  },
  endpoints: {},
  tags: ['test'],
}

const baseRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: manifest.asset_contract,
  amount: '10000',
  payTo: keypair.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

function paymentRequiredResponse(): Response {
  return new Response('payment required', {
    status: 402,
    headers: {
      'X-Payment-Requirements': encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: 'https://api.test/paid' },
        accepts: [baseRequirements],
      }),
    },
  })
}

function makePayload(): PaymentPayload {
  return {
    x402Version: 2,
    accepted: baseRequirements,
    payload: { nonce: 'nonce-retry-123' },
  }
}

test('parseRetryAfterMs — parses integer seconds and HTTP dates correctly', () => {
  const respSeconds = new Response(null, { headers: { 'Retry-After': '2' } })
  assert.equal(parseRetryAfterMs(respSeconds), 2000)

  const respZero = new Response(null, { headers: { 'Retry-After': '0' } })
  assert.equal(parseRetryAfterMs(respZero), 0)

  const respInvalid = new Response(null, { headers: { 'Retry-After': 'not-a-number' } })
  assert.equal(parseRetryAfterMs(respInvalid), undefined)

  const respNone = new Response(null)
  assert.equal(parseRetryAfterMs(respNone), undefined)
})

test('withRetry — HTTP 429 with Retry-After: 2 delays retry attempt by at least 2000ms', async () => {
  const response429 = new Response('Too Many Requests', {
    status: 429,
    headers: { 'Retry-After': '2' },
  })
  const error = httpStatusToError('Too Many Requests', 429, response429)
  assert.ok(error instanceof KikisAppFacilitatorError)
  assert.equal(error.retryAfterMs, 2000)

  let attempts = 0
  const observedDelays: number[] = []

  const result = await withRetry(
    async () => {
      attempts++
      if (attempts === 1) {
        throw error
      }
      return 'success'
    },
    {
      maxAttempts: 3,
      onRetry: (_attempt, _err, nextDelayMs) => {
        observedDelays.push(nextDelayMs)
      },
    },
  )

  assert.equal(result, 'success')
  assert.equal(attempts, 2)
  assert.equal(observedDelays.length, 1)
  assert.ok(observedDelays[0]! >= 2000, `Expected delay >= 2000ms, got ${observedDelays[0]}`)
})

test('X402Client — HTTP 429 with Retry-After: 2 delays retry and does NOT regenerate signed payment header', async (t) => {
  let signCount = 0
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => {
    signCount++
    return makePayload()
  })

  let requestCount = 0
  const seenSignatures: string[] = []
  const retryDelays: number[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    requestCount++
    const headers = (init?.headers ?? {}) as Record<string, string>
    const sig = headers['PAYMENT-SIGNATURE']

    if (sig) {
      seenSignatures.push(sig)
      if (seenSignatures.length === 1) {
        // First payment attempt returns HTTP 429 with Retry-After: 2
        return new Response('Rate limited', {
          status: 429,
          headers: {
            'Retry-After': '2',
            'Content-Type': 'text/plain',
          },
        })
      }
      // Second payment attempt succeeds
      const receipt = {
        transaction: '0x123abc',
        nonce: 'nonce-retry-123',
        timestamp: Date.now(),
      }
      return new Response(JSON.stringify({ ok: true, data: 'paid-content' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Response': Buffer.from(JSON.stringify(receipt)).toString('base64'),
        },
      })
    }

    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const client = new X402Client(keypair.secret(), 'testnet', {
      maxAttempts: 3,
      onRetry: (_attempt, _err, nextDelayMs) => {
        retryDelays.push(nextDelayMs)
      },
    })

    const res = await client.pay('https://api.test/paid', manifest)
    assert.deepEqual(res.data, { ok: true, data: 'paid-content' })
    assert.equal(res.txHash, '0x123abc')

    // Payment payload was signed exactly once
    assert.equal(signCount, 1, 'Payment headers should be signed exactly once')

    // Exactly 2 settlement attempts were made with the same signature header
    assert.equal(seenSignatures.length, 2, 'Should make 2 paid attempts')
    assert.equal(seenSignatures[0], seenSignatures[1], 'Signed payment header must not be regenerated during retries')

    // Delay was at least 2000ms
    assert.ok(retryDelays.length >= 1, 'onRetry hook should have recorded retry delay')
    assert.ok(retryDelays[0]! >= 2000, `Retry delay should be at least 2000ms, got ${retryDelays[0]}`)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client — transient facilitator 502/503 error reuses exact signed payment header', async (t) => {
  let signCount = 0
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => {
    signCount++
    return makePayload()
  })

  const seenSignatures: string[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const sig = headers['PAYMENT-SIGNATURE']

    if (sig) {
      seenSignatures.push(sig)
      if (seenSignatures.length === 1) {
        return new Response('Bad Gateway', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
      const receipt = {
        transaction: '0xsettled502',
        nonce: 'nonce-retry-123',
        timestamp: Date.now(),
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Response': Buffer.from(JSON.stringify(receipt)).toString('base64'),
        },
      })
    }

    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const client = new X402Client(keypair.secret(), 'testnet', {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    })

    const res = await client.pay('https://api.test/paid', manifest)
    assert.deepEqual(res.data, { success: true })
    assert.equal(res.txHash, '0xsettled502')
    assert.equal(signCount, 1)
    assert.equal(seenSignatures.length, 2)
    assert.equal(seenSignatures[0], seenSignatures[1])
  } finally {
    globalThis.fetch = originalFetch
  }
})
