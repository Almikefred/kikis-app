/**
 * Unit tests for custom HTTP methods, headers, and request bodies in client.pay() (#3).
 *
 * Verifies that:
 * - Default client.pay(url) issues HTTP GET without a body
 * - POST with JSON object transmits Content-Type: application/json and serialized body
 * - POST with string body delivers the string body intact
 * - Custom request headers are merged and preserved
 * - Method, headers, and body are preserved across the 402 challenge-response flow
 */

import assert from 'node:assert/strict'
import test, { describe, beforeEach, afterEach } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { KikisAppClient } from '../KikisAppClient.js'
import { X402Client } from '../x402Client.js'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import type { KikisAppManifest } from '../../types.js'
import { signManifest } from '../../manifest/sign.js'
import { prepareHttpRequestInit } from '../../internal/http.js'

const payeeKeypair = Keypair.random()
const clientKeypair = Keypair.random()

function createTestManifest(): KikisAppManifest {
  return {
    'kikis-app': '1.0',
    name: 'HTTP Methods Test Provider',
    description: 'Manifest used for client http method tests',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: payeeKeypair.publicKey(),
    pricing: {
      x402: {
        amount: '0.01',
        per: 'request',
        facilitator: 'https://facilitator.test',
      },
    },
    endpoints: {
      infer: {
        method: 'POST',
        path: '/infer',
      },
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

const signedManifest = signManifest(createTestManifest(), payeeKeypair.secret())

const baseRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: signedManifest.asset_contract,
  amount: '100000',
  payTo: payeeKeypair.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

function paymentRequiredHeader(accepts: PaymentRequirements[] = [baseRequirements]): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://api.test/infer' },
    accepts,
  })
}

describe('prepareHttpRequestInit', () => {
  test('defaults to GET with no body when no options provided', () => {
    const init = prepareHttpRequestInit()
    assert.equal(init.method, 'GET')
    assert.equal(init.body, undefined)
    assert.deepEqual(init.headers, {})
  })

  test('formats POST with JSON object body and sets Content-Type: application/json', () => {
    const init = prepareHttpRequestInit({
      method: 'POST',
      body: { prompt: 'hello' },
    })
    assert.equal(init.method, 'POST')
    assert.equal(init.body, JSON.stringify({ prompt: 'hello' }))
    assert.equal(init.headers['Content-Type'], 'application/json')
  })

  test('formats POST with string body and preserves user headers', () => {
    const init = prepareHttpRequestInit({
      method: 'POST',
      headers: { 'X-Custom': 'val', 'content-type': 'text/plain' },
      body: 'raw prompt string',
    })
    assert.equal(init.method, 'POST')
    assert.equal(init.body, 'raw prompt string')
    assert.equal(init.headers['X-Custom'], 'val')
    assert.equal(init.headers['content-type'], 'text/plain')
  })

  test('merges extra headers with user headers', () => {
    const init = prepareHttpRequestInit(
      { headers: { 'X-User': '123' } },
      { 'X-Preferred-Mode': 'x402' },
    )
    assert.equal(init.headers['X-User'], '123')
    assert.equal(init.headers['X-Preferred-Mode'], 'x402')
  })
})

describe('client.pay() HTTP methods, headers, and request bodies', () => {
  const originalFetch = globalThis.fetch
  let capturedRequests: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: unknown }> = []
  let originalCreatePaymentPayload: any

  beforeEach(() => {
    capturedRequests = []
    originalCreatePaymentPayload = x402HTTPClient.prototype.createPaymentPayload
    x402HTTPClient.prototype.createPaymentPayload = (async () => ({
      x402Version: 2,
      accepted: baseRequirements,
      payload: {},
    })) as any
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    x402HTTPClient.prototype.createPaymentPayload = originalCreatePaymentPayload
  })

  test('existing client.pay(url) without request options issues HTTP GET by default', async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString()
      capturedRequests.push({
        url: urlStr,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body,
      })

      if (urlStr.includes('/.well-known/kikis-app.json')) {
        return new Response(JSON.stringify(signedManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Return 200 free response for the payment probe
      return new Response(JSON.stringify({ result: 'free data' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const client = new KikisAppClient({
      wallet: clientKeypair.secret(),
      network: 'testnet',
    })
    ;(client as any)._checkTrustline = async () => {}

    const result = await client.pay('https://api.test/price')
    assert.equal(result.mode, 'x402')
    assert.deepEqual(result.data, { result: 'free data' })

    const probeReq = capturedRequests.find((r) => r.url === 'https://api.test/price')
    assert.ok(probeReq, 'probe request should have been made')
    assert.equal(probeReq.method, 'GET')
    assert.equal(probeReq.body, undefined)
  })

  test('client.pay(url, { request: { method: "POST", body: { prompt: "hello" } } }) transmits POST with Content-Type: application/json and serialized body across 402 challenge flow', async () => {
    let probeReceivedBody: unknown
    let settlementReceivedBody: unknown
    let probeHeaders: Record<string, string> | undefined
    let settlementHeaders: Record<string, string> | undefined

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString()
      capturedRequests.push({
        url: urlStr,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body,
      })

      if (urlStr.includes('/.well-known/kikis-app.json')) {
        return new Response(JSON.stringify(signedManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      // Check if payment header is present
      const headers = (init?.headers ?? {}) as Record<string, string>
      const hasPaymentAuth = Object.keys(headers).some(
        (h) => h.toLowerCase() === 'authorization' || h.toLowerCase().includes('payment'),
      )

      if (!hasPaymentAuth) {
        // Phase 1: 402 challenge response
        probeReceivedBody = init?.body
        probeHeaders = init?.headers as Record<string, string>
        return new Response('payment required', {
          status: 402,
          headers: { 'X-Payment-Requirements': paymentRequiredHeader() },
        })
      }

      // Phase 4: settlement response
      settlementReceivedBody = init?.body
      settlementHeaders = init?.headers as Record<string, string>
      const receipt = { txHash: '0x1234567890abcdef' }
      return new Response(JSON.stringify({ completion: 'response to hello' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Response': encodePaymentResponseHeader(receipt),
        },
      })
    }) as typeof fetch

    const client = new KikisAppClient({
      wallet: clientKeypair.secret(),
      network: 'testnet',
    })
    ;(client as any)._checkTrustline = async () => {}

    const result = await client.pay('https://api.test/infer', {
      request: {
        method: 'POST',
        headers: { 'X-Request-Id': 'req-abc-123' },
        body: { prompt: 'hello' },
      },
    })

    assert.equal(result.mode, 'x402')
    assert.deepEqual(result.data, { completion: 'response to hello' })

    // Verify probe request received method, headers, and body
    const expectedBody = JSON.stringify({ prompt: 'hello' })
    assert.equal(probeReceivedBody, expectedBody)
    assert.equal(probeHeaders?.['Content-Type'], 'application/json')
    assert.equal(probeHeaders?.['X-Request-Id'], 'req-abc-123')
    assert.equal(probeHeaders?.['X-Preferred-Mode'], 'x402')

    // Verify settlement request received intact body, method, and user headers
    assert.equal(settlementReceivedBody, expectedBody)
    assert.equal(settlementHeaders?.['Content-Type'], 'application/json')
    assert.equal(settlementHeaders?.['X-Request-Id'], 'req-abc-123')
  })

  test('client.pay(url, { request: { method: "POST", body: "raw text string" } }) delivers string body intact', async () => {
    let settlementReceivedBody: unknown
    let settlementReceivedMethod: string | undefined

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString()
      if (urlStr.includes('/.well-known/kikis-app.json')) {
        return new Response(JSON.stringify(signedManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const headers = (init?.headers ?? {}) as Record<string, string>
      const hasPaymentAuth = Object.keys(headers).some(
        (h) => h.toLowerCase() === 'authorization' || h.toLowerCase().includes('payment'),
      )

      if (!hasPaymentAuth) {
        return new Response('payment required', {
          status: 402,
          headers: { 'X-Payment-Requirements': paymentRequiredHeader() },
        })
      }

      settlementReceivedBody = init?.body
      settlementReceivedMethod = init?.method
      const receipt = { txHash: '0xabcdef1234567890' }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Response': encodePaymentResponseHeader(receipt),
        },
      })
    }) as typeof fetch

    const client = new KikisAppClient({
      wallet: clientKeypair.secret(),
      network: 'testnet',
    })
    ;(client as any)._checkTrustline = async () => {}

    const result = await client.pay('https://api.test/infer', {
      request: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'raw text string',
      },
    })

    assert.equal(result.mode, 'x402')
    assert.equal(settlementReceivedMethod, 'POST')
    assert.equal(settlementReceivedBody, 'raw text string')
  })

  test('supports passing request as third parameter to client.pay()', async () => {
    let settlementReceivedBody: unknown

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = input.toString()
      if (urlStr.includes('/.well-known/kikis-app.json')) {
        return new Response(JSON.stringify(signedManifest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const headers = (init?.headers ?? {}) as Record<string, string>
      const hasPaymentAuth = Object.keys(headers).some(
        (h) => h.toLowerCase() === 'authorization' || h.toLowerCase().includes('payment'),
      )

      if (!hasPaymentAuth) {
        return new Response('payment required', {
          status: 402,
          headers: { 'X-Payment-Requirements': paymentRequiredHeader() },
        })
      }

      settlementReceivedBody = init?.body
      const receipt = { txHash: '0x9999999999999999' }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Response': encodePaymentResponseHeader(receipt),
        },
      })
    }) as typeof fetch

    const client = new KikisAppClient({
      wallet: clientKeypair.secret(),
      network: 'testnet',
    })
    ;(client as any)._checkTrustline = async () => {}

    const result = await client.pay('https://api.test/infer', undefined, {
      method: 'POST',
      body: { prompt: 'third-arg-test' },
    })

    assert.equal(result.mode, 'x402')
    assert.equal(settlementReceivedBody, JSON.stringify({ prompt: 'third-arg-test' }))
  })
})
