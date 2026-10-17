/**
 * Fastify mpp-session-ws: voucher verification, WebSocket upgrade flagging,
 * and channel close for the WebSocket transport variant (#29).
 *
 * This file mocks `@stellar/mpp/channel/server` (Store, close, stellar) and
 * `mppx/server` so the verified path can be exercised without a real Soroban
 * channel — it runs in its own process, so the real fastify.test.ts is
 * unaffected (same pattern as hono-mpp-session-ws.test.ts).
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { WebSocket } from 'ws'
import { Keypair } from '@stellar/stellar-sdk'
import type { KikisAppManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const providerPayerForClose = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

type WrappedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedStore: WrappedStore | null = null
let settleCalls: Array<{ txHash: string; mode: string }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) {
            return m.get(k)
          },
          async put(k: string, v: unknown) {
            m.set(k, v)
          },
          async delete(k: string) {
            m.delete(k)
          },
          update(k: string, fn: (v: unknown) => unknown) {
            m.set(k, fn(m.get(k)))
          },
        }
      },
    },
    // Channel close broadcast succeeds in these tests.
    close: async () => 'CLOSE_TX_HASH',
    // The Hono adapter calls stellar(...) directly; the Express-style session
    // handler calls stellar.channel(...). Support both and capture the wrapped
    // store so tests can feed vouchers in.
    stellar: Object.assign(
      (opts: { store: unknown }) => {
        capturedStore = opts.store as WrappedStore
        return []
      },
      {
        channel: (opts: { store: unknown }) => {
          capturedStore = opts.store as WrappedStore
          return {}
        },
      },
    ),
  },
})

mock.module('mppx/server', {
  namedExports: {
    // @stellar/mpp re-exports these from mppx/server; every name the real
    // module exports must be present here or the importing module fails to
    // link with "does not provide an export named ...", even though no test
    // in this file touches them.
    Expires: {},
    Store: {},
    // The Express-style session handler converts the Node request with
    // MppxRequest.fromNodeListener — mirror just enough of it.
    Request: {
      fromNodeListener: (req: {
        headers: Record<string, string | string[] | undefined>
        method?: string
        url?: string
      }) => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers.set(k, v)
          else if (Array.isArray(v) && v[0]) headers.set(k, v[0])
        }
        return new Request(`http://placeholder${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
        })
      },
    },
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        // Fake channel verification: no Payment credential → 402 challenge,
        // valid Payment credential → verified.
        channel: (_opts: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (!auth?.startsWith('Payment ')) {
            return {
              status: 402,
              challenge: new Response('Payment Required', {
                status: 402,
                headers: {
                  'www-authenticate':
                    'Payment id="test", realm="test", method="stellar", intent="channel", request="e30"',
                },
              }),
            }
          }
          return { status: 200 }
        },
      }),
    },
  },
})

const { kikisAppFastify, MPP_SESSION_WS_VERIFIED, mppSessionWsFastifyVerified } = await import(
  '../fastify.js'
)

const manifest: KikisAppManifest = {
  'kikis-app': '1.0',
  name: 'Test WS Service',
  description: 'Unit test provider',
  modes: ['mpp-session-ws'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session-ws': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: { method: 'GET', path: '/stream' } },
  tags: ['test'],
}

/** Verified-Payment credential header that passes the mocked mppx verify. */
const VERIFIED_CREDENTIAL = 'Payment eyJwYXlsb2FkIjp7ImFjdGlvbiI6InZvdWNoZXIifX0'

async function makeServer(): Promise<{
  wsUrl: string
  httpBase: string
  routeVerified: () => boolean | null
  close: () => Promise<void>
}> {
  const fastify = Fastify()
  await fastify.register(fastifyWebsocket)
  await fastify.register(
    kikisAppFastify({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session-ws'],
      pricing: { 'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      onSettled: async (txHash, _amount, mode) => {
        settleCalls.push({ txHash, mode })
      },
    }),
  )

  // Stand-in for the app's upgrade route: records whether the payment
  // middleware verified the handshake credential, then closes the socket.
  let seenVerified: boolean | null = null
  fastify.get('/stream', { websocket: true }, (socket: WebSocket, request) => {
    seenVerified = mppSessionWsFastifyVerified(request)
    socket.close()
  })
  // Plain HTTP probe route for non-upgrade flag semantics.
  fastify.get('/probe', async (request) => ({ verified: mppSessionWsFastifyVerified(request) }))

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = fastify.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    wsUrl: `ws://127.0.0.1:${port}/stream`,
    httpBase: `http://127.0.0.1:${port}`,
    routeVerified: () => seenVerified,
    close: () => fastify.close(),
  }
}

/** Attempt a WebSocket handshake; rejects with the HTTP error when refused. */
function connectWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

describe('kikisAppFastify — mpp-session-ws', () => {
  it('returns a 402 challenge for an unauthenticated request', async () => {
    const { httpBase, close } = await makeServer()
    try {
      const res = await fetch(`${httpBase}/stream`)
      assert.equal(res.status, 402)
      const auth = res.headers.get('www-authenticate')
      assert.ok(auth?.startsWith('Payment '), 'expected an mpp Payment challenge')
    } finally {
      await close()
    }
  })

  it('rejects an unauthenticated WebSocket handshake with 402 before the upgrade', async () => {
    const { wsUrl, routeVerified, close } = await makeServer()
    try {
      await assert.rejects(
        () => connectWs(wsUrl),
        /Unexpected server response: 402/,
        'the upgrade must be refused with 402 when no credential is presented',
      )
      assert.equal(routeVerified(), null, 'the websocket route must never run for an unpaid handshake')
    } finally {
      await close()
    }
  })

  it('marks the request verified and hands control to the upgrade route when the credential is valid', async () => {
    const { wsUrl, routeVerified, close } = await makeServer()
    try {
      const socket = await connectWs(wsUrl, { authorization: VERIFIED_CREDENTIAL })
      await new Promise((resolve) => socket.once('close', resolve))
      assert.equal(
        routeVerified(),
        true,
        'middleware must set the verified flag for the app upgrade route',
      )
    } finally {
      await close()
    }
  })

  it('does not set the verified flag for a non-upgrade request', async () => {
    const { httpBase, close } = await makeServer()
    try {
      const res = await fetch(`${httpBase}/probe`, {
        headers: { authorization: VERIFIED_CREDENTIAL },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { verified: boolean }
      assert.equal(body.verified, false)
    } finally {
      await close()
    }
  })

  it('closes the channel on DELETE using the persisted verified voucher, not the client body', async () => {
    settleCalls = []
    const { httpBase, close } = await makeServer()
    try {
      assert.ok(capturedStore, 'stellar mock should have captured the wrapped store')
      // Simulate the provider having verified one voucher: the record the
      // DELETE close path must settle from after any isolate eviction (#52).
      await capturedStore!.put(`kikis-app:session:voucher:${CHANNEL_CONTRACT}`, {
        amount: '1000',
        signature: 'ab'.repeat(64),
        payer: providerPayerForClose.publicKey(),
        voucherCount: 1,
      })

      const res = await fetch(`${httpBase}/stream`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        // A self-reported body smaller than the verified record must not make
        // the provider settle for less — it is ignored entirely.
        body: JSON.stringify({ amount: '100', signature: 'cd'.repeat(64) }),
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as { closeTxHash: string }
      assert.equal(body.closeTxHash, 'CLOSE_TX_HASH')
      assert.equal(settleCalls.length, 1)
      assert.equal(settleCalls[0]!.mode, 'mpp-session-ws')
    } finally {
      await close()
    }
  })

  it('throws when mpp-session-ws is enabled without commitmentPublicKey', () => {
    assert.throws(
      () =>
        kikisAppFastify({
          asset: 'USDC',
          assetContract: ASSET_CONTRACT,
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
          manifest,
          modes: ['mpp-session-ws'],
          pricing: { 'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        }),
      /commitmentPublicKey/,
    )
  })
})

describe('mppSessionWsFastifyVerified helper', () => {
  it('returns true only when the verified flag is set', () => {
    assert.equal(mppSessionWsFastifyVerified({ [MPP_SESSION_WS_VERIFIED]: true }), true)
    assert.equal(mppSessionWsFastifyVerified({}), false)
    assert.equal(mppSessionWsFastifyVerified({ [MPP_SESSION_WS_VERIFIED]: 'yes' }), false)
    assert.equal(MPP_SESSION_WS_VERIFIED, 'kikis-app.mppSessionWs.verified')
  })
})